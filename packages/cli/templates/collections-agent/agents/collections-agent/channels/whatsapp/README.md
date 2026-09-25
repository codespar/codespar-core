# channels/whatsapp

What this agent ships for the WhatsApp channel: the CONVERSATIONS. One JSON
file each, and the file is the whole thing a runner cannot know — which
number, which debtor, which agreement, and what the person said.

The behaviour is the runner's, in
[`packages/agent-runtime/src/channels/`](../../../../packages/agent-runtime/src/channels):
the adapter, the rules, the Cloud API backend. Nothing about WhatsApp lives
here, and the emulator the backend talks to is somebody else's repository
(`npm run whatsapp:emulator`).

## One file

```json
{
  "name": "acordo-1042",
  "description": "what this conversation is",
  "channel": "whatsapp",
  "contact": "+5511987654321",
  "subject": "acordo-1042",
  "turns": [{ "text": "oi, recebi a mensagem sobre o acordo do pedido 1042" }]
}
```

`contact` is the only number this conversation may reach: the channel refuses
an outbound message addressed anywhere else, which is how the debt stays
between the store and the person who owes it. `subject` is the only agreement
it may name, which is the same rule in the other direction. `turns` are the
PERSON's, and only the person's — what the agent answers comes from the model
or from a recorded transcript, never from here, for the same reason a scenario
pack asserts a final state rather than a wording.

`name` must match the file name, and `npm run check` fails on a file that no
longer parses, on a declared channel with no conversation, and on a
conversation the manifest does not declare.

## And one file that is not a conversation

`templates.json` is the reserved name in this directory: the LOCAL registry of
the templates this agent sends. A conversation therefore cannot be called
`templates`.

```json
{
  "channel": "whatsapp",
  "templates": [
    {
      "name": "acordo_quitado",
      "language": "pt_BR",
      "description": "what this template is for and what {{1}} means",
      "body": "Oi! Recebemos o pagamento do {{1}} e ele esta quitado. Obrigado!"
    }
  ]
}
```

Outside the 24 hours that follow the person's last message WhatsApp carries an
approved template and nothing else, so an agent that ever speaks after that —
and a collections agent does it constantly, because the debtor agrees on
Tuesday and pays on Friday — has to own one per outcome. `npm run poll --
--channel whatsapp` is what sends them; `src/kit.ts` maps an outcome to a name
in `outcomeTemplate`, and the language comes from here rather than from the
kit, so there is one source for it.

What this file PROVES is narrow and worth stating exactly: the agent declared
the name, so a send of a name nobody declared is refused here instead of
400-ing at Meta, along with a language the template was not registered in and a
variable count the body has no placeholders for. Whether **Meta approved it**
is a status inside a Business account and is not knowable from this repository.
Registering the template and getting it approved is yours. `body` is here for a
reader — nothing composes a message from it, Meta holds the approved copy — but
its `{{n}}` placeholders are counted, and `npm run check` refuses a body that
skips a number.

## The numbers and the people here are fixtures

Like `src/agreements.ts`. `+5511987654321` reaches nobody, Joana Ribeiro is
invented, and the documents in the book have valid check digits because the
clearing house validates them. Never put a real contact or a real document in
one of these files: they are committed, and the simulator does not need one.

## Running it

```sh
npm run whatsapp:emulator                                               # once, at the repo root
npm start -- --channel whatsapp --conversation acordo-1042              # you type as Joana
npm start -- --channel whatsapp --conversation acordo-1042 --scripted   # the turns above, replayed
npm start -- --channel whatsapp --conversation acordo-1103 --scripted --payer expires
```

`--conversation` is required: this agent ships two, and which person you are
messaging is not a default. `acordo-1042` ends paid; `acordo-1103` is the other
ending, where nobody pays and the charge expires.

To close a cycle whose payment landed after the run ended — the ordinary case,
and the one the commands above cannot reach:

```sh
npm run poll -- --channel whatsapp --conversation acordo-1042
```

It resumes the conversation from the bundle plus `state.db` and confirms the
outcome: free-form while the 24-hour window is open, an approved template from
`templates.json` once it has shut.

The default backend is the local Cloud API emulator: no Meta account, no
credential, nothing leaving the machine. `npm run whatsapp:gate` at the
repository root runs the whole cycle over it three times from a clean state
and asserts the final state each time, plus a fourth run that agrees now, moves
the conversation's clock past 24 hours, pays, and polls.
