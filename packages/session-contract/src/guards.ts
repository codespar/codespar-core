import type { SessionBase, Session } from "./types.js";

export function isCodesparSession(s: SessionBase): s is Session {
  return "proxyExecute" in s && "authorize" in s;
}
