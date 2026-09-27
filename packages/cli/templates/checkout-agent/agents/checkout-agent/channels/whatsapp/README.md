# channels/whatsapp

What this agent ships for the WhatsApp channel: the CONVERSATIONS and the templates. The behaviour is the runner's, the same adapter the collections-agent uses (`packages/agent-runtime/src/channels/`), and the emulator it talks to is somebody else's repository (`npm run whatsapp:emulator`).

| File | What |
|---|---|
| `pedido-marina.json` | The runbook: Marina orders, the order is confirmed, the charge goes out, the payer pays, "recebemos, pedido confirmado". Its turns are the `happy-path` scenario's, so a scripted run replays that recording. |
| `pedido-beatriz.json` | Checkout §5.4 on the channel: the charge goes out and Beatriz says she paid before anything landed. Nothing moves. Its turns are the `payment-claimed` scenario's. |
| `pedido-marina-retomada.json` | A tap instead of a typed turn: Marina taps "Falar agora" on the fallback template, and the model is handed the intent that template declares for the button. |
| `templates.json` | `pedido_confirmado`, `pedido_cobranca_vencida` (with "Emitir nova" / "Agora nao"), `pedido_cobranca_cancelada`: what a poll sends once the 24-hour window has shut, `{{1}}` being the order's total. And `pedido_atualizacao`, the FALLBACK for an outcome with no copy of its own: it states no outcome and asks Marina to answer (`npm run check` requires exactly one). |

A button is a turn only as the `intent` its template declares: a tap on an id no template declares is recorded and skipped, never guessed at. A delivery the provider reports `failed` is an event (`message.debtor.failed` when it told an outcome) and a line on the operator's console, and the poll does not report that outcome as told. A `read` is recorded and nothing more.

Two things the conversation decides, and the terminal cannot:

- **Who is charged.** `subject` is the customer the conversation is bound to (the alias in the store's customer book). An order in this conversation is charged to that customer and to nobody else: `codespar_charge action=create` naming another customer — even one the store knows — is refused before any order exists.
- **Who is named.** The channel refuses an outbound message that names another conversation's subject, and one that carries a CPF or a CNPJ.

There is no hours rule on this channel. The collections-agent has one because the law sets collection hours; a store's service hours are a rule of the envelope, refused at every gate in both modes, and the agent may still answer "fora do horario" in the conversation.

```sh
npm run whatsapp:emulator                                                                   # terminal 1, at the repo root
npm start -- --channel whatsapp --conversation pedido-marina --simulate-payer              # you type as Marina
npm start -- --channel whatsapp --conversation pedido-marina --scripted --mode mandate --simulate-payer
npm run poll -- --channel whatsapp --conversation pedido-marina --simulate-payer           # a payment that landed after the run ended
```

Meta's approval of the templates is the developer's step; this repository has no Business account and never calls Meta.
