import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";

function key(value = process.env.WEBHOOK_ENCRYPTION_KEY): Buffer {
  if (!value) throw new Error("WEBHOOK_ENCRYPTION_KEY is required.");
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32)
    throw new Error(
      "WEBHOOK_ENCRYPTION_KEY must be 32 bytes encoded as base64.",
    );
  return decoded;
}

export function encryptSecret(secret: string, configuredKey?: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(configuredKey), nonce);
  const encrypted = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    nonce.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

export function decryptSecret(value: string, configuredKey?: string): string {
  const [version, nonce, tag, encrypted] = value.split(".");
  if (version !== "v1" || !nonce || !tag || !encrypted)
    throw new Error("Unsupported webhook secret ciphertext.");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key(configuredKey),
    Buffer.from(nonce, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function signWebhook(secret: string, timestamp: string, body: string) {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
}
