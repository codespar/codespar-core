"""
Minimal Pix example — create a charge, send the QR code via WhatsApp.

Uses ``send`` (blocking) instead of ``send_stream`` because this flow
is short enough that streaming would be overkill; you get the full
transcript back in one call.

Usage:
    export CODESPAR_API_KEY="csk_live_..."
    python examples/pix_payment.py
"""

from __future__ import annotations

import os
import sys

from codespar import CodeSpar

PROMPT = (
    "Crie uma cobrança Pix de R$500,00 e envie o QR code "
    "pelo WhatsApp para +5511999887766."
)


def main() -> int:
    api_key = os.environ.get("CODESPAR_API_KEY")
    if not api_key:
        print("error: set CODESPAR_API_KEY first", file=sys.stderr)
        return 1

    with CodeSpar(api_key=api_key) as cs:
        session = cs.create("demo_user", preset="brazilian")
        try:
            result = session.send(PROMPT)
            print(result.message)
            print(f"\n{len(result.tool_calls)} tools called over {result.iterations} iterations:")
            for tc in result.tool_calls:
                marker = "✓" if tc.status == "success" else "✗"
                print(f"  {marker} {tc.tool_name} · {tc.server_id} · {tc.duration_ms}ms")
        finally:
            session.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
