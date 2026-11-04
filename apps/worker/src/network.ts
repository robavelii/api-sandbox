import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import https from "node:https";

export type Resolver = (
  hostname: string,
) => Promise<{ address: string; family: number }[]>;
export const systemResolver: Resolver = (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true });

async function resolveWithTimeout(resolver: Resolver, hostname: string) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      resolver(hostname),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Webhook DNS lookup timed out.")),
          5000,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (!version) return false;
  if (version === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
  const normalized = address.toLowerCase();
  if (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("ff") ||
    normalized.startsWith("64:ff9b:") ||
    normalized.startsWith("2001:db8:") ||
    normalized.startsWith("2002:")
  )
    return false;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPublicAddress(mapped[1]);
  const mappedHex = normalized.match(
    /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/,
  );
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1], 16),
      low = Number.parseInt(mappedHex[2], 16);
    return isPublicAddress(
      `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`,
    );
  }
  return true;
}

export async function validateWebhookUrl(
  input: string,
  resolver: Resolver = systemResolver,
): Promise<{ url: URL; addresses: { address: string; family: number }[] }> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Webhook URL is invalid.");
  }
  if (url.protocol !== "https:") throw new Error("Webhook URL must use HTTPS.");
  if (url.username || url.password || url.hash)
    throw new Error("Webhook URL cannot contain credentials or a fragment.");
  if (url.port && url.port !== "443")
    throw new Error("Webhook URL must use the default HTTPS port.");
  if (url.hostname.endsWith(".local"))
    throw new Error("Local webhook hosts are not allowed.");
  const addresses = await resolveWithTimeout(resolver, url.hostname);
  if (
    !addresses.length ||
    addresses.some((item) => !isPublicAddress(item.address))
  )
    throw new Error("Webhook host must resolve only to public addresses.");
  return { url, addresses };
}

export interface HttpResult {
  status: number;
  body: string;
  location?: string;
}
export type Sender = (
  url: URL,
  address: { address: string; family: number },
  body: string,
  headers: Record<string, string>,
) => Promise<HttpResult>;

export function createPinnedHttpsSender(
  requestFactory: typeof https.request = https.request,
  deadlineMs = 10_000,
  responseLimit = 65_536,
): Sender {
  return (url, resolved, body, headers) =>
    new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      let responseStream: import("node:http").IncomingMessage | undefined;
      let settled = false;
      const finish = (error?: Error, result?: HttpResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(result!);
      };
      const request = requestFactory(
        url,
        {
          method: "POST",
          headers: { ...headers, "content-length": Buffer.byteLength(body) },
          timeout: deadlineMs,
          servername: url.hostname,
          lookup: (_hostname, _options, callback) =>
            callback(null, resolved.address, resolved.family),
        },
        (response) => {
          responseStream = response;
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("error", (error) => finish(error));
          response.on("aborted", () =>
            finish(new Error("Webhook response aborted.")),
          );
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > responseLimit) {
              const error = new Error("Webhook response exceeds byte limit.");
              finish(error);
              response.destroy();
              request.destroy(error);
              return;
            }
            const stored = chunks.reduce(
              (total, value) => total + value.length,
              0,
            );
            if (stored < 4096) chunks.push(chunk.subarray(0, 4096 - stored));
          });
          response.on("end", () =>
            finish(undefined, {
              status: response.statusCode || 0,
              body: Buffer.concat(chunks).toString("utf8"),
              location: response.headers.location,
            }),
          );
        },
      );
      timer = setTimeout(() => {
        const error = new Error("Webhook exceeded absolute deadline.");
        finish(error);
        responseStream?.destroy();
        request.destroy(error);
      }, deadlineMs);
      request.on("timeout", () =>
        request.destroy(new Error("Webhook timed out.")),
      );
      request.on("error", (error) => finish(error));
      request.end(body);
    });
}

export const pinnedHttpsSender = createPinnedHttpsSender();

export async function safePost(
  input: string,
  body: string,
  headers: Record<string, string>,
  resolver: Resolver = systemResolver,
  sender: Sender = pinnedHttpsSender,
): Promise<HttpResult> {
  let current = input;
  for (let redirect = 0; redirect <= 3; redirect++) {
    const { url, addresses } = await validateWebhookUrl(current, resolver);
    const result = await sender(url, addresses[0], body, headers);
    if (![301, 302, 303, 307, 308].includes(result.status)) return result;
    if (!result.location) throw new Error("Webhook redirect has no location.");
    if (redirect === 3) throw new Error("Webhook exceeded redirect limit.");
    current = new URL(result.location, url).toString();
  }
  throw new Error("Webhook redirect failed.");
}
