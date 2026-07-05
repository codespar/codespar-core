# @codespar/cli — changelog

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
