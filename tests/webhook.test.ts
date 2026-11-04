import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type https from "node:https";
import {
  decryptSecret,
  encryptSecret,
  signWebhook,
} from "../packages/engine/src/webhook-crypto.js";
import {
  isPublicAddress,
  safePost,
  validateWebhookUrl,
  createPinnedHttpsSender,
} from "../apps/worker/src/network.js";

test("HTTPS sender bounds trickling responses, bytes and response failures", async () => {
  let mode = "success";
  let response: EventEmitter & { destroy: () => void };
  let destroyed = false;
  const factory = ((
    _url: URL,
    options: any,
    callback: (value: any) => void,
  ) => {
    const request = new EventEmitter() as any;
    request.destroy = (error: Error) => {
      destroyed = true;
      request.emit("error", error);
    };
    response = Object.assign(new EventEmitter(), {
      statusCode: 200,
      headers: {},
      destroy: () => {
        destroyed = true;
      },
    });
    request.end = () =>
      queueMicrotask(() => {
        options.lookup("test", {}, (error: unknown, address: string) => {
          assert.equal(error, null);
          assert.equal(address, "8.8.8.8");
        });
        callback(response);
        if (mode === "trickle") {
          response.emit("data", Buffer.from("x"));
          return;
        }
        if (mode === "error") {
          response.emit("error", new Error("response failure"));
          return;
        }
        if (mode === "aborted") {
          response.emit("aborted");
          return;
        }
        response.emit(
          "data",
          Buffer.alloc(mode === "large" ? 70000 : 5000, 97),
        );
        response.emit("end");
      });
    return request;
  }) as unknown as typeof https.request;
  const sender = createPinnedHttpsSender(factory, 20);
  const send = () =>
    sender(
      new URL("https://public.example"),
      { address: "8.8.8.8", family: 4 },
      "{}",
      {},
    );
  assert.equal((await send()).body.length, 4096);
  mode = "large";
  await assert.rejects(send, /byte limit/);
  assert.equal(destroyed, true);
  mode = "error";
  await assert.rejects(send, /response failure/);
  mode = "aborted";
  await assert.rejects(send, /aborted/);
  mode = "trickle";
  await assert.rejects(send, /absolute deadline/);
});

test("webhook secrets are authenticated and signatures are stable", () => {
  const key = Buffer.alloc(32, 4).toString("base64");
  const encrypted = encryptSecret("whsec_test", key);
  assert.equal(decryptSecret(encrypted, key), "whsec_test");
  const tampered = encrypted.split(".");
  tampered[3] = `${tampered[3][0] === "A" ? "B" : "A"}${tampered[3].slice(1)}`;
  assert.throws(() => decryptSecret(tampered.join("."), key));
  assert.equal(
    signWebhook("secret", "2026-01-01T00:00:00Z", "{}"),
    signWebhook("secret", "2026-01-01T00:00:00Z", "{}"),
  );
});

test("SSRF checks reject local and private address ranges", async () => {
  for (const address of [
    "127.0.0.1",
    "10.1.2.3",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "100.64.0.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "198.51.100.1",
    "203.0.113.1",
    "2001:db8::1",
  ])
    assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress("8.8.8.8"), true);
  await assert.rejects(
    () =>
      validateWebhookUrl("https://internal.example/hook", async () => [
        { address: "10.0.0.2", family: 4 },
      ]),
    /public addresses/,
  );
  await assert.rejects(
    () =>
      validateWebhookUrl("http://example.com/hook", async () => [
        { address: "8.8.8.8", family: 4 },
      ]),
    /HTTPS/,
  );
});

test("redirects are resolved and validated again before delivery", async () => {
  const lookedUp: string[] = [];
  const resolver = async (host: string) => {
    lookedUp.push(host);
    return [
      {
        address: host === "public.example" ? "8.8.8.8" : "127.0.0.1",
        family: 4,
      },
    ];
  };
  let calls = 0;
  await assert.rejects(
    () =>
      safePost(
        "https://public.example/hook",
        "{}",
        {},
        resolver,
        async (_url, address) => {
          calls++;
          assert.equal(address.address, "8.8.8.8");
          return {
            status: 307,
            body: "",
            location: "https://private.example/hook",
          };
        },
      ),
    /public addresses/,
  );
  assert.deepEqual(lookedUp, ["public.example", "private.example"]);
  assert.equal(calls, 1);
});
