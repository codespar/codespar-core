"""
Same Pix flow as ``pix_payment.py``, but with ``AsyncCodeSpar`` —
the canonical shape for FastAPI, LangChain, or anything already on
asyncio. The SDK's async client is the primary implementation; the
sync ``CodeSpar`` is a thin wrapper on top.

Usage:
    export CODESPAR_API_KEY="csk_live_..."
    python examples/async_basic.py
"""

from __future__ import annotations

import asyncio
import os
import sys

from codespar import AsyncCodeSpar

PROMPT = "Crie um Pix de R$200 e envie o QR code para +5511999887766."


async def run() -> int:
    api_key = os.environ.get("CODESPAR_API_KEY")
    if not api_key:
        print("error: set CODESPAR_API_KEY first", file=sys.stderr)
        return 1

    async with AsyncCodeSpar(api_key=api_key) as cs:
        session = await cs.create("demo_user", preset="brazilian")
        try:
            async for event in session.send_stream(PROMPT):
                if event.type == "assistant_text":
                    print(event.content, end="", flush=True)
                elif event.type == "tool_use":
                    print(f"\n→ {event.name}")
                elif event.type == "done":
                    print(f"\n✓ done · {event.result.iterations} iterations")
        finally:
            await session.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(run()))
