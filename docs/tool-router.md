# Tool Router — concept overview

The Tool Router is the layer that turns a CodeSpar **session** into a live execution endpoint for tools. Once a session exists, the agent can:

- Execute registered tools via `session.execute(tool, params)` — the default path for anything in the catalog.
- Proxy raw HTTP calls via `session.proxyExecute({ server, endpoint, method, body })` — for endpoints not yet covered by a pre-defined tool, or when the meta-tool schema is too narrow.
- Be consumed as MCP — the session URL (`session.mcp.url`) is compatible with Claude Desktop, Cursor, and VS Code.

**In every case, credentials stay on the server.** The agent only sees the session id; the backend injects the right API key, OAuth token, or certificate per provider and logs the call.

---

## Why it exists

Commerce workflows touch 3–6 providers. Without a router, the agent code needs to:

1. Store provider credentials (a security and compliance nightmare).
2. Format each request in the provider's native shape.
3. Handle rate limit, retry, and credential rotation per provider.
4. Log, audit, and bill manually.

With the router, the agent only carries a short-lived CodeSpar API key, calls `session.execute` or `session.proxyExecute`, and the backend handles the rest.

---

## Three ways to call a tool

**1. Meta-tool (default)** — routes to the best provider for the region/payment method. The agent doesn't need to know whether Pix went through provider A, B, or C.

```ts
await session.execute("codespar_pay", {
  method: "pix",
  amount: 15000,
  currency: "BRL",
});
```

The router exposes 9 meta-tools today:

| Meta-tool | What it does |
|---|---|
| `codespar_pay` | OUTBOUND transfers / payouts (Asaas, Mercado Pago). |
| `codespar_charge` | INBOUND charges — buyer pays merchant. Pix BRL via Asaas / MP / iugu / Stone; card USD via Stripe. |
| `codespar_invoice` | Fiscal invoices. Defaults to NFS-e (services); pass `rail: "nfe"` for product NF-e via NFe.io. Also `nfci` (CFDI MX) and Factura AR (AFIP). |
| `codespar_notify` | Messaging — WhatsApp via Z-API / Twilio, SMS via Twilio, email via SendGrid. |
| `codespar_ship` | Melhor Envio with 3 rails picked via `action`: `"label"` / `"quote"` / `"track"`. |
| `codespar_crypto_pay` | Crypto payments via Coinbase Commerce + Bitso. |
| `codespar_kyc` | Identity / risk verification — Persona, Sift, Konduto, Truora. |
| `codespar_discover` | Server-side counterpart to `session.discover(...)` — semantic + lexical tool search across the catalog. |
| `codespar_manage_connections` | Connection wizard backend — surfaces deep-links the UI renders into a Connect button. |

**2. Raw provider tool** — when the meta-tool abstraction is too broad and you want the exact provider shape. Credentials still injected server-side.

```ts
await session.execute("STRIPE_CREATE_CHARGE", {
  amount: 1000,
  currency: "usd",
  source: "tok_visa",
});
```

**3. Proxy execute (raw HTTP)** — for anything not yet covered by a registered tool: new provider endpoints, beta APIs, one-off integrations. Backend still injects auth, rate-limits, and writes the audit log.

```ts
await session.proxyExecute({
  server: "stripe",
  endpoint: "/v1/charges",
  method: "POST",
  body: { amount: 1000, currency: "usd", source: "tok_visa" },
});
```

---

## What the Tool Router is **not**

- Not a tool registry — the catalog lives at `/v1/servers`.

## `findTools` vs `discover`

The SDK exposes two ways to look up a tool by description; they are not the same thing:

- `session.findTools(intent)` — **SDK-side** literal substring match against the locally-loaded tool list. No network call, no ranking, no semantics. Use it for a quick "does the loaded session have anything mentioning `pix`?" sanity check.
- `session.discover(query)` — **backend-side** semantic + lexical search via the `codespar_discover` meta-tool (pgvector embeddings + pg_trgm fuzzy match across the full catalog of 109+ MCP servers / 2,200+ tools). Returns a recommended tool plus alternatives, each annotated with connection status and known pitfalls.

Use `findTools` when you already trust the loaded session's tool list and want a literal-match filter; use `discover` when the agent is reasoning over an open-ended use case and needs the catalog's full coverage.

---

## Where this lives in the SDK

- `packages/core/src/types.ts` — `ProxyRequest`, `ProxyResult`, `HttpMethod`
- `packages/core/src/session.ts` — `session.proxyExecute()` implementation
- `packages/cli/` — `@codespar/cli` published on npm (`codespar execute`, `codespar connect list`, etc.)

For the public concept docs, see [docs.codespar.dev/concepts/tool-router](https://docs.codespar.dev/concepts/tool-router).
