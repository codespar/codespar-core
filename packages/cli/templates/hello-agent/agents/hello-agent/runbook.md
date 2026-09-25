# hello-agent — the forty-second script

1. `npm install` at the repository root.
2. `npm start --workspace=agents/hello-agent`, then ask "quais contas vencem
   em outubro?". The agent calls `list_bills` and answers in reais.
3. Ask it to pay one of them: it says it has no payment tool and points at the
   `bills-agent`.
4. `npm run eval --workspace=agents/hello-agent`: seven adversarial cases and
   two scenario runs, no key, no network.
5. `runs/<run-id>/` holds what just happened, every line stamped with who acted.
