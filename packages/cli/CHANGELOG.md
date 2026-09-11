# @codespar/cli — changelog

## 0.7.0 — 2026-09-11

Resource groups and the 15 meta-tools, derived from the published
surface instead of written one by one. See
[codespar/codespar-core#125](https://github.com/codespar/codespar-core/issues/125).

### Added

- Six resource command groups — `consumers`, `boletos`, `sellers`,
  `mcp-servers`, `wallets`, `triggers` — covering 61 operations. Each
  subcommand is one row of `API_OPERATIONS`, the table `@codespar/sdk`
  generates from the served OpenAPI document: the path parameters are the
  positionals, `-q/--query key=value` is repeatable, and `-i/--input` is
  accepted only where the operation declares a body. Dispatch goes
  through `cs.api`, so the CLI adds no HTTP of its own.
- `codespar tool <name>` — invoke any of the 15 meta-tools published in
  `@codespar/types`. `--action` is checked against the tool's published
  vocabulary, `--arg key=value` is typed by the published schema, and a
  missing required property fails before anything is sent.
- `codespar pay` and `codespar kyc` — shorthands for `tool codespar_pay`
  and `tool codespar_kyc`.
- `codespar tools meta [name]` — the published definitions: actions,
  required input, closed vocabularies, full input schema.
- A coverage gate (`src/__tests__/surface-coverage.test.ts`): every
  resource family of the served document needs a command or an exception
  with a reason and a date, and the exception list is a ratchet that only
  goes down. A second ratchet pins the ten REST paths the older commands
  still build by hand, none of which the served document declares.

### Changed

- Errors from the generated REST client (`CodesparApiError`,
  `TimeoutError`) print the API's message and body and exit 1, instead of
  falling through to the internal-error stack trace.

## 0.6.1 — 2026-09-09

Dependency range only: `@codespar/sdk` `^0.12.0` (the generated REST
client, see [codespar/codespar-core#125](https://github.com/codespar/codespar-core/issues/125)).
No command changed.

## 0.6.0 — 2026-07-05

Offline V3 mandate verification from the terminal. See
[codespar/codespar-core#114](https://github.com/codespar/codespar-core/pull/114).

### Added

- `codespar mandate verify <token>` — decodes a V3 presentation token,
  reconstructs the canonical signing string, and verifies the agent and
  issuer Ed25519 signatures. Pure-offline mode with `--agent-pubkey` /
  `--issuer-pubkey` (no network, no API key); default network mode
  resolves public keys via the agent's did:web document
  (id.codespar.dev), still with no API key. `--json` supported; the
  exit code tracks signature verification.

## 0.4.0 — 2026-05-04

Sugar commands wrapping the SDK 0.9.0 typed meta-tool methods. None
of the new commands require `--server`; the meta-tool router picks
the rail per request.

### Added

- `codespar discover <query>` — wraps `session.discover()`. Pretty-prints
  a ranked tool list (rank, score, server.tool, connection status,
  description). `--limit`, `--category`, `--country`, `--json`.
- `codespar charge` — wraps `session.charge(args)`. Args via
  `--input '<json>'` or `--input-file <path>`. Surfaces `charge_url`,
  Pix QR / copy-paste when present.
- `codespar ship` — wraps `session.ship(args)`. Args via `--input` or
  `--input-file`. Validates `action ∈ {label, quote, track}` and the
  required envelope per action.
- `codespar payment-status <tool-call-id>` — wraps `session.paymentStatus`
  (default poll) and `session.paymentStatusStream` (`--stream`).
  `--timeout <ms>` (default 600000), Ctrl+C aborts cleanly via
  AbortController.
- `codespar verification-status <tool-call-id>` — KYC sibling of
  payment-status. Same `--stream` / `--timeout` shape.
- `codespar wizard [server-id]` — wraps `session.connectionWizard`.
  Renders `list` / `status` / `initiate` results with required secrets,
  connect URL, instructions, known pitfalls. `--action`, `--country`,
  `--environment`, `--return-to`, `--json`.

### Changed

- Peer dependency `@codespar/sdk` bumped from `^0.3.0` to `^0.9.0`
  (typed wrappers for charge, ship, discover, paymentStatus,
  verificationStatus, connectionWizard land in 0.9).
- `VERSION` constant in `src/index.ts` bumped to `0.4.0`.
