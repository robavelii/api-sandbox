import { Ajv2020 } from "ajv/dist/2020.js";
import { createHash } from "node:crypto";
import type { Contract, Schema } from "./index.js";
export interface Rule {
  operation: string;
  times?: number;
  delayMs?: number;
  action?: {
    type: "transition";
    field: string;
    from: string[];
    to: string;
    emit?: string;
    deliverAfterMs?: number;
  };
  failure?: { phase: "before" | "after"; status: 429 | 500 | 503 };
}
export interface Definition {
  version: 1;
  name: string;
  seed: string;
  clock: string;
  idempotency: "off" | "replay" | "conflict";
  rules: Rule[];
}
export const defaultDefinition = (): Definition => ({
  version: 1,
  name: "Default behavior",
  seed: "spectwin",
  clock: "2026-01-01T00:00:00.000Z",
  idempotency: "replay",
  rules: [],
});
const schema = {
  type: "object",
  additionalProperties: false,
  required: ["version", "name", "seed", "clock", "idempotency", "rules"],
  properties: {
    version: {
      const: 1,
    },
    name: {
      type: "string",
      minLength: 1,
      maxLength: 100,
    },
    seed: {
      type: "string",
      minLength: 1,
      maxLength: 100,
    },
    clock: {
      type: "string",
      maxLength: 30,
    },
    idempotency: {
      enum: ["off", "replay", "conflict"],
    },
    rules: {
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["operation"],
        properties: {
          operation: {
            type: "string",
            maxLength: 300,
          },
          times: {
            type: "integer",
            minimum: 1,
            maximum: 10000,
          },
          delayMs: {
            type: "integer",
            minimum: 0,
            maximum: 5000,
          },
          action: {
            type: "object",
            additionalProperties: false,
            required: ["type", "field", "from", "to"],
            properties: {
              type: {
                const: "transition",
              },
              field: {
                type: "string",
                pattern: "^[a-zA-Z][a-zA-Z0-9_]{0,63}$",
              },
              from: {
                type: "array",
                minItems: 1,
                maxItems: 30,
                uniqueItems: true,
                items: {
                  type: "string",
                  maxLength: 100,
                },
              },
              to: {
                type: "string",
                maxLength: 100,
              },
              emit: {
                type: "string",
                pattern: "^[a-z][a-z0-9_.-]{0,99}$",
              },
              deliverAfterMs: {
                type: "integer",
                minimum: 0,
                maximum: 86400000,
              },
            },
          },
          failure: {
            type: "object",
            additionalProperties: false,
            required: ["phase", "status"],
            properties: {
              phase: {
                enum: ["before", "after"],
              },
              status: {
                enum: [429, 500, 503],
              },
            },
          },
        },
      },
    },
  },
};
const validator = new Ajv2020({ allErrors: true }).compile(schema);
export function definition(input: unknown, contract: Contract): Definition {
  if (!validator(input))
    throw new Error(
      "Invalid scenario definition: " + JSON.stringify(validator.errors),
    );
  const value = input as unknown as Definition;
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value.clock) ||
    !Number.isFinite(Date.parse(value.clock))
  )
    throw new Error("Clock must be an ISO UTC timestamp.");
  for (const rule of value.rules) {
    const op = contract.operations.find((o) => o.id === rule.operation);
    if (!op) throw new Error(`Unknown operation: ${rule.operation}`);
    if (rule.action) {
      if (
        !["POST", "PATCH", "PUT"].includes(op.method) ||
        !/^\/[^{}]+\/\{[\w-]+\}(?:\/[^{}]+)?$/.test(op.path)
      )
        throw new Error(
          "Transitions require a declared item or item-action operation.",
        );
      if (
        ["constructor", "prototype", "__proto__", "id"].includes(
          rule.action.field,
        )
      )
        throw new Error("Reserved transition field.");
      const prop = resolve(op.response, op.response)?.properties?.[
        rule.action.field
      ];
      if (prop?.enum && !prop.enum.includes(rule.action.to))
        throw new Error("Transition target is outside the response enum.");
    }
    if (
      rule.failure?.phase === "after" &&
      !rule.action &&
      !["create", "update", "replace", "delete"].includes(op.behavior)
    )
      throw new Error("After-mutation failures require a mutation operation.");
  }
  return structuredClone(value);
}
export function selectRule(
  value: Definition,
  operation: string,
  counts: Record<string, number>,
): { rule: Rule; index: number } | undefined {
  const index = value.rules.findIndex(
    (r, i) =>
      r.operation === operation &&
      (r.times === undefined || (counts[String(i)] || 0) < r.times),
  );
  return index < 0 ? undefined : { rule: value.rules[index], index };
}
export function canonical(value: any): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
}
export const fingerprint = (value: any) =>
  createHash("sha256").update(canonical(value)).digest("hex");
