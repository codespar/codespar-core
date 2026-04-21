"""
Raw HTTP proxy example — bypass the agent loop and call a provider
endpoint directly through CodeSpar's credential vault.

CodeSpar injects the Stripe API key server-side; your code never
sees it. Same pattern works for every connected server — swap
``server="stripe-acp"`` for ``"asaas"``, ``"nuvem-fiscal"``, etc.

Usage:
    export CODESPAR_API_KEY="csk_live_..."
    python examples/proxy_execute.py
"""

from __future__ import annotations

import json
import os
import sys

from codespar import CodeSpar, ProxyRequest


def main() -> int:
    api_key = os.environ.get("CODESPAR_API_KEY")
    if not api_key:
        print("error: set CODESPAR_API_KEY first", file=sys.stderr)
        return 1

    with CodeSpar(api_key=api_key) as cs:
        session = cs.create("demo_user", servers=["stripe-acp"])
        try:
            response = session.proxy_execute(
                ProxyRequest(
                    server="stripe-acp",
                    endpoint="/v1/charges",
                    method="POST",
                    body={
                        "amount": 14900,  # R$149.00 in cents
                        "currency": "brl",
                        "description": "Starter Kit",
                    },
                )
            )
            print(f"HTTP {response.status} · {response.duration}ms")
            print(json.dumps(response.data, indent=2, ensure_ascii=False))
        finally:
            session.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
