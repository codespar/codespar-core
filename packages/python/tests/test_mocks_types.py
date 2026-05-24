"""
Wire-shape parity test for the test-mode mocks field.

Mirror of packages/core/src/__tests__/mocks-wire-parity.test.ts. Both
SDKs must serialize the same canonical example to byte-identical JSON;
the shared fixture at tests/_fixtures/mocks_canonical.json is the
source of truth.

The MockObject + MockValue type aliases land on the Python side as
``TypeAlias``-style declarations in ``codespar.types``. The
SessionConfig dataclass gains an optional ``mocks`` field of shape
``dict[str, MockValue] | None``.
"""

from __future__ import annotations

import json
from pathlib import Path

from codespar import SessionConfig
from codespar.types import MockObject, MockValue

FIXTURE_PATH = Path(__file__).parent / "_fixtures" / "mocks_canonical.json"


def test_mock_object_accepts_plain_dict() -> None:
    obj: MockObject = {"id": "pay_test_42", "status": "PENDING"}
    assert obj["id"] == "pay_test_42"


def test_mock_value_accepts_single_object() -> None:
    v: MockValue = {"id": "pay_test_42", "status": "PENDING"}
    assert isinstance(v, dict)


def test_mock_value_accepts_object_list() -> None:
    v: MockValue = [
        {"id": "pay_test_42", "status": "PENDING"},
        {"id": "pay_test_42", "status": "CONFIRMED"},
    ]
    assert isinstance(v, list)
    assert len(v) == 2


def test_session_config_carries_optional_mocks() -> None:
    cfg = SessionConfig(servers=["asaas"])
    assert cfg.mocks is None


def test_session_config_accepts_canonical_mocks() -> None:
    cfg = SessionConfig(
        servers=["asaas"],
        mocks={
            "asaas/create_payment": {"id": "pay_test_42", "status": "PENDING"},
            "asaas/get_payment": [
                {"id": "pay_test_42", "status": "PENDING"},
                {"id": "pay_test_42", "status": "CONFIRMED"},
            ],
        },
    )
    assert cfg.mocks is not None
    assert cfg.mocks["asaas/create_payment"] == {
        "id": "pay_test_42",
        "status": "PENDING",
    }


def test_canonical_fixture_matches_python_serialization() -> None:
    """Round-trip the canonical body and confirm byte-identical output."""
    body = {
        "servers": ["asaas"],
        "user_id": "user_demo",
        "mocks": {
            "asaas/create_payment": {"id": "pay_test_42", "status": "PENDING"},
            "asaas/get_payment": [
                {"id": "pay_test_42", "status": "PENDING"},
                {"id": "pay_test_42", "status": "CONFIRMED"},
            ],
        },
    }
    # separators=(',', ':') matches JS JSON.stringify's compact output —
    # the SDK uses this same delimiter set for the production body
    # builder (see _async_client.py).
    serialized = json.dumps(body, separators=(",", ":"))
    expected = FIXTURE_PATH.read_text().rstrip("\n")
    assert serialized == expected
