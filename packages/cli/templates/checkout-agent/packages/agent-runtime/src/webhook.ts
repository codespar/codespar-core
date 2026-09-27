/**
 * The webhook channel: the OTHER way the cycle closes. The CodeSpar API
 * delivers `commerce.charge.*` to a trigger's URL; a terminal kit has no
 * URL the API can reach, so the default is the poll (`poll.ts`) and this
 * receiver is what a developer wires when they do have one.
 *
 * STUB, on purpose: it does not register a trigger (that is
 * `POST /v1/triggers` with `events: ["commerce.charge.paid", ...]`, done
 * once with the CLI or the dashboard), it does not expose itself to the
 * internet, and it holds no key. What it does is the receiving contract:
 *
 *   POST <url>
 *   Content-Type: application/json
 *   X-CodeSpar-Event: commerce.charge.paid
 *   X-CodeSpar-Event-Id: evt_...
 *   X-CodeSpar-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>
 *   { "id": "evt_...", "type": "commerce.charge.paid", "source": "celcoin", "occurred_at": "...", "data": { "payment_id": "<charge id>", ... } }
 *
 * The body is handed to `engine.ingestExternalEvent` by the rail's charge id
 * (`data.payment_id`), which the kit recorded when the attempt was accepted.
 * Duplicates are dropped by event id, `paid` after `expired` (or the other
 * way round) moves nothing, and the debtor is told once. With a trigger
 * secret the signature is verified and a bad one is 401; without one, the
 * receiver is unauthenticated and says so on start.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Execution, ExecutionEngine } from "@codespar/agent-core";

export interface WebhookDelivery {
  id: string;
  type: string;
  source?: string;
  occurred_at?: string;
  data?: Record<string, unknown>;
}

export interface WebhookHandlerOptions {
  engine: ExecutionEngine;
  /** The trigger's HMAC secret (`POST /v1/triggers` returns it once). Without it, no signature is checked. */
  secret?: string | undefined;
  /** Seconds a signature timestamp may be off. */
  toleranceSeconds?: number;
  clock?: () => Date;
  /** What to do with an execution the delivery closed (tell the payer, fetch the record). */
  onClosed?: (execution: Execution) => Promise<void> | void;
}

export interface WebhookResponse {
  status: number;
  body: Record<string, unknown>;
}

export function verifySignature(secret: string, header: string | undefined, body: string, now: Date, toleranceSeconds: number): { ok: true } | { ok: false; reason: string } {
  if (!header) return { ok: false, reason: "missing X-CodeSpar-Signature" };
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const t = parts["t"];
  const v1 = parts["v1"];
  if (!t || !v1) return { ok: false, reason: "malformed signature header" };
  const skew = Math.abs(now.getTime() / 1000 - Number(t));
  if (!Number.isFinite(skew) || skew > toleranceSeconds) return { ok: false, reason: "signature timestamp outside tolerance" };
  const expected = createHmac("sha256", secret).update(`${t}.${body}`, "utf8").digest("hex");
  if (expected.length !== v1.length || !timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(v1, "hex"))) return { ok: false, reason: "signature mismatch" };
  return { ok: true };
}

export function chargeIdOf(delivery: WebhookDelivery): string | undefined {
  const data = delivery.data ?? {};
  for (const key of ["payment_id", "charge_id", "external_reference"]) {
    const v = data[key];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

/** The pure handler: headers and raw body in, status and body out. The HTTP server below is a thin wrapper. */
export function createWebhookHandler(options: WebhookHandlerOptions) {
  const clock = options.clock ?? (() => new Date());
  return async (headers: Record<string, string | undefined>, rawBody: string): Promise<WebhookResponse> => {
    if (options.secret) {
      const check = verifySignature(options.secret, headers["x-codespar-signature"], rawBody, clock(), options.toleranceSeconds ?? 300);
      if (!check.ok) return { status: 401, body: { error: "bad_signature", reason: check.reason } };
    }
    let delivery: WebhookDelivery;
    try {
      delivery = JSON.parse(rawBody) as WebhookDelivery;
    } catch {
      return { status: 400, body: { error: "invalid_json" } };
    }
    if (typeof delivery.id !== "string" || typeof delivery.type !== "string") return { status: 400, body: { error: "invalid_delivery", reason: "id and type are required" } };
    if (!delivery.type.startsWith("commerce.charge.")) return { status: 200, body: { applied: false, reason: `event type ${delivery.type} is not a charge event` } };
    const chargeId = chargeIdOf(delivery);
    if (!chargeId) return { status: 200, body: { applied: false, reason: "delivery names no charge" } };
    const before = options.engine.list({ state: "executing" }).map((e) => e.id);
    const result = options.engine.ingestExternalEvent({ event_id: delivery.id, type: delivery.type, transaction_id: chargeId, ...(delivery.occurred_at ? { at: delivery.occurred_at } : {}) });
    if (result.applied) {
      for (const id of before) {
        const after = options.engine.get(id);
        if (after && after.state !== "executing") {
          await options.engine.collectReceipts(after.id);
          await options.onClosed?.(after);
        }
      }
    }
    // Always 2xx once the delivery was read: the API retries on anything else, and a duplicate or a late event is not an error.
    return { status: 200, body: { applied: result.applied, reason: result.reason } };
  };
}

export function startWebhookServer(port: number, options: WebhookHandlerOptions, say: (line: string) => void): Server {
  const handle = createWebhookHandler(options);
  const server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v]));
      void handle(headers, Buffer.concat(chunks).toString("utf8")).then((out) => {
        res.writeHead(out.status, { "content-type": "application/json" }).end(JSON.stringify(out.body));
      });
    });
  });
  server.listen(port, () => {
    say(`webhook receiver on http://127.0.0.1:${port}/ (${options.secret ? "signature verified" : "UNAUTHENTICATED: set the trigger secret to verify deliveries"})`);
    say("register the URL once: codespar triggers create --events commerce.charge.paid,commerce.charge.expired,commerce.charge.cancelled --url <public url>");
  });
  return server;
}
