"""
The Python create body builder's ``agent_id`` forwarding (enterprise 0274,
codespar-enterprise#1688). Mirrors packages/core/src/__tests__/forward-agent-id.test.ts.

  - Without ``agent_id`` the body is byte-identical to before.
  - With it, the handle goes out as ``agent_id``, separate from ``user_id``,
    through kwargs and through ``SessionConfig`` alike.
"""

from __future__ import annotations

import json

from pytest_httpx import HTTPXMock

from codespar import AsyncCodeSpar, SessionConfig


def _session_json() -> dict[str, object]:
    return {
        "id": "ses_demo",
        "org_id": "org_demo",
        "user_id": "user_demo",
        "servers": ["asaas"],
        "status": "active",
        "created_at": "2026-09-25T12:00:00Z",
        "closed_at": None,
    }


def _add(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions", method="POST", json=_session_json()
    )


async def test_create_omits_agent_id_when_absent(httpx_mock: HTTPXMock) -> None:
    _add(httpx_mock)
    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        await cs.create("user_demo", servers=["asaas"])
    body = json.loads(httpx_mock.get_request().content)
    assert body == {"servers": ["asaas"], "user_id": "user_demo"}


async def test_create_forwards_agent_id_via_kwargs(httpx_mock: HTTPXMock) -> None:
    _add(httpx_mock)
    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        await cs.create("user_demo", servers=["asaas"], agent_id="ag_curb")
    body = json.loads(httpx_mock.get_request().content)
    assert body == {"servers": ["asaas"], "user_id": "user_demo", "agent_id": "ag_curb"}


async def test_create_forwards_agent_id_via_config(httpx_mock: HTTPXMock) -> None:
    _add(httpx_mock)
    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        await cs.create("user_demo", SessionConfig(servers=["asaas"], agent_id="ag_curb"))
    body = json.loads(httpx_mock.get_request().content)
    assert body["agent_id"] == "ag_curb"
    assert body["user_id"] == "user_demo"
