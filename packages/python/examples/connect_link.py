"""
Connect Links example — generate the OAuth URL your end user opens
to grant provider access. CodeSpar stores the tokens in the
per-project vault once the user completes the flow, then forwards
them back to ``redirect_uri`` with ``?status=connected`` appended.

Usage:
    export CODESPAR_API_KEY="csk_live_..."
    python examples/connect_link.py
"""

from __future__ import annotations

import os
import sys

from codespar import AuthConfig, CodeSpar


def main() -> int:
    api_key = os.environ.get("CODESPAR_API_KEY")
    if not api_key:
        print("error: set CODESPAR_API_KEY first", file=sys.stderr)
        return 1

    with CodeSpar(api_key=api_key) as cs:
        session = cs.create("demo_user", servers=["stripe-acp"])
        try:
            link = session.authorize(
                "stripe-acp",
                AuthConfig(
                    redirect_uri="https://your-app.example/connected",
                ),
            )
            print("Open this URL to connect Stripe:")
            print(f"  {link.authorize_url}")
            print(f"\nLink token: {link.link_token}")
            print(f"Expires at: {link.expires_at}")
        finally:
            session.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
