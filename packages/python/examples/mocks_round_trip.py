"""
Hosted test-mode mocks round-trip (Python).

Demonstrates the two mock shapes accepted by ``cs.create(mocks=...)``:
  - static: a single MockObject returned on every matching call
  - stateful: a list of MockObject consumed in order, one per call,
    returning ``mocks_exhausted`` once the list drains

Requires a ``csk_test_*`` key against a test-environment project — live
keys against the same map return ``mocks_not_authorized``.

Usage:
    export CODESPAR_API_KEY="csk_test_..."
    # optional: target a local OSS runtime
    # export CODESPAR_BASE_URL=http://localhost:8000
    python examples/mocks_round_trip.py
"""

from __future__ import annotations

import os
import sys

from codespar import ApiError, CodeSpar, MockValue, is_mocks_exhausted

FIXTURES: dict[str, MockValue] = {
    # Static — same response every call
    "asaas/create_customer": {
        "id": "cus_test",
        "name": "Demo Buyer",
        "cpfCnpj": "11144477735",
    },
    # Stateful — consumed in order
    "asaas/create_payment": [
        {"id": "pay_1", "status": "PENDING", "value": 100},
        {"id": "pay_1", "status": "RECEIVED", "value": 100},
    ],
}


def main() -> int:
    api_key = os.environ.get("CODESPAR_API_KEY")
    if not api_key:
        print(
            "error: set CODESPAR_API_KEY first (csk_test_* recommended)",
            file=sys.stderr,
        )
        return 1

    with CodeSpar(api_key=api_key) as cs:
        try:
            session = cs.create(
                "demo_user",
                servers=["asaas"],
                mocks=FIXTURES,
            )
        except ApiError as exc:
            if exc.code == "mocks_not_authorized":
                print(
                    "error: this API key cannot use mocks. Swap to a "
                    "csk_test_* key against a test-environment project.",
                    file=sys.stderr,
                )
                return 1
            raise

        try:
            # Static mock
            customer = session.execute(
                "asaas/create_customer",
                {"name": "Demo Buyer", "cpfCnpj": "11144477735"},
            )
            print("customer:", customer.data)

            # First call into the stateful mock
            pending = session.execute(
                "asaas/create_payment",
                {"customer": "cus_test", "billingType": "PIX", "value": 100},
            )
            print("payment 1:", pending.data)

            # Second call into the stateful mock — different fixture
            received = session.execute(
                "asaas/create_payment",
                {"customer": "cus_test", "billingType": "PIX", "value": 100},
            )
            print("payment 2:", received.data)

            # Third call — list is drained
            exhausted = session.execute(
                "asaas/create_payment",
                {"customer": "cus_test", "billingType": "PIX", "value": 100},
            )
            if is_mocks_exhausted(exhausted.data):
                print("payment 3 drained the list:", exhausted.data["message"])
            else:
                print("payment 3:", exhausted.data)
        finally:
            session.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
