"""
End-to-end e-commerce checkout — the canonical Complete Loop demo.

Drives a single natural-language turn through four tools:
  codespar_checkout → codespar_invoice → codespar_ship → codespar_notify

Exactly what the dashboard's Sandbox / E-Commerce Checkout runs, just
from Python instead of the browser. Streams events so you can watch
the agent progress through each step in real time.

Usage:
    export CODESPAR_API_KEY="csk_live_..."
    python examples/ecommerce_checkout.py
"""

from __future__ import annotations

import os
import sys

from codespar import CodeSpar

PROMPT = (
    "Quero comprar o Starter Kit por R$149,00. "
    "Meu CEP é 01310-100. Pode processar tudo: "
    "checkout via Stripe, NF-e via Nuvem Fiscal, "
    "frete via Correios, e me avise pelo WhatsApp."
)


def main() -> int:
    api_key = os.environ.get("CODESPAR_API_KEY")
    if not api_key:
        print("error: set CODESPAR_API_KEY first — see dashboard.codespar.dev", file=sys.stderr)
        return 1

    with CodeSpar(
        api_key=api_key,
        project_id=os.environ.get("CODESPAR_PROJECT_ID"),
    ) as cs:
        session = cs.create("demo_user", preset="brazilian")
        try:
            print(f"→ session {session.id}")
            print(f"→ servers: {', '.join(session.servers)}\n")

            for event in session.send_stream(PROMPT):
                # Stream type is a discriminated union — pattern match
                # on the event.type literal so mypy can narrow the
                # attributes each branch touches.
                if event.type == "assistant_text":
                    print(event.content, end="", flush=True)
                elif event.type == "tool_use":
                    print(f"\n\n  → calling {event.name}")
                elif event.type == "tool_result":
                    tc = event.tool_call
                    status = "ok" if tc.status == "success" else f"error ({tc.error_code})"
                    print(f"    {status} · {tc.duration_ms}ms")
                elif event.type == "done":
                    tool_count = len(event.result.tool_calls)
                    iterations = event.result.iterations
                    print("\n\n✓ complete")
                    print(f"  {tool_count} tools · {iterations} iterations")
                elif event.type == "error":
                    print(f"\n✗ error: {event.error}", file=sys.stderr)
                    return 2
        finally:
            session.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
