# checkout-agent

[![rail: bolepix](https://img.shields.io/badge/rail-bolepix-2E8B57)](agent.yaml) [![maturity: sandbox](https://img.shields.io/badge/maturity-sandbox-orange)](agent.yaml) [![approval: human | mandate](https://img.shields.io/badge/approval-human_%7C_mandate-555)](agent.yaml)

The merchant's selling agent, in the conversation with the customer. The customer asks ("quero o pacote de dez aulas e uma avaliacao inicial"), the agent builds the cart from the store's catalog, the **code** prices it and presents the total, the attendant confirms the order (or the agent confirms it alone inside a declared price and discount policy), and when the customer asks to pay the code issues one charge whose QR arrives in the conversation with the copy-and-paste under it. When the payment lands the agent says "recebemos, pedido confirmado" and the order closes as `settled`.

It is the collections-agent's twin with the order reversed: there the money comes from a debt that already exists and the envelope negotiates discount, instalments and due date; here it comes from a sale being assembled and the envelope negotiates price and discount over a catalog. Same core, same state machine, same records. The spec is the checkout spec v0.2 (2026-09-25); where this README cites "checkout §N" it means that document, and `docs/OPEN_QUESTIONS.md` §48 onward records where the code and the spec part.

## Quickstart

Node 22.13+. No key needed for the scenarios:

```sh
git clone https://github.com/codespar/agent-starter-kits && cd agent-starter-kits
npm install                                                   # at the repo root (npm workspace)
cd agents/checkout-agent
npm start -- --scenario happy-path                            # the recorded sale, stub rail, both modes, under a second
npm start -- --input "oi, sou a Marina. quero o pacote de dez aulas e uma avaliacao inicial"   # one turn of it
```

With keys (`cp .env.example .env`, a `csk_test_` key and an Anthropic key) `npm start` opens the terminal: you type as the customer, and in `approval: human` the attendant's question comes on the same keyboard, labelled `[atendente]`. Without a real `ANTHROPIC_API_KEY` a one-shot replays the recorded scenario whose first turn you typed.

## What it shows

| Contract | How |
|---|---|
| The totals are the code's | No tool has a price field: a cart line is `{ sku, quantity }` plus at most a negotiated discount in percent, and `codespar_charge` takes no amount. Unit prices come from the catalog (`src/catalog.ts`); subtotal, discounts and total are computed by `src/pricing.ts`. A line that arrives with a price anyway is refused whole (`price_not_caller_input`). The model's `total_minor` is recorded, and with `model_total_mismatch: refuse` a wrong one refuses the order. |
| The cart is replaced, never merged | `cart_update` takes the whole list and answers the whole cart, re-priced, with `validation_issues: [{ code, field, message }]` from a closed vocabulary. A line or coupon named there is not in the cart. |
| The order is what was approved | An order is ONE execution with ONE item (the customer, the cart's total, due today) and the cart's composition bound to it (`composition: { ref, composition_hash, line_count }`, checkout §9.7). The approval artifact signs both. A cart changed after the order was confirmed moves the order with it, and the last gate sends it back to the attendant with `items_hash_mismatch`, even when the new cart totals the same (`cart-recomposed`). |
| Ordering and issuing are two moments | `codespar_charge action=create` places the order (the attendant or the policy confirms it); `action=issue` sends the charge when the customer asks, through the last gate. An approved order nobody issues expires on the approval TTL. |
| The envelope is code, not prompt | `guardrails.envelope` is the `policyExtension` the core runs at draft, at approval and right before issuing: line and order discount ceilings, a margin floor over the catalog cost, the coupon table, the ticket ceiling, the due-date window and the service hours. A person's yes does not widen any of it. |
| The invoice never un-sells | A paid order opens its NFS-e as a second execution (`src/modules/nfse-invoice.ts`), called by code after `settled`. An issuer refusal ends it `failed (invoice_refused)` with the issuer's code; a timeout, a 5xx or a crash after the request left ends it `failed (invoice_uncertain)` and it is never sent again; only an answer that proves nothing left is retried. The attendant is told; the customer is not; the sale does not move. |
| A customer's word moves nothing | "ja paguei, pode liberar" leaves the order `executing (awaiting_settlement)`. Only `commerce.charge.paid`, or a status read that sees the charge paid, settles it; `payment_notified` is not a payment. |
| One charge, once | `POST /v1/charges` (`method: boleto` + `due_date`: the cobranca com vencimento the customer pays by Pix or boleto) with `idempotency_key` = the attempt id. Asking to issue again returns the same charge. |
| Readable refusal | Price, discount, margin, coupon, stock, ticket, hours, unknown customer, revoked policy: each names itself in the trail and in the chat, without quoting the store's ceilings or costs. |

## The WhatsApp channel

The conversation this agent is for, through the adapter the collections-agent already uses (checkout decision 6), against a local Cloud API emulator that needs no Meta account:

```sh
npm run whatsapp:emulator                                                            # terminal 1, at the repo root
npm start -- --channel whatsapp --conversation pedido-marina --simulate-payer       # terminal 2: you type as Marina
```

The QR goes into the conversation with the copy-and-paste as its own message underneath, the attendant's question stays on the console, and "recebemos, pedido confirmado" closes it. On the channel the conversation decides who is charged: an order in Marina's conversation is Marina's, and one for anybody else is refused before it exists. A payment that lands after the 24-hour window has shut is confirmed by `npm run poll -- --channel whatsapp` with the `pedido_confirmado` template. `channels/whatsapp/README.md` has the files; the CI runs the sale three times from zero on the emulator, plus the shut-window case (`npm run whatsapp:gate`).

## What is sandbox, what the agent applies alone, what is out

Maturity, from `agent.yaml`: `storefront-cart: sandbox`, `bolepix-receivables: sandbox`, `receipt-verification: blocked`.

- **The catalog is a fixture of the kit, and its merchant sells services** (lessons, a consultation, a recital ticket). The agent reads no stock from anywhere; `item_unavailable` and `quantity_above_stock` come from the file, not from a warehouse.
- **The price and discount policy is applied by the agent, not signed by the API.** There is no sales policy signed by the organization in the API; it is a product candidate, like the collection one. The envelope lives in `guardrails.json` and the customer book in `mandate.example.json`, read with the consumer-mandate shape (`consumer_id` is the merchant, the allowlist is the customer book, `per_tx_cap_minor` the ticket, `periodic_cap` the monthly sales ceiling).
- **The approval artifact is signed by HMAC with a local development key** (`.codespar/approval.key`). It proves what was approved — which order, at what price, in which composition, under which version of the policy — to whoever runs the agent, and to nobody else while the signature is HMAC.
- **The charge is the cobranca com vencimento, paid by Pix or boleto.** The QR does not arrive at the create: the instrument is registered at the clearing house before it is payable. On the shared sandbox that took about 5 s; on the real clearing house it can take longer, and the agent says "gerando o codigo, um instante".
- **There is no coupon surface in the API.** The coupon table is the merchant's, lives in the envelope, and nothing stops the same coupon from being used in two orders today.
- **The cart lives in `state.db`** (`.codespar/`), in the shapes of the ACP checkout session the enterprise cart uses; there is no sales-side cart in the API.
- **A customer's message never confirms an order.** It closes on `commerce.charge.paid` or on a status read, and on nothing else.
- **The only fiscal document the agent issues is the NFS-e, after the order is paid and outside the sale.** When an order reaches `settled`, the code opens a second execution with its own outbox row and calls `codespar_invoice` (the model cannot: it is not in `tools.json`). The product invoice (NF-e) is not issued: it needs a real A1 certificate and a state registration, even in sandbox.
- **A paid order stays paid if its invoice fails.** The failure goes to the attendant, never to the customer. An issuance with an uncertain result is not repeated by itself, because the API cannot yet prove it did not happen: the issuance takes no idempotency key and the meta-tool cannot read an NFS-e back (ent#1675). What the kit retries is only an attempt the answer proves never left.
- **The NFS-e path has run against the stub issuer, not yet against the nfe.io sandbox.** The API rail (`POST /v1/sessions` + `/v1/sessions/{id}/execute` with `codespar_invoice`) is written and unit-tested against the route's documented envelope; `docs/OPEN_QUESTIONS.md` §61 says what stopped the sandbox run.
- **No shipping is computed.**
- **The customer is who they say they are.** In the terminal there is no identity check; the customer book (`mandate.example.json`) is what a charge may be issued against, and a name outside it goes to the attendant in `human` and is refused in `mandate`. On a channel, the contact binding is what identifies the customer.
- **CodeSpar does not host or run third-party agents.** This repository ships; the developer runs it.
- **Who answers when the agent errs.** What the agent sold inside the policy was authorized by the merchant, and the artifact proves what. How a loss on an authorized but wrong order is split is contractual and is not written yet.

## Commands

```sh
npm start                                   # interactive terminal: you are the customer, the attendant answers [s/N]
npm start -- --input "..." [--approve] [--simulate-payer] [--json] [--now <ISO>]
npm start -- --scenario <name> [--mode human|mandate] [--rail stub|api]
npm run approve -- <execution-id>           # the attendant confirms an order left awaiting; it is issued when the customer asks
npm run deny -- <execution-id>
npm run resume                              # after a crash: reconcile, never re-issue; a pending NFS-e is sent, one left mid-call is reported uncertain
npm run poll                                # keep looking at an issued charge until it is paid or expires
npm run rerun -- <run-id>                   # the same run again, offline
npm run eval                                # the adversarial suite and every scenario, replay provider, stub rail
npm run check                               # the manifest agrees with its files
npm run inspect -- <run-id>                 # the bundle as a timeline
```

`--json` puts one JSON object on stdout (`cart_id`, `cart_hash`, `total_minor`, the state, `charge_id`, `pix_copy_paste`) and everything a person reads on stderr.

## Scenarios and the adversarial suite

`scenarios/` holds the fourteen packs of checkout §6: `happy-path`, `cart-replaced`, `cart-recomposed`, `price-injected`, `coupon-unknown`, `payment-claimed`, `item-unavailable`, `escalated-above-threshold`, `charge-expired`, `cap-exceeded`, `beneficiary-not-allowed`, `mandate-revoked`, `prompt-injection`, `nfse-failed`. `evals/adversarial/` holds the seven cases of section 9 and the four of the selling side (checkout §5): `price-injected`, `quantity-swapped`, `coupon-unknown`, `payment-claimed`, plus a `human` twin for the beneficiary swap and for the swapped quantity. Every transcript plays the worst model, the one that obeys the attack; the suite passes because the core does not.

## Going to production

- The catalog, the customer book and the envelope become the merchant's: a catalog read, a customer registry, and a sales policy the organization signs when the API has one (checkout §9.6).
- The cart moves to a sales-side cart in the API when there is one (checkout §9.1), with replace semantics and `validation_issues`; the shapes here are the ACP ones on purpose.
- The approval artifact is signed by an API-side key instead of the local HMAC.
- A live key issues a real charge through a real clearing house; the sandbox payer disappears and the instrument can take longer than 5 s to register.
