/**
 * Bounds on a tool call's input, checked BEFORE the input reaches Zod.
 *
 * A tool's arguments come from the model, so their size is not ours to
 * choose. Zod validates constrained collections (`.min()`/`.max()` on arrays
 * built from `minItems`/`maxItems`) in a way that can exhaust memory on an
 * oversized input (GHSA-mrhx-c7xc-m3w5, zod < 4.6.6). The schema each tool
 * publishes stays exactly as it is; what changes is that an input larger than
 * any legitimate call is refused, with a clear error, before validation
 * starts. Nothing is truncated.
 *
 * The walk is iterative and stops at the first limit crossed, so refusing an
 * oversized input costs at most a pass over what the limit allows.
 *
 * Where it runs: the schema each LangChain tool carries is wrapped by
 * {@link boundedToolInput}, so the bounds are checked before LangChain's own
 * parse of the model's arguments; and the tool's `invoke` checks them again
 * before anything is sent, for a caller that does not parse first.
 * `jsonSchemaToZod` itself is unchanged.
 */
import { z } from "zod/v3";
import type { ToolInputSchema } from "./schema.js";

/**
 * The most entries one collection (an array, or an object's keys) may hold,
 * at any depth. The CodeSpar tools' largest legitimate lists (cart items,
 * payment splits, batch lines) are in the tens to low hundreds.
 */
export const MAX_TOOL_INPUT_COLLECTION_LENGTH = 1_000;

/** The deepest a tool input may nest. Legitimate inputs nest a handful of levels. */
export const MAX_TOOL_INPUT_DEPTH = 32;

/**
 * The most a tool input may weigh, measured as its JSON text in UTF-16 code
 * units (about bytes for ASCII). A model's whole reply is far below this;
 * tool inputs carry no files.
 */
export const MAX_TOOL_INPUT_SERIALIZED_LENGTH = 1_048_576;

export interface ToolInputBoundsViolation {
  limit: "collection_length" | "depth" | "serialized_length";
  /** Where, as a JSON path (`$.items[3].lines`). */
  path: string;
  max: number;
  message: string;
}

const segment = (key: string | number) => (typeof key === "number" ? `[${key}]` : /^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`);

/** The first limit the input crosses, or null when it fits. Never throws. */
export function toolInputBoundsViolation(input: unknown): ToolInputBoundsViolation | null {
  let weight = 0;
  const stack: Array<{ value: unknown; depth: number; path: string }> = [{ value: input, depth: 0, path: "$" }];
  const over = (limit: ToolInputBoundsViolation["limit"], path: string, max: number, what: string): ToolInputBoundsViolation => ({
    limit,
    path,
    max,
    message: `tool input refused before validation: ${what} at ${path} (the most a tool input may carry is ${max}); nothing was sent`,
  });
  while (stack.length > 0) {
    const { value, depth, path } = stack.pop()!;
    if (depth > MAX_TOOL_INPUT_DEPTH) return over("depth", path, MAX_TOOL_INPUT_DEPTH, `nesting deeper than ${MAX_TOOL_INPUT_DEPTH} levels`);
    if (typeof value === "string") weight += value.length + 2;
    else if (value === null || typeof value !== "object") weight += 24;
    else if (Array.isArray(value)) {
      if (value.length > MAX_TOOL_INPUT_COLLECTION_LENGTH) return over("collection_length", path, MAX_TOOL_INPUT_COLLECTION_LENGTH, `an array of ${value.length} entries`);
      weight += 2 + value.length;
      for (let i = value.length - 1; i >= 0; i--) stack.push({ value: value[i], depth: depth + 1, path: path + segment(i) });
    } else {
      const keys = Object.keys(value);
      if (keys.length > MAX_TOOL_INPUT_COLLECTION_LENGTH) return over("collection_length", path, MAX_TOOL_INPUT_COLLECTION_LENGTH, `an object of ${keys.length} keys`);
      weight += 2 + keys.length;
      for (let i = keys.length - 1; i >= 0; i--) {
        const k = keys[i]!;
        weight += k.length + 3;
        stack.push({ value: (value as Record<string, unknown>)[k], depth: depth + 1, path: path + segment(k) });
      }
    }
    if (weight > MAX_TOOL_INPUT_SERIALIZED_LENGTH) return over("serialized_length", path, MAX_TOOL_INPUT_SERIALIZED_LENGTH, `more than ${MAX_TOOL_INPUT_SERIALIZED_LENGTH} characters of JSON`);
  }
  return null;
}

/** Thrown by a tool's `invoke` when its input is past the bounds: nothing was sent. */
export class ToolInputTooLargeError extends Error {
  readonly code = "tool_input_too_large" as const;
  constructor(readonly violation: ToolInputBoundsViolation) {
    super(violation.message);
    Object.setPrototypeOf(this, ToolInputTooLargeError.prototype);
    this.name = "ToolInputTooLargeError";
  }
}

/**
 * The tool's input schema with the bounds checked first: an input past them
 * gets one fatal issue (`code: "custom"`, `params.limit`), and the schema
 * under it never parses it. An input within them parses exactly as before.
 */
export function boundedToolInput(schema: ToolInputSchema): ToolInputSchema {
  return z.preprocess((raw, issues) => {
    const over = toolInputBoundsViolation(raw);
    if (over) issues.addIssue({ code: z.ZodIssueCode.custom, message: over.message, params: { limit: over.limit, max: over.max, at: over.path }, fatal: true });
    return raw;
  }, schema) as unknown as ToolInputSchema;
}