function resolve(
  schema: Schema | undefined,
  root: Schema | undefined,
): Schema | undefined {
  if (!schema?.$ref) return schema;
  if (!schema.$ref.startsWith("#/"))
    throw new Error("Only local schema references are supported.");
  return schema.$ref
    .slice(2)
    .split("/")
    .reduce(
      (v: any, key: string) => v?.[key.replace(/~1/g, "/").replace(/~0/g, "~")],
      root,
    );
}
/** Bounded generator. Unsupported constraints are caught by response validation before mutation. */
export function generate(
  schema: Schema | undefined,
  seed: string,
  clock: string,
  root: Schema | undefined = schema,
  depth = 0,
): any {
  if (!schema) return {};
  if (depth > 8) throw new Error("Schema generation exceeds nesting limit.");
  const resolved = resolve(schema, root);
  if (!resolved) throw new Error("Unresolved generation schema.");
  if (resolved !== schema)
    return generate(resolved, seed, clock, root, depth + 1);
  if (schema.const !== undefined) return structuredClone(schema.const);
  if (schema.default !== undefined) return structuredClone(schema.default);
  if (schema.example !== undefined) return structuredClone(schema.example);
  const n = Number.parseInt(fingerprint(seed).slice(0, 8), 16);
  if (schema.enum?.length)
    return structuredClone(schema.enum[n % schema.enum.length]);
  if (schema.oneOf || schema.anyOf)
    return generate(
      (schema.oneOf || schema.anyOf)[0],
      seed,
      clock,
      root,
      depth + 1,
    );
  if (schema.allOf) {
    return schema.allOf.reduce(
      (acc: any, s: Schema) => ({
        ...acc,
        ...generate(s, seed, clock, root, depth + 1),
      }),
      {},
    );
  }
  const type = Array.isArray(schema.type)
    ? schema.type.find((t: string) => t !== "null")
    : schema.type;
  if (type === "object" || schema.properties) {
    const value: Record<string, any> = {};
    for (const [key, prop] of Object.entries<Schema>(schema.properties || {})) {
      if (["__proto__", "constructor", "prototype"].includes(key)) continue;
      value[key] = generate(prop, seed + "." + key, clock, root, depth + 1);
    }
    return value;
  }
  if (type === "array") {
    const size = Math.max(0, schema.minItems || 0);
    if (size > 20) throw new Error("Generated arrays are limited to 20 items.");
    return Array.from({ length: size }, (_, i) =>
      generate(schema.items, seed + "." + i, clock, root, depth + 1),
    );
  }
  if (type === "integer" || type === "number") {
    const min =
        schema.minimum ??
        (schema.exclusiveMinimum !== undefined
          ? schema.exclusiveMinimum + 1
          : 0),
      max = schema.maximum ?? min + 100;
    return Math.min(max, min + (n % 101));
  }
  if (type === "boolean") return n % 2 === 0;
  if (type === "null") return null;
  if (schema.format === "date-time") return new Date(clock).toISOString();
  if (schema.format === "date")
    return new Date(clock).toISOString().slice(0, 10);
  if (schema.format === "uuid") {
    const h = fingerprint(seed);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
  }
  let value = `sample_${fingerprint(seed).slice(0, 8)}`;
  if ((schema.minLength || 0) > 1024)
    throw new Error("Generated strings are limited to 1024 characters.");
  value = value.padEnd(schema.minLength || 0, "x");
  if (schema.maxLength !== undefined) value = value.slice(0, schema.maxLength);
  return value;
}
