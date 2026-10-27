# @codespar/mcp — changelog

## 0.5.11 — 2026-10-26

### Fixed

- **The stdio server starts without `sessions:create`.** It created a session
  at boot and read a 403 as a rejected key, so a key holding only
  `payables:read` / `payables:write` (mintable from the API keys modal since
  codespar-web #1218) fell into setup mode and never exposed
  `codespar_payables`, although paying documents needs no session. Measured
  on 2026-10-26 on the QA account. Now a 401 is setup mode (the key is not
  usable), a 403 on the session is "no session": the server runs with the
  tools that need none (`codespar_payables`), says so on stderr and answers
  any session tool with the scope that is missing. The hosted tools
  (`codespar_wallet` with its `pix_keys_*` actions, `codespar_pay`, …) and
  the Shop purchase tools run inside a session, so they still need
  `sessions:create` besides their own scope (`consumers:pix-keys` for the
  Pix key actions).

### Changed

- The hosted `codespar_wallet` definition is relayed as the API publishes it
  (enterprise: `pix_keys_list`, `pix_keys_register`, `pix_keys_delete`,
  `key_id`, `confirm`); nothing to configure here.
