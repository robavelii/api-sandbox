import { readdir, readFile } from "node:fs/promises";
import { parseDocument } from "yaml";

const errors: string[] = [];
for (const name of (await readdir(".github/workflows")).filter((file) =>
  /\.ya?ml$/.test(file),
)) {
  const source = await readFile(`.github/workflows/${name}`, "utf8");
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length) {
    errors.push(
      `${name}: ${document.errors.map((error) => error.message).join("; ")}`,
    );
    continue;
  }
  const workflow = document.toJS() as any;
  if (workflow.on?.pull_request_target)
    errors.push(`${name}: pull_request_target is prohibited`);
  if (workflow.permissions?.contents !== "read")
    errors.push(`${name}: top-level contents permission must be read-only`);
  if (
    !workflow.concurrency?.group ||
    !workflow.concurrency?.["cancel-in-progress"]
  )
    errors.push(`${name}: concurrency cancellation is required`);
  for (const [jobName, job] of Object.entries<any>(workflow.jobs || {})) {
    if (!Number.isInteger(job["timeout-minutes"]))
      errors.push(`${name}/${jobName}: timeout-minutes is required`);
    for (const step of job.steps || []) {
      if (step.uses && !/^[^@]+@[0-9a-f]{40}$/.test(step.uses))
        errors.push(
          `${name}/${jobName}: action must be pinned to a full SHA: ${step.uses}`,
        );
    }
  }
}
if (errors.length)
  throw new Error(`Workflow validation failed:\n${errors.join("\n")}`);
console.log(
  "Workflow structure, permissions, timeouts, cancellation, and action pins are valid.",
);
