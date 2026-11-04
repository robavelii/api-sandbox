import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";

const service = process.argv[2];
if (service !== "api" && service !== "web") {
  throw new Error("Expected api or web server mode.");
}

mkdirSync("artifacts/server-logs", { recursive: true });
const log = createWriteStream(`artifacts/server-logs/${service}.log`, {
  flags: "a",
});
const child =
  service === "api"
    ? spawn(process.execPath, ["--import", "tsx", "apps/api/src/main.ts"], {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      })
    : spawn(
        process.execPath,
        [
          "node_modules/next/dist/bin/next",
          "dev",
          "--webpack",
          "apps/web",
          "--hostname",
          "127.0.0.1",
          "--port",
          "3100",
        ],
        {
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

for (const stream of [child.stdout, child.stderr]) {
  stream.on("data", (chunk) => {
    process.stdout.write(chunk);
    log.write(chunk);
  });
}

const stop = () => child.kill("SIGTERM");
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  log.end();
  process.exit(signal ? 0 : (code ?? 1));
});
