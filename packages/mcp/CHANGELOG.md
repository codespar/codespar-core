# @codespar/mcp — changelog

## 0.5.11 — 2026-10-26

### Added

- Tool `codespar_documents` (`CONTRATO-documentos`): `action=receipt` (`receipt_id`, `format`)
  downloads the payment receipt document (comprovante) and `action=statement` (`from`, `to`,
  `currency?`) the account statement (extrato), through `cs.receipts` / `cs.account` of
  `@codespar/sdk` 0.16.21. With `out` the file is written to that local path and the answer names
  it; without `out` the answer is the reference (filename, content type, size, sha256, API path).
  Bytes never enter the model's context. Listed only when the installed SDK has both facades.
