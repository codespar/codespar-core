"""
Tests for the Python create body builder's `mocks` forwarding.

Mirrors packages/core/src/__tests__/forward-mocks.test.ts. Asserts:

  - Wire-neutrality on absence (R18) — a cs.create without `mocks`
    serializes byte-identically to today's body shape.
  - Forwarded shape on presence — the mocks dict is included verbatim
    (no SDK-side rewrite of canonical names).
  - The allowed-kwargs gate accepts the new ``mocks`` keyword. The
    symmetric kwargs/positional test catches a missed gate update on
    every CI run.
  - The double-underscore key form reaches the backend unrewritten.
  - The empty dict is forwarded as ``"mocks": {}`` for parity with TS.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from pytest_httpx import HTTPXMock

from codespar import AsyncCodeSpar, ConfigError, SessionConfig

FIXTURE_PATH = Path(__file__).parent / "_fixtures" / "mocks_canonical.json"


def _session_json() -> dict[str, object]:
    return {
        "id": "ses_demo",
        "org_id": "org_demo",
        "user_id": "user_demo",
        "servers": ["asaas"],
        "status": "active",
        "created_at": "2026-05-22T12:00:00Z",
        "closed_at": None,
    }


async def test_create_omits_mocks_when_absent(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions",
        method="POST",
        json=_session_json(),
    )
    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        await cs.create("user_demo", servers=["asaas"])
    req = httpx_mock.get_request()
    assert req is not None
    body = json.loads(req.content)
    assert "mocks" not in body
    assert body == {"servers": ["asaas"], "user_id": "user_demo"}


async def test_create_forwards_mocks_via_kwargs(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions",
        method="POST",
        json=_session_json(),
    )
    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        await cs.create(
            "user_demo",
            servers=["asaas"],
            mocks={"asaas/create_payment": {"id": "pay_test_42", "status": "PENDING"}},
        )
    req = httpx_mock.get_request()
    assert req is not None
    body = json.loads(req.content)
    assert body["mocks"] == {
        "asaas/create_payment": {"id": "pay_test_42", "status": "PENDING"}
    }


async def test_create_forwards_mocks_via_session_config(
    httpx_mock: HTTPXMock,
) -> None:
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions",
        method="POST",
        json=_session_json(),
    )
    cfg = SessionConfig(
        servers=["asaas"],
        mocks={"asaas/create_payment": {"id": "pay_test_42", "status": "PENDING"}},
    )
    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        await cs.create("user_demo", cfg)
    req = httpx_mock.get_request()
    assert req is not None
    body = json.loads(req.content)
    assert body["mocks"] == {
        "asaas/create_payment": {"id": "pay_test_42", "status": "PENDING"}
    }


async def test_kwargs_and_positional_produce_byte_identical_body(
    httpx_mock: HTTPXMock,
) -> None:
    """Symmetric kwargs vs positional — if either drifts, the canonical body diverges."""
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions",
        method="POST",
        json=_session_json(),
    )
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions",
        method="POST",
        json=_session_json(),
    )
    payload = {"asaas/create_payment": {"id": "pay_test_42", "status": "PENDING"}}
    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        await cs.create("user_demo", servers=["asaas"], mocks=payload)
        await cs.create("user_demo", SessionConfig(servers=["asaas"], mocks=payload))
    reqs = httpx_mock.get_requests()
    assert len(reqs) == 2
    assert reqs[0].content == reqs[1].content


async def test_double_underscore_keys_pass_through_unrewritten(
    httpx_mock: HTTPXMock,
) -> None:
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions",
        method="POST",
        json=_session_json(),
    )
    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        await cs.create(
            "user_demo",
            servers=["asaas"],
            mocks={"asaas__create_payment": {"id": "pay_test_42"}},
        )
    req = httpx_mock.get_request()
    assert req is not None
    body = json.loads(req.content)
    assert list(body["mocks"].keys()) == ["asaas__create_payment"]


async def test_empty_mocks_dict_is_forwarded(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions",
        method="POST",
        json=_session_json(),
    )
    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        await cs.create("user_demo", servers=["asaas"], mocks={})
    req = httpx_mock.get_request()
    assert req is not None
    body = json.loads(req.content)
    assert body["mocks"] == {}


def test_canonical_body_matches_fixture() -> None:
    """The cross-language fixture stays the source of truth."""
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
    serialized = json.dumps(body, separators=(",", ":"))
    assert serialized == FIXTURE_PATH.read_text().rstrip("\n")


async def test_unknown_kwarg_still_rejected(httpx_mock: HTTPXMock) -> None:
    """Allowed-kwargs gate keeps rejecting truly unknown kwargs."""
    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        with pytest.raises(ConfigError, match="unknown keyword argument"):
            await cs.create("user_demo", servers=["asaas"], not_a_real_field=True)
