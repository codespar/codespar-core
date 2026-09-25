# @codespar/agent-core

The primitives every CodeSpar starter-kit agent inherits (spec v5.1.1, section 4): the execution state machine, the approval artifact, the `agent.yaml` manifest, `escalate_above`, `actor`, local state in SQLite, the proof bundle, the rail contract and the two providers.

This package is the decisions. The RUNNER around them — the terminal channel, `codespar-agent start|consent|approve|deny|resume|rerun|reconcile|poll|webhook|check|eval`, the setup that wires this package to an agent directory, and the scenario and adversarial runners — is [`@codespar/agent-runtime`](../agent-runtime), which depends on this one and is what an agent's `package.json` scripts call (#13). Nothing here knows an agent's name.

## The state machine, and what the types do and do not prove

`transition(execution, to, input)` accepts only a `to` that the table in `state-machine.ts` lists for `execution.state`. On a **narrowed** value (`Execution<"drafted">`, `Execution<"executing">`, ...) a transition outside the table is a compile error, and `test/transitions.type-test.ts` keeps that true with `@ts-expect-error` lines that `tsc` refuses to leave unused. An **un-narrowed** `Execution` (the union, which is what a row read back from SQLite is) compiles for any target; the engine narrows with casts at its call sites. So the guard that always holds is the runtime one: `transition()` throws `IllegalTransitionError` on any pair the table does not list, whatever the static type said. The type test proves the table is closed; the runtime check enforces it.

## The one policy, three gates

`ExecutionEngine.policy()` runs at draft, at a human's approval and again immediately before `executing`, inside the transaction that writes the outbox row. Mandate status, allowlist, per-transaction cap, the window cap (counting settled, in flight AND awaiting executions as reservations), `escalate_above` and the artifact's `items_hash` are all re-checked at the last gate. A person's approval satisfies `escalate_above` and nothing else.

## Reconcile never re-dispatches

An execution left in `executing` is looked up on the rail, attempt by attempt. A recorded settled or failed outcome closes it; `in_flight`, `uncertain` or unknown leaves it in `executing` with `reason: rail_uncertain` for a human. The single exception is an outbox row still `pending` (the state changed, no call was ever made): those attempts go out once, under the same ids.

## Stubs

`stubs/mandate-status.ts` (the section 4.7 status source for runs without a key: revocation, pause and the organization kill switch, over the local state.db) and `stubs/rail.ts` (the sandbox rail) are stand-ins for the CI, the scenarios and `rerun`, marked as such. With a test key the engine reads the mandate status from the API instead (`api/mandate-status.ts`, `GET /v1/mandates/{id}`), fail-closed: anything but `active` refuses `executing`, and a read that does not answer is `mandate_status_unavailable`, never "assume active". The approval artifact is signed with a local development key (`approval.ts`); the API does not sign approval lists.
