import type { SessionBase } from "@codespar/types";
import type { Tool } from "./types.js";

// The SDK's concrete session exposes an internal tools() implementation that
// caches tool metadata fetched alongside connections. This free function
// delegates to that implementation via structural duck-typing, making it
// callable with any SessionBase that carries a compatible tools() method.
export async function tools(session: SessionBase): Promise<Tool[]> {
  const s = session as SessionBase & { tools?(): Promise<Tool[]> };
  if (typeof s.tools === "function") return s.tools();
  return [];
}

export async function findTools(session: SessionBase, query: string): Promise<Tool[]> {
  const all = await tools(session);
  const q = query.toLowerCase();
  return all.filter(
    (t: Tool) =>
      t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q),
  );
}
