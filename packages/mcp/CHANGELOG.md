# @codespar/mcp — changelog

## 0.5.17 — 2026-10-29

### Added

- Documents reach the client as MCP content, the contract the hosted
  connector serves: a receipt's PNG as an `image` block and a PDF as an
  embedded `resource` (`codespar://documents/receipts/<receipt_id>.pdf`,
  `codespar://documents/statements/<from>_<to>.pdf`), nothing above 4 MiB,
  and one sentence saying what is attached. Both doors: `codespar_documents`
  attaches the document it downloaded, and a `codespar_wallet`
  `receipt_document` / `statement_document` answered through the session
  fetches its document through the REST door the reference names (the
  receipt's PNG and PDF, the statement's PDF) with the caller's own key. The
  JSON reference is unchanged; a client that ignores images or resources
  reads it as before.

Ships in the same release as 0.5.16 (`codespar_payables` discard) and
`@codespar/sdk` 0.16.25 (session tools read on creation).

## 0.5.16 — 2026-10-28

### Added

- `codespar_payables` gains `action: "discard"`, in two steps: without
  `confirm` it reads the batch and answers `requires_confirmation` with how many
  items would leave (nothing is sent); with `confirm: true` it discards through
  `@codespar/sdk` 0.16.24. The projection carries `discarded`.

## 0.5.15 — 2026-10-28

### Fixed

- `initialize` announces the version npm published (`serverInfo.version`). 0.5.14 said
  "0.5.13" because `bin.ts` carried the number as a literal that the release bump missed;
  the server now reads it from the package's own `package.json` (`src/version.ts`), and a
  test starts the built server and compares the two.

## 0.5.14 — 2026-10-27

### Added

- **`codespar_payables` action `set_rail`** (`batch_id`, `item_id`,
  `expected_version`, `rail`): the way to pay an item printed with a Pix code
  and a boleto for the same bill (payables contract v1.1); `update_item` takes
  `rail` too. The projection the model reads gains `rail_chosen_by`, `ways`
  (rail and `unavailable` only) and `document` (title, due date, amount; never
  the page's free text).

## 0.5.13 — 2026-10-27

### Changed

- `codespar_payables` says the two auth answers apart, in the API's words: a `403`
  is rendered as `insufficient permission (403): <the API's message naming the scope>`
  and a `401` as `credential invalid or revoked (401): …`, so an agent with a key
  that lacks only `payables:pay` keeps uploading and reading instead of treating
  the key as broken. Nothing is widened: the API still requires `payables:pay` to
  pay and `sessions:create` to open a session. README gains a "Scopes" section.

## 0.5.12 — 2026-10-27

### Added

- Tool `codespar_documents` (`CONTRATO-documentos`): `action=receipt` (`receipt_id`, `format`)
  downloads the payment receipt document (comprovante) and `action=statement` (`from`, `to`,
  `currency?`) the account statement (extrato), through `cs.receipts` / `cs.account` of
  `@codespar/sdk` 0.16.22. With `out` the file is written to that local path and the answer names
  it; without `out` the answer is the reference (filename, content type, size, sha256, API path).
  Bytes never enter the model's context. Listed only when the installed SDK has both facades.

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
