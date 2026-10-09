/**
 * #50: a rail failure carries the API's own code and message, verbatim, out
 * of the engine — not only `rail_failed`. Both answers are real ones the
 * deployed API gave the kits on production test mode: the 409
 * `insufficient_funds` of an unfunded wallet (ent#1803) and the 5xx
 * `provider_error` of a charge with no receiving identity (ent#1809). They go
 * through the real SDK client against a local server, so the code and the
 * message are the ones the SDK hands the rail, not ones a fake invents.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CodeSparRail } from "../src/api/rail.js";
import { createCodeSparClient } from "../src/api/client.js";
import { railErrorOf } from "../src/engine.js";
import { harness } from "./helpers.js";

const INSUFFICIENT = { status: 409, body: { error: { code: "insufficient_funds", message: "wallet cannot reserve the requested amount" }, request_id: null } };
const PROVIDER = {
  status: 502,
  body: { error: { code: "provider_error", message: "charge_boleto_brl_celcoin_v1: no receiving identity at the provider for this consumer" }, request_id: null },
};

let server: Server;
let baseUrl: string;
let answer: { status: number; body: unknown } = INSUFFICIENT;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(answer.status, { "content-type": "application/json" });
    res.end(JSON.stringify(answer.body));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((ok) => server.close(() => ok()));
});

async function spend() {
  // Not the placeholder, which the guard refuses (#50); the underscore keeps it below the secret scan's key shape.
  const h = harness({ mode: "human", wrapRail: () => new CodeSparRail(createCodeSparClient({ apiKey: "csk_test_unit_0000", baseUrl, timeoutMs: 5_000 })) });
  const d = await h.engine.draft({ items: [{ payee: "escola", amount: 185000 }] });
  if (!d.ok) throw new Error("refused");
  return h.engine.execute(h.engine.approve(d.execution.id, { id: "usr_demo", channel: "terminal" }).id);
}

describe("the rail's answer, verbatim", () => {
  it("a 409 insufficient_funds closes the execution failed, and says so in the API's words", async () => {
    answer = INSUFFICIENT;
    const out = await spend();
    expect(out.state).toBe("failed");
    expect(out.reason).toBe("rail_failed");
    expect(railErrorOf(out)).toEqual({ outcome: "failed", attempt_id: out.outcomes[0]!.attempt_id, code: "insufficient_funds", message: "wallet cannot reserve the requested amount" });
  });

  it("a 5xx provider_error leaves the attempt unknown, and still carries what the API said", async () => {
    answer = PROVIDER;
    const out = await spend();
    expect(out.state).toBe("executing");
    expect(out.reason).toBe("rail_uncertain");
    expect(out.outcomes).toHaveLength(0);
    expect(railErrorOf(out)).toMatchObject({ outcome: "uncertain", code: "provider_error", message: PROVIDER.body.error.message });
  });

  it("an unknown answer is superseded once its attempt has an outcome", () => {
    const answers = [{ attempt_id: "att_0", code: "provider_error", message: "x" }];
    expect(railErrorOf({ outcomes: [], uncertain_answers: answers })).toMatchObject({ outcome: "uncertain" });
    expect(railErrorOf({ outcomes: [{ index: 0, attempt_id: "att_0", status: "settled" }], uncertain_answers: answers })).toBeNull();
    expect(railErrorOf({ outcomes: [] })).toBeNull();
  });
});
