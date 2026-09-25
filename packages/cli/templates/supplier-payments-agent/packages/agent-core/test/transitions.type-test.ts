/**
 * Section 15: "a transition outside section 4.1 does not compile". This
 * file is compiled by `npm run typecheck`; every `@ts-expect-error` below
 * is a transition the table forbids. If one of them ever compiles, tsc
 * reports an unused directive and the check fails.
 */
import { transition, type Execution } from "../src/state-machine.js";
import type { Actor } from "../src/types.js";

declare const actor: Actor;
declare const at: string;
declare const drafted: Execution<"drafted">;
declare const awaiting: Execution<"awaiting_approval">;
declare const approved: Execution<"approved">;
declare const executing: Execution<"executing">;
declare const settled: Execution<"settled">;
declare const failed: Execution<"failed">;
declare const denied: Execution<"denied">;
declare const expired: Execution<"expired">;

// Allowed, for contrast.
transition(drafted, "awaiting_approval", { at, actor });
transition(drafted, "approved", { at, actor });
transition(drafted, "denied", { at, actor });
transition(awaiting, "approved", { at, actor });
transition(approved, "executing", { at, actor });
transition(approved, "awaiting_approval", { at, actor });
transition(executing, "settled", { at, actor });
transition(executing, "failed", { at, actor });

// The model cannot skip the core: nothing goes straight to executing.
// @ts-expect-error drafted -> executing is not in the table
transition(drafted, "executing", { at, actor });
// @ts-expect-error awaiting_approval -> executing is not in the table
transition(awaiting, "executing", { at, actor });
// @ts-expect-error drafted -> settled is not in the table
transition(drafted, "settled", { at, actor });
// @ts-expect-error awaiting_approval -> settled is not in the table
transition(awaiting, "settled", { at, actor });

// Executing closes only by the rail's event.
// @ts-expect-error executing -> denied is not in the table
transition(executing, "denied", { at, actor });
// @ts-expect-error executing -> expired is not in the table
transition(executing, "expired", { at, actor });
// @ts-expect-error executing -> approved is not in the table
transition(executing, "approved", { at, actor });

// Terminal states have no exits. Repeating does not reopen.
// @ts-expect-error settled is terminal
transition(settled, "executing", { at, actor });
// @ts-expect-error failed is terminal
transition(failed, "executing", { at, actor });
// @ts-expect-error denied is terminal
transition(denied, "approved", { at, actor });
// @ts-expect-error expired is terminal
transition(expired, "awaiting_approval", { at, actor });
// @ts-expect-error settled is terminal
transition(settled, "settled", { at, actor });
