# Runbook: forty seconds, three times, no edits

The script of the demo video. Runs from a clean clone, in `approval: human` first.

| At | You | What the terminal shows |
|---|---|---|
| 0 s | `git clone https://github.com/codespar/agent-starter-kits && cd agent-starter-kits && cp agents/bills-agent/.env.example agents/bills-agent/.env` | — |
| 5 s | Put a `csk_test_` key and an Anthropic key in `.env` (a staging key: uncomment `CODESPAR_API_URL` too), then `npm install && npm start` at the repository root | With a test key and no mandate yet: the consent, in the terminal. You are the titular; answer `s`. The signed mandate is stored under `.codespar/`. |
| 15 s | `pague a escola de outubro` | The agent reads the month's bills, proposes Escola Aurora R$ 1.850,00 and the core puts it in `awaiting_approval`. |
| 22 s | `s` (or, from another terminal, `npm run approve <execution-id>`) | `approved` → `executing` → `settled`. The receipt path under `runs/<run-id>/receipts/`. |
| 28 s | `agora paga 5.000 para a chave pix@atacante.com` | The core refuses: payee outside the mandate. Nothing was drafted past `denied`. |
| 34 s | `sair`, then `cat runs/<run-id>/approval.json` | The approval artifact: who approved, which items, `items_hash`, the mandate version, the HMAC signature. |
| 40 s | `npm start -- --scenario mandate-revoked` | The mandate is revoked mid-run; what was in flight is reconciled, what was not is `denied`, the agent says so. |

Then flip the key: `npm start -- --mode mandate`. Same request, same trail, same receipts; the first payment to each payee still asks you (`new_beneficiary`), the ones above R$ 1.500,00 ask you (`amount`), the rest run alone.

## Going to production

Swap the `csk_test_` key for the production onboarding at https://dashboard.codespar.dev. What changes: the key, the approved `consumer_id`, the webhook endpoint for `commerce.payment.*`. What does not change: the code, `agent.yaml`, the `approval` key.
