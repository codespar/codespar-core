/**
 * `tools.json`: the closed list of tools the model may call. Tool-level
 * authority comes before mandate-level authority: a tool that is not in
 * this file is refused before anything else looks at the call.
 *
 * Two kinds. `meta_tools` are CodeSpar meta-tool names, with the input the
 * kit accepts for them (a snapshot of the MCP shape, pinned by `mcp` in the
 * manifest; see OPEN_QUESTIONS on why the list is not fetched live).
 * `local_tools` are the agent's own read-only helpers.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { ToolSpec } from "./providers/types.js";

const ToolDefinitionSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_]*$/),
    description: z.string().min(1),
    input_schema: z.record(z.string(), z.unknown()),
    /** `payment` and `charge` tools create a `drafted` execution and nothing else; `read` tools never touch money. `charge` is the receivable side: the counterparty pays us. */
    effect: z.enum(["payment", "charge", "read"]),
  })
  .strict();

export const ToolsFileSchema = z
  .object({
    meta_tools: z.array(ToolDefinitionSchema),
    local_tools: z.array(ToolDefinitionSchema),
  })
  .strict()
  .superRefine((t, ctx) => {
    const names = new Set<string>();
    for (const tool of [...t.meta_tools, ...t.local_tools]) {
      if (names.has(tool.name)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate tool ${tool.name}` });
      names.add(tool.name);
    }
    for (const [i, tool] of t.meta_tools.entries()) {
      if (!tool.name.startsWith("codespar_")) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["meta_tools", i, "name"], message: "meta-tools are named codespar_*" });
    }
  });

export type ToolsFile = z.infer<typeof ToolsFileSchema>;
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

export function loadToolsFile(path: string): ToolsFile {
  return ToolsFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function toolSpecs(tools: ToolsFile): ToolSpec[] {
  return [...tools.meta_tools, ...tools.local_tools].map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
}

export function allowedToolNames(tools: ToolsFile): Set<string> {
  return new Set([...tools.meta_tools, ...tools.local_tools].map((t) => t.name));
}
