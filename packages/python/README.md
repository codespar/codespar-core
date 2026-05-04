# codespar — Python SDK

Commerce infrastructure for AI agents in Latin America. Pix, NF-e,
WhatsApp, shipping, banking — one API, no provider-key boilerplate.

[![PyPI](https://img.shields.io/pypi/v/codespar.svg)](https://pypi.org/project/codespar/)
[![Python versions](https://img.shields.io/pypi/pyversions/codespar.svg)](https://pypi.org/project/codespar/)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/codespar/codespar/blob/main/LICENSE)

## Install

```bash
pip install codespar
```

Python 3.10+ required.

## Quick start

```python
from codespar import CodeSpar

cs = CodeSpar(api_key="csk_live_...")

session = cs.create(
    "user_123",
    preset="brazilian",   # zoop, nuvem-fiscal, melhor-envio, z-api, omie
    # project_id="prj_...", # optional — defaults to the org's default project
)

result = session.send(
    "Charge R$500 via Pix to +5511999887766 and send the QR code by WhatsApp."
)
print(result.message)
for call in result.tool_calls:
    print(f"  → {call.tool_name} ({call.duration_ms}ms)")

session.close()
cs.close()
```

Or as a context manager:

```python
with CodeSpar(api_key="csk_live_...") as cs:
    session = cs.create("user_123", preset="brazilian")
    print(session.send("Quero pagar R$125 via Pix").message)
```

## Tool discovery + connection wizard

Beyond `session.execute(tool, params)`, the SDK exposes typed wrappers
for the F3.M2 meta-tools `codespar_discover` and
`codespar_manage_connections`:

```python
from codespar import CodeSpar, ConnectionWizardOptions, DiscoverOptions

with CodeSpar(api_key="csk_live_...") as cs:
    session = cs.create("user_123", preset="brazilian")

    # Find the right tool for a free-form use case.
    found = session.discover(
        "send a pix payment",
        DiscoverOptions(country="BR", limit=3),
    )
    if found.recommended:
        print(found.recommended.server_id, found.recommended.tool_name)
        print(f"  status: {found.recommended.connection_status}")

    # Surface the connection wizard if the recommended server isn't
    # connected. NEVER pass credentials through this method —
    # credentials only travel via the dashboard's connect modal or
    # the OAuth callback. The wizard returns a deep-link the agent
    # surfaces so the user finishes setup in their browser.
    if found.recommended and found.recommended.connection_status == "disconnected":
        wiz = session.connection_wizard(
            ConnectionWizardOptions(
                action="initiate",
                server_id=found.recommended.server_id,
            ),
        )
        if wiz.initiate:
            print("Connect:", wiz.initiate.connect_url)
            for line in wiz.initiate.instructions:
                print(" ·", line)
```

Async users have the same surface on `AsyncSession`
(`await session.discover(...)`, `await session.connection_wizard(...)`).

## Streaming

```python
for event in session.send_stream("Process order #BR-7721"):
    if event.type == "assistant_text":
        print(event.content, end="", flush=True)
    elif event.type == "tool_use":
        print(f"\n→ calling {event.name}...")
    elif event.type == "tool_result":
        print(f"  {event.tool_call.status} in {event.tool_call.duration_ms}ms")
```

## Async

```python
import asyncio
from codespar import AsyncCodeSpar

async def main():
    async with AsyncCodeSpar(api_key="csk_live_...") as cs:
        session = await cs.create("user_123", preset="brazilian")
        result = await session.send("charge R$500 via Pix")
        print(result.message)
        await session.close()

asyncio.run(main())
```

## Multi-environment (projects)

CodeSpar scopes every session to an environment (`prj_<id>`). Pass a
project id on the client for the whole lifetime, or per-session when
you want to target a different environment:

```python
# Pin every session this client spawns to the staging project
cs = CodeSpar(api_key="csk_live_...", project_id="prj_staging0123abcd")

# Override per session
session = cs.create("user_123", preset="brazilian", project_id="prj_prod0123abcd")
```

When you omit `project_id`, CodeSpar routes to the org's **default
project** — always defined, self-healed on first read.

## Raw HTTP proxy

Skip the agent loop and hit a provider API directly through CodeSpar's
credential vault:

```python
from codespar import ProxyRequest

response = session.proxy_execute(ProxyRequest(
    server="stripe-acp",
    endpoint="/v1/charges",
    method="POST",
    body={"amount": 2000, "currency": "brl"},
))
print(response.status, response.data)
```

No API key leaves your machine — CodeSpar injects it server-side.

## Connect Links (OAuth)

```python
from codespar import AuthConfig

link = session.authorize(
    "stripe-acp",
    AuthConfig(redirect_uri="https://your.app/connected"),
)
print(f"Open this URL to connect Stripe: {link.authorize_url}")
```

After the user completes the OAuth flow, CodeSpar stores the tokens in
the per-project vault and forwards them back to `redirect_uri` with
`?status=connected&connection_id=<id>` appended.

## Errors

Every failure is wrapped:

```python
from codespar import ApiError, ConfigError, StreamError

try:
    session = cs.create("user_123", preset="brazilian")
except ConfigError as exc:
    print(f"Bad config: {exc}")
except ApiError as exc:
    print(f"Backend said {exc.status}: {exc.code}")
```

## Design parity with the JS SDK

This package mirrors [`@codespar/sdk`](https://www.npmjs.com/package/@codespar/sdk)
method-for-method. Same backend, same payloads, same preset names — pick
the language that fits your stack without giving anything up.

## Need more?

Need governance, budget limits, and audit trails for agent payments? **[CodeSpar Enterprise](https://codespar.dev/enterprise)** adds policy engine, payment routing, and compliance templates on top of these MCP servers.

## Links

- [Documentation](https://docs.codespar.dev)
- [Dashboard](https://dashboard.codespar.dev)
- [JS SDK (npm)](https://www.npmjs.com/package/@codespar/sdk)
- [Report a bug](https://github.com/codespar/codespar/issues)
