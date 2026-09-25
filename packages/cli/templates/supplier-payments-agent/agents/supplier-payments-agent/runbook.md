# Runbook: forty seconds, one batch, no edits

The script of the demo. Runs from a clean clone, in `approval: human` first, on the stub rail (no key needed).

| At | You | What the terminal shows |
|---|---|---|
| 0 s | `git clone https://github.com/codespar/agent-starter-kits && cd agent-starter-kits && npm install` | — |
| 8 s | `npm run start:supplier` | The banner: `approval: human`, the stub rail, the example mandate. |
| 12 s | `roda a folha de outubro` | The agent reads the payables, and the core drafts THREE executions, one per employee. It asks about each one in turn. |
| 20 s | `s`, `s`, `s` | Three times `approved` → `executing` → `settled`, three receipt paths under `runs/<run-id>/receipts/`. The approved list is three artifacts, not one. |
| 26 s | `roda a folha de outubro` again | Nobody is paid twice. Every line comes back `already_settled`, naming the execution that covers it. |
| 32 s | `sair`, then `cat runs/<run-id>/approval.json` | One artifact per line: who approved, which item, `items_hash`, the mandate version, the HMAC signature. The batch is the set of them. |
| 40 s | `npm start -- --scenario partial-batch-failure` | A supplier the rail refuses. The other two settle, the refused line is named, and the run does not stop at it. |

Then flip the key: `npm start -- --mode mandate`. Same code, same trail, same receipts; the first payout to each payee still asks you (`new_beneficiary`), the ones above R$ 1.500,00 ask you (`amount`), the rest run alone.

## Going to production

Swap the stub for the production onboarding at https://dashboard.codespar.dev. What changes: the key, the approved `consumer_id`, the signed mandate, the webhook endpoint for `commerce.payment.*`. What does not change: the code, `agent.yaml`, the `approval` key.
