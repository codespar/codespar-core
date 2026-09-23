# @codespar/cli — changelog

## 0.13.0 — 2026-09-23

### Added

- `codespar agent run <dir> [--input <text>] [--approve|--deny] [--json]`
  runs an agent directory built on `@codespar/agent-core` (agent-starter-kits,
  `agent.yaml` `schema: 1`). It does not re-implement the runtime: it
  resolves the manifest and spawns the directory's own `npm start` with the
  same arguments, so `codespar agent run <dir> --input X` and
  `npm start -- --input X` in that directory are the same process and give
  the same output and exit code (spec v5.1.1 §15). A directory with no
  `agent.yaml`, or one of a schema this CLI does not know, is refused with a
  stable `error.code` (`agent_manifest_missing`,
  `agent_manifest_unsupported_schema`).
- `codespar eval <dir> [--json]` runs the agent's `npm run check` and
  `npm run eval` (adversarial suite plus every scenario in every mode) and
  reports one line per case; `--json` answers one document with the case
  list and both kit documents verbatim. Exit 1 on any failing case; a
  failing check does not stop the eval suite from running.
- `codespar mandate revoke <id> [--reason <text>] [--json]` over
  `POST /v1/mandates/{id}/revoke`, the canonical spelling (ent#979). Active
  or paused → revoked, terminal; an already-revoked mandate answers
  `changed: false` and is reported as unchanged, not as a failure. The
  route is in the served OpenAPI document, so the call goes through the
  typed client with no hand-written path. `surface.ts` had this verb
  listed as wave-5 work; it is built now on the existing route.
- `error.code` on a `cli` refusal in the `--json` error document, when the
  refusal has a stable name (`CliError` takes an optional `code`).

## 0.12.1 — 2026-09-21

### Fixed

- `codespar sessions close` respondia 400 e nao fechava nada. O cliente
  proprio da CLI punha `Content-Type: application/json` em TODA requisicao, e
  a API recusa uma que se anuncia como JSON e chega vazia:
  `DELETE /v1/sessions/{id} → 400: Body cannot be empty when content-type is
  set to 'application/json'`. Era o unico comando deste cliente que manda
  DELETE, entao era o unico que morria; os GET passavam porque a checagem so
  vale para metodo que pode carregar corpo. O cliente gerado do SDK ja fazia o
  certo. O header agora acompanha o corpo, nao o metodo.

## 0.12.0 — 2026-09-21

### Fixed

- `error.kind` nao separava nada. A 0.11.3 respondia `kind: "cli"` — que
  significa "a CLI recusou antes de chegar na API" — para todo 401, 404 e 500
  recebido pelos onze comandos escritos a mao, sem `status` e sem `body`,
  enquanto os comandos gerados, que passam pelo cliente do SDK, respondiam
  `kind: "api"` com os dois campos. Um binario, uma flag, dois contratos, e o
  campo que existe para um script ramificar sem interpretar prosa nao servia
  para isso. Medido na 0.11.3 publicada: `whoami`, `wallet`, `servers list` e
  `sessions list` diziam `cli`; `consumers list` dizia `api`. Agora os dois
  caminhos respondem `api` com `status`, `code` quando a API manda, e `body`.
  A linha humana no stderr nao muda.
- O corpo de uma resposta de erro era lido duas vezes: `res.json()` consumia o
  fluxo e o `catch` chamava `res.text()`, que sempre falha depois disso, entao
  um corpo que nao fosse JSON chegava como detalhe vazio. Agora le uma vez.

## 0.11.3 — 2026-09-21

### Fixed

- `codespar login --api-key <chave>` nao funcionava e saia **0**. A flag esta
  declarada na raiz e em `login`, e o commander entrega o valor a raiz, entao
  a acao lia `undefined` e caia no prompt; com stdin em EOF o processo saia
  zero sem gravar nada. `init` sem TTY tinha o mesmo desenho. Os dois agora
  recusam com exit 1 (#158).
- `codespar execute` saia **0** quando a ferramenta respondia `success: false`,
  enquanto `codespar tool` saia 1 para a mesma resposta (#158).
- `ledger` recusava duas das cinco acoes publicadas e a recusa do `charge`
  nomeava tres dos quatro metodos: o vocabulario passa a ser lido de
  `@codespar/types` (#158).
- `login` ignorava a base URL do arquivo de config, e variavel de ambiente
  VAZIA vencia o arquivo (#158).
- Os comandos escritos a mao chamavam cinco rotas depreciadas:
  `/v1/connect/start`, `/v1/consents/init`, `/v1/servers` e
  `/v1/servers/{id}/auth-schema` (#160).
- Com `--json`, uma falha escrevia zero byte no stdout. Agora escreve um
  documento com `error.kind`; cinco comandos que ignoravam a flag passam a
  responder; `logs tail --json` virou NDJSON; e a tabela avisa quando corta
  uma celula (#161).

### Changed

- Exige `@codespar/sdk` `^0.16.1`. A faixa anterior aceitava de `^0.12.0` a
  `^0.16.0`, e a partir desta versao a CLI LE `deprecated` da tabela de
  operacoes, que so existe da 0.16.1 em diante. Com uma SDK mais velha as
  marcas de rota morta sumiam em silencio e os comandos novos nao apareciam.

### Added

- `codespar payables create` e `codespar payables get`, derivados do documento
  servido quando as duas operações entraram nele. Nada foi escrito à mão: o
  grupo é uma linha em `PUBLISHED_GROUPS` e os comandos saem do spec.
- `codespar consents get` e `codespar consents submit`, pelo mesmo caminho,
  quando o snapshot subiu para 280 operacoes (#159).

### Changed

- O grupo `triggers` aponta para `/v1/webhook-endpoints`. As 12 grafias de
  comando sao as mesmas; o que muda e a rota, porque `/v1/triggers` esta 12 de
  12 depreciada no documento servido (#159).
- Um comando derivado de rota depreciada passa a dizer `(deprecated)` no
  `--help` (#159).

## 0.11.2 — 2026-09-14

### Fixed

- A 0.11.0 publicada nao subia: `codespar --help` abortava com
  `cannot add command 'tools' as already have command 'tools'`, porque o grupo
  derivado colidia com o comando escrito a mao. O grupo virou `catalog` (#151).
- O portao de boot tinha orcamento implicito e derrubava o proprio publish
  (#152).

## 0.11.1 — nao publicada

## 0.11.0 — 2026-09-14

### Added

- Comandos por grupo de recurso e as 15 meta-tools, derivados da superficie
  publicada (core#125).

### Known issue

- Esta versao esta no npm e NAO SOBE: ver 0.11.2.

## 0.10.0 — 2026-09-14

### Changed

- `--arg` accepts either form of a property that publishes a union of
  shapes. `codespar pay --arg recipient=pix@example.com` sends the Pix
  key as text and `--arg recipient={"bank":...}` sends the bank-account
  object, from the same flag (codespar-core#128). A key that is all
  digits stays text: the parse is taken only when it lands on a
  structured branch, so a CPF does not become a number.

## 0.9.0 — 2026-09-14

### Added

- `codespar charges` — `list`, `create`, `get <chargeId>` and
  `cancel <chargeId>`. The family answered over HTTP and was missing from
  the served OpenAPI document, so nothing downstream could see it; the
  snapshot refresh brought it in and the group derives from it with no
  per-route code. Closes the CLI half of
  [codespar/codespar-enterprise#1307](https://github.com/codespar/codespar-enterprise/issues/1307).

### Changed

- The SDK dependency range accepts `^0.14.0`.

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
