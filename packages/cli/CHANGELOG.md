# @codespar/cli — changelog

## 0.8.0 — 2026-09-14

The hand-written commands now address routes the served OpenAPI document
declares, and the client is typed by that document, so a route that does
not exist is a compile error rather than a 404 in the user's terminal.
See [codespar/codespar-core#130](https://github.com/codespar/codespar-core/issues/130).

### Fixed

- `codespar servers list` and `codespar sessions list` crashed with
  `TypeError: Cannot read properties of undefined` against production:
  they read `data`, and the payloads carry `servers` and `sessions`.
- `codespar tools list` and `codespar tools show` called `GET /v1/tools`
  and `GET /v1/tools/{name}`, routes the API has never had. Tools are
  listed per server, so `--server <id>` is now the address, not a filter,
  and its absence is refused with the two commands that lead to an id.
- `codespar servers show <id>` called `GET /v1/servers/{id}`, which does
  not exist. It is now assembled from the catalog listing, the per-server
  tool listing and the per-server auth schema.
- `codespar sessions close <id>` posted to `/v1/sessions/{id}/close`; the
  documented close is `DELETE /v1/sessions/{id}`.
- `codespar sessions show <id> --logs` read `/v1/sessions/{id}/logs`,
  which does not exist; the session's tool calls do.
- `codespar logs tail` opened an SSE stream on `/v1/logs/stream`, which
  does not exist, and its failure message pointed at `sessions show
  --logs`, which was the second missing route. It reads
  `GET /v1/tool-calls` now, with `--follow` polling for new rows, because
  the API has no push channel for this.
- `codespar connect list --status` accepted any word; the listing
  declares `pending|connected|revoked|expired`.
- A timestamp the API sends in an unexpected shape no longer kills the
  whole table with `RangeError: Invalid time value`.

### Changed

- **Breaking:** `codespar servers list --region <code>` is now
  `--country <code>`. `region` was not a query parameter the API accepts,
  so the flag silently returned every server; `?country=BR` returns 62 of
  134. `-q/--query <text>` is new, and the document declares it.
- `codespar tools show <name>` no longer prints an input/output schema
  section: the catalog listing carries a name and a description only.
  `codespar tools meta <name>` is where the published schemas are.

### Internal

- `ApiClient` is typed by path template and response shape from the same
  generated document `@codespar/sdk` uses. `ApiClient.offSpec` is the
  single, deliberately named door for the two routes that answer in
  production but are absent from the document.
- The hand-written path ratchet drops from eight entries to two.

## 0.7.1 — 2026-09-14

### Fixed

- `codespar --version`, the banner and the `User-Agent` header now report
  the version the package declares. They reported `0.5.5` in the
  published 0.6.0, 0.6.1, 0.6.2 and 0.7.0, because the number lived in a
  hand-written literal that four releases forgot to update. The module
  reads the manifest instead, so there is no second place to forget. See
  [codespar/codespar-core#144](https://github.com/codespar/codespar-core/issues/144).


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
