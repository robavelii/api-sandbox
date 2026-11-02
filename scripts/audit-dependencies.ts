import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";

type Finding = { severity: string; via?: unknown[] };
type Exception = {
  maximumSeverity: "high" | "critical";
  expires: string;
  reason: string;
};

const severity = { low: 1, moderate: 2, high: 3, critical: 4 } as const;
const result = spawnSync(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["audit", "--json", "--omit=dev"],
  { encoding: "utf8" },
);
if (!result.stdout)
  throw new Error(result.stderr || "npm audit returned no JSON");
const audit = JSON.parse(result.stdout);
const exceptions = JSON.parse(
  await readFile(".github/audit-allowlist.json", "utf8"),
) as Record<string, Exception>;
const now = new Date();
const blocked: string[] = [];
const accepted: string[] = [];

for (const [name, finding] of Object.entries<Finding>(
  audit.vulnerabilities || {},
)) {
  if (
    (severity[finding.severity as keyof typeof severity] || 0) < severity.high
  )
    continue;
  const exception = exceptions[name];
  if (
    !exception ||
    new Date(`${exception.expires}T23:59:59Z`) < now ||
    severity[finding.severity as keyof typeof severity] >
      severity[exception.maximumSeverity]
  ) {
    blocked.push(`${name}: ${finding.severity}`);
  } else {
    accepted.push(
      `${name}: ${finding.severity}, accepted until ${exception.expires} — ${exception.reason}`,
    );
  }
}

await mkdir("reports", { recursive: true });
await writeFile(
  "reports/production-audit.json",
  JSON.stringify(audit, null, 2),
);
await writeFile(
  "reports/production-audit.md",
  [
    "# Production dependency audit",
    "",
    ...(accepted.length
      ? ["## Dated exceptions", "", ...accepted.map((line) => `- ${line}`)]
      : ["No high or critical exceptions."]),
    "",
    ...(blocked.length
      ? ["## Blocking findings", "", ...blocked.map((line) => `- ${line}`)]
      : ["No unaccepted high or critical findings."]),
    "",
  ].join("\n"),
);

if (blocked.length) {
  throw new Error(
    `Unaccepted production vulnerabilities: ${blocked.join(", ")}`,
  );
}
console.log(
  accepted.length
    ? `Dependency audit passed with ${accepted.length} dated exception(s).`
    : "Dependency audit passed without high or critical findings.",
);
