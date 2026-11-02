import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import { parseDocument } from "yaml";
import { assertSafeSchema, schemaKey } from "./schema-safety.js";
export type Behavior =
  | "create"
  | "list"
  | "retrieve"
  | "update"
  | "replace"
  | "delete"
  | "unconfigured";
export type Schema = Record<string, any>;
export interface Operation {
  id: string;
  method: string;
  path: string;
  resource: string;
  behavior: Behavior;
  provenance: "inferred";
  request?: Schema;
  requestRequired: boolean;
  response?: Schema;
  status: number;
}
export interface Contract {
  version: 1;
  title: string;
  openapi: string;
  operations: Operation[];
  warnings: string[];
}
export const scenarios = ["success", "error", "rate_limit", "delay"] as const;
export type Scenario = (typeof scenarios)[number];
export function parseContract(source: string): Contract {
  if (Buffer.byteLength(source) > 1_048_576)
    throw new Error("Specification exceeds 1 MB.");
  const doc = parseDocument(source, { uniqueKeys: true });
  if (doc.errors.length) throw new Error(doc.errors[0].message);
  return compile(doc.toJS({ maxAliasCount: 20 }));
}
const ajv = new Ajv2020({
  strict: false,
  allErrors: true,
  validateFormats: false,
  loopEnum: 100,
  loopRequired: 100,
});
const validators = new Map<string, ValidateFunction>();
const validatorLimit = 256;

function validatorFor(schema: Schema): ValidateFunction {
  assertSafeSchema(schema);
  const key = schemaKey(schema);
  const cached = validators.get(key);
  if (cached) {
    validators.delete(key);
    validators.set(key, cached);
    return cached;
  }
  const compiled = ajv.compile(schema);
  validators.set(key, compiled);
  if (validators.size > validatorLimit)
    validators.delete(validators.keys().next().value!);
  return compiled;
}

function schemaFor(schema: Schema | undefined, spec: any): Schema | undefined {
  if (!schema) return undefined;
  const root = { ...schema, components: spec.components || {} };
  // Compilation rejects unresolved/external references; no network resolution is performed.
  validatorFor(root);
  return root;
}
export function compile(spec: any): Contract {
  if (
    !/^3\.(0|1)\.\d+$/.test(spec?.openapi || "") ||
    !spec.paths ||
    Array.isArray(spec.paths)
  )
    throw new Error("Use an OpenAPI 3.0.x or 3.1.x document with paths.");
  const operations: Operation[] = [],
    warnings: string[] = [
      "CRUD mappings are inferred and must be approved before activation.",
      "Parameter serialization, security schemes, callbacks, and response generation beyond resource persistence are not implemented.",
    ];
  for (const [path, item] of Object.entries<any>(spec.paths)) {
    if (!/^\/[A-Za-z0-9_{}./-]*$/.test(path) || !item)
      throw new Error(`Unsupported path: ${path}`);
    for (const method of ["get", "post", "patch", "put", "delete"]) {
      const op = item[method];
      if (!op) continue;
      const parts = path.split("/").filter(Boolean);
      let behavior: Behavior = "unconfigured";
      if (parts.length === 1 && !parts[0].includes("{"))
        behavior =
          method === "post"
            ? "create"
            : method === "get"
              ? "list"
              : "unconfigured";
      if (parts.length === 2 && /^\{[\w-]+\}$/.test(parts[1]))
        behavior =
          (
            {
              get: "retrieve",
              patch: "update",
              put: "replace",
              delete: "delete",
            } as Record<string, Behavior>
          )[method] || "unconfigured";
      const success = Object.keys(op.responses || {}).find((s) =>
        /^2\d\d$/.test(s),
      );
      if (!success)
        throw new Error(
          `${method.toUpperCase()} ${path} needs a declared 2xx response.`,
        );
      if (behavior === "unconfigured")
        warnings.push(
          `${method.toUpperCase()} ${path}: configure a custom action in a later release; this operation returns 501.`,
        );
      operations.push({
        id: `${method.toUpperCase()} ${path}`,
        method: method.toUpperCase(),
        path,
        resource: parts[0],
        behavior,
        provenance: "inferred",
        status: Number(success),
        requestRequired: !!op.requestBody?.required,
        request: schemaFor(
          op.requestBody?.content?.["application/json"]?.schema,
          spec,
        ),
        response: schemaFor(
          op.responses[success]?.content?.["application/json"]?.schema,
          spec,
        ),
      });
    }
  }
  if (!operations.length) throw new Error("No supported operations.");
  // Prefer literal paths over parameter paths independent of input ordering.
  operations.sort(
    (a, b) => a.path.split("{").length - b.path.split("{").length,
  );
  return {
    version: 1,
    title: String(spec.info?.title || "Untitled API").slice(0, 120),
    openapi: spec.openapi,
    operations,
    warnings,
  };
}
export function match(
  contract: Contract,
  method: string,
  path: string,
): Operation | undefined {
  return contract.operations.find(
    (op) =>
      op.method === method &&
      op.path.split("/").length === path.split("/").length &&
      op.path
        .split("/")
        .every((s, i) =>
          /^\{[\w-]+\}$/.test(s)
            ? !!path.split("/")[i]
            : s === path.split("/")[i],
        ),
  );
}
export function validate(
  schema: Schema | undefined,
  value: unknown,
): string | null {
  if (!schema) return null;
  const check = validatorFor(schema);
  return check(value) ? null : ajv.errorsText(check.errors);
}
export function deterministicId(resource: string, counter: number): string {
  return `${resource.replace(/s$/, "").slice(0, 3)}_${String(counter).padStart(6, "0")}`;
}
