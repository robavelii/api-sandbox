import { createHash } from "node:crypto";
import type { Schema } from "./index.js";

const limits = {
  nodes: 1_000,
  depth: 20,
  objectKeys: 200,
  properties: 100,
  required: 100,
  alternatives: 20,
  enumValues: 100,
  minItems: 20,
  maxItems: 100,
  minLength: 1_024,
  maxLength: 4_096,
} as const;

const dangerousKeys = new Set(["__proto__", "prototype", "constructor"]);

function pointer(root: Schema, reference: string): unknown {
  if (!reference.startsWith("#/"))
    throw new Error("Only local schema references are supported.");
  return reference
    .slice(2)
    .split("/")
    .reduce(
      (value: any, key) => value?.[key.replace(/~1/g, "/").replace(/~0/g, "~")],
      root,
    );
}

/**
 * Rejects schema features that can consume unbounded CPU in the request path.
 * Keep this policy deliberately smaller than JSON Schema until validation can
 * run in a separately limited process.
 */
export function assertSafeSchema(root: Schema): void {
  let nodes = 0;
  const references: string[] = [];
  const seen = new WeakSet<object>();

  function visit(value: unknown, depth: number): void {
    if (depth > limits.depth)
      throw new Error(`Schema exceeds the maximum depth of ${limits.depth}.`);
    if (value === null || typeof value !== "object") return;
    if (seen.has(value))
      throw new Error("Cyclic in-memory schema objects are not supported.");
    seen.add(value);
    if (++nodes > limits.nodes)
      throw new Error(
        `Schema exceeds the maximum size of ${limits.nodes} nodes.`,
      );
    if (Array.isArray(value)) {
      if (value.length > limits.objectKeys)
        throw new Error("Schema array contains too many entries.");
      for (const entry of value) visit(entry, depth + 1);
      return;
    }

    const schema = value as Schema;
    const keys = Object.keys(schema);
    if (keys.length > limits.objectKeys)
      throw new Error("Schema object contains too many keys.");
    if (keys.some((key) => dangerousKeys.has(key)))
      throw new Error("Schema contains a reserved object key.");
    if ("pattern" in schema || "patternProperties" in schema)
      throw new Error(
        "Regular-expression schema keywords are not supported in sandboxes.",
      );
    if (schema.$ref !== undefined) {
      if (typeof schema.$ref !== "string")
        throw new Error("Schema references must be strings.");
      references.push(schema.$ref);
    }

    const properties = schema.properties;
    if (properties && typeof properties === "object") {
      const propertyNames = Object.keys(properties);
      if (propertyNames.length > limits.properties)
        throw new Error(
          `Schema objects support at most ${limits.properties} properties.`,
        );
      if (propertyNames.some((key) => dangerousKeys.has(key)))
        throw new Error("Schema contains a reserved property name.");
    }
    if (
      Array.isArray(schema.required) &&
      schema.required.length > limits.required
    )
      throw new Error(
        `Schema objects support at most ${limits.required} required properties.`,
      );
    for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
      if (
        Array.isArray(schema[keyword]) &&
        schema[keyword].length > limits.alternatives
      )
        throw new Error(
          `${keyword} supports at most ${limits.alternatives} alternatives.`,
        );
    }
    if (Array.isArray(schema.enum) && schema.enum.length > limits.enumValues)
      throw new Error(
        `Schema enums support at most ${limits.enumValues} values.`,
      );
    if (Number(schema.minItems || 0) > limits.minItems)
      throw new Error(`minItems cannot exceed ${limits.minItems}.`);
    if (Number(schema.maxItems || 0) > limits.maxItems)
      throw new Error(`maxItems cannot exceed ${limits.maxItems}.`);
    if (Number(schema.minLength || 0) > limits.minLength)
      throw new Error(`minLength cannot exceed ${limits.minLength}.`);
    if (Number(schema.maxLength || 0) > limits.maxLength)
      throw new Error(`maxLength cannot exceed ${limits.maxLength}.`);

    for (const child of Object.values(schema)) visit(child, depth + 1);
  }

  visit(root, 0);

  const graph = new Map<string, Set<string>>();
  for (const reference of new Set(references)) {
    const target = pointer(root, reference);
    if (!target || typeof target !== "object")
      throw new Error(`Unresolved schema reference: ${reference}`);
    const adjacent = new Set<string>();
    const stack: unknown[] = [target];
    const visited = new WeakSet<object>();
    while (stack.length) {
      const current = stack.pop();
      if (!current || typeof current !== "object" || visited.has(current))
        continue;
      visited.add(current);
      if (Array.isArray(current)) stack.push(...current);
      else {
        const nested = (current as Schema).$ref;
        if (typeof nested === "string") adjacent.add(nested);
        stack.push(...Object.values(current));
      }
    }
    graph.set(reference, adjacent);
  }

  const visiting = new Set<string>();
  const complete = new Set<string>();
  function checkCycles(reference: string): void {
    if (visiting.has(reference))
      throw new Error("Recursive schema references are not supported.");
    if (complete.has(reference)) return;
    visiting.add(reference);
    for (const adjacent of graph.get(reference) || []) {
      if (!graph.has(adjacent)) {
        const target = pointer(root, adjacent);
        if (!target || typeof target !== "object")
          throw new Error(`Unresolved schema reference: ${adjacent}`);
      }
      checkCycles(adjacent);
    }
    visiting.delete(reference);
    complete.add(reference);
  }
  for (const reference of graph.keys()) checkCycles(reference);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as any)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export function schemaKey(schema: Schema): string {
  return createHash("sha256").update(canonical(schema)).digest("hex");
}
