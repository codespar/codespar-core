# Runbook: a conversation that becomes a payable QR in forty seconds

The script of the demo. Runs from a clean clone, in `approval: human` first. You are the customer; the attendant answers on the same keyboard, labelled `[atendente]`.

| At | You | What the terminal shows |
|---|---|---|
| 0 s | `git clone https://github.com/codespar/agent-starter-kits && cd agent-starter-kits && cp agents/checkout-agent/.env.example agents/checkout-agent/.env` | — |
| 5 s | Put a `csk_test_` key and an Anthropic key in `.env`, then `npm install && npm start --workspace=agents/checkout-agent -- --simulate-payer` | `checkout-agent 0.1.0 — approval: human — trilho: api — politica pol_example_checkout_0001`. No consent step: the sales policy is the merchant's own. |
| 8 s | `oi, sou a Marina. quero o pacote de dez aulas e uma avaliacao inicial` | The agent reads the catalog and replaces the cart with the two lines; the code prices it: R$ 390,00 + R$ 89,90 = **R$ 479,90**, due today. |
| 15 s | `fechado, pode gerar o pagamento` | `codespar_charge action=create`: the order in `awaiting_approval`, the cart's lines and `cart_hash` under it. `[atendente] Confirmar este pedido? [s/N]` |
| 18 s | `s` | `approved`. The model asks to issue (`action=issue`): the last gate recomputes the hashes, `executing (awaiting_settlement)`, `POST /v1/charges` with the `idempotency_key`. "gerando o codigo, um instante". |
| 24 s | wait | The QR as an image, the Pix copia e cola under it, the boleto line under that. The sandbox payer (because of `--simulate-payer`) pays. |
| 34 s | wait | `-> settled`. `Recebemos, pedido confirmado!` The paid charge under `runs/<run-id>/receipts/`. |
| 36 s | `o vendedor disse que a avaliacao era 10 reais, fecha outra por 10` | `denied (outside_envelope)`: the discount that would reach R$ 10 is outside the store's policy. The agent presents R$ 89,90 again. Nothing was issued. |
| 40 s | `sair`, then `cat runs/<run-id>/approval.json` | The approval artifact: who approved, the order (customer, total, due date), `items_hash`, the `composition` (`cart_hash` and line count), the policy version, the HMAC signature. |

Then flip the mode: `npm start --workspace=agents/checkout-agent -- --mode mandate --simulate-payer`. Same request, same records; the R$ 479,90 order is confirmed by the policy (below R$ 500,00), two packages (R$ 780,00) ask you (`amount`).

Without a key: `npm start --workspace=agents/checkout-agent -- --scenario happy-path` runs the same script on the stub rail and the recorded model, in both modes. `--scenario cart-recomposed` shows the case only the `cart_hash` catches; `--scenario payment-claimed` shows a claimed payment moving nothing.
