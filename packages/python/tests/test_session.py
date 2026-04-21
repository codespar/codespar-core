"""
End-to-end tests against a mocked backend using pytest-httpx.

Covers the full lifecycle: create → send → close. Also covers the
project_id header precedence (client default vs per-session override)
since that's the easiest place for a regression to slip in.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from pytest_httpx import HTTPXMock

from codespar import (
    ApiError,
    AsyncCodeSpar,
    AuthConfig,
    ProxyRequest,
)


def _session_json(**overrides: Any) -> dict[str, Any]:
    return {
        "id": "ses_abc123",
        "org_id": "org_test",
        "user_id": "user_123",
        "servers": ["zoop", "nuvem-fiscal"],
        "status": "active",
        "created_at": "2026-04-21T12:00:00Z",
        "closed_at": None,
        **overrides,
    }


async def test_create_session_uses_preset(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions",
        method="POST",
        json=_session_json(servers=["zoop", "nuvem-fiscal", "melhor-envio", "z-api", "omie"]),
    )

    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        session = await cs.create("user_123", preset="brazilian")

    assert session.id == "ses_abc123"
    assert session.user_id == "user_123"
    assert "omie" in session.servers

    request = httpx_mock.get_request()
    assert request is not None
    assert json.loads(request.content) == {
        "servers": ["zoop", "nuvem-fiscal", "melhor-envio", "z-api", "omie"],
        "user_id": "user_123",
    }
    assert request.headers["Authorization"] == "Bearer csk_test_x"
    # No project_id set on client or session → header absent
    assert "x-codespar-project" not in request.headers


async def test_client_level_project_id_is_sent(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions",
        method="POST",
        json=_session_json(),
    )

    async with AsyncCodeSpar(
        api_key="csk_test_x", project_id="prj_0123456789abcdef"
    ) as cs:
        await cs.create("user_123", preset="brazilian")

    request = httpx_mock.get_request()
    assert request is not None
    assert request.headers["x-codespar-project"] == "prj_0123456789abcdef"


async def test_session_level_project_id_wins(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions",
        method="POST",
        json=_session_json(),
    )

    async with AsyncCodeSpar(
        api_key="csk_test_x", project_id="prj_clientlevel000000"
    ) as cs:
        await cs.create("user_123", preset="brazilian", project_id="prj_sessionlevel00000")

    request = httpx_mock.get_request()
    assert request is not None
    # session override wins
    assert request.headers["x-codespar-project"] == "prj_sessionlevel00000"


async def test_send_returns_tool_calls(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions",
        method="POST",
        json=_session_json(),
    )
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions/ses_abc123/send",
        method="POST",
        json={
            "message": "Charged R$500 via Pix.",
            "tool_calls": [
                {
                    "id": "tc_1",
                    "tool_name": "codespar_pay",
                    "server_id": "asaas",
                    "status": "success",
                    "duration_ms": 412,
                    "input": {"amount": 500},
                    "output": {"id": "pix_1"},
                    "error_code": None,
                }
            ],
            "iterations": 1,
        },
    )

    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        session = await cs.create("user_123", preset="brazilian")
        result = await session.send("charge R$500 via Pix")

    assert result.message == "Charged R$500 via Pix."
    assert result.iterations == 1
    assert len(result.tool_calls) == 1
    assert result.tool_calls[0].tool_name == "codespar_pay"
    assert result.tool_calls[0].status == "success"


async def test_api_error_exposes_status_and_code(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions",
        method="POST",
        status_code=400,
        json={"error": "unknown_servers", "unknown": ["stripe"]},
    )

    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        with pytest.raises(ApiError) as excinfo:
            await cs.create("user_123", servers=["stripe"])

    assert excinfo.value.status == 400
    assert excinfo.value.code == "unknown_servers"


async def test_proxy_execute_passes_body_through(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions",
        method="POST",
        json=_session_json(),
    )
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions/ses_abc123/proxy_execute",
        method="POST",
        json={
            "status": 200,
            "data": {"id": "pix_1"},
            "headers": {"content-type": "application/json"},
            "duration": 180,
            "proxy_call_id": "pc_1",
        },
    )

    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        session = await cs.create("user_123", preset="brazilian")
        out = await session.proxy_execute(
            ProxyRequest(
                server="asaas",
                endpoint="/v3/payments",
                method="POST",
                body={"value": 500, "billingType": "PIX"},
            )
        )

    assert out.status == 200
    assert out.duration == 180
    assert out.proxy_call_id == "pc_1"

    # Verify the proxy POST body forwarded our payload verbatim
    all_requests = httpx_mock.get_requests()
    proxy_request = next(
        r for r in all_requests if r.url.path.endswith("/proxy_execute")
    )
    assert json.loads(proxy_request.content) == {
        "server": "asaas",
        "endpoint": "/v3/payments",
        "method": "POST",
        "body": {"value": 500, "billingType": "PIX"},
        "params": None,
        "headers": None,
    }


async def test_authorize_maps_snake_to_camel(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions",
        method="POST",
        json=_session_json(),
    )
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/connect/start",
        method="POST",
        json={
            "link_token": "lnk_abc",
            "authorize_url": "https://stripe.com/connect/oauth/...",
            "expires_at": "2026-04-21T13:00:00Z",
        },
    )

    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        session = await cs.create("user_123", preset="brazilian")
        link = await session.authorize(
            "stripe-acp",
            AuthConfig(redirect_uri="https://example.com/connected"),
        )

    assert link.link_token == "lnk_abc"
    assert link.authorize_url.startswith("https://stripe.com/")
    assert link.expires_at.startswith("2026-04-21")


async def test_close_is_idempotent_on_error(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions",
        method="POST",
        json=_session_json(),
    )
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions/ses_abc123",
        method="DELETE",
        status_code=404,  # already gone
    )

    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        session = await cs.create("user_123", preset="brazilian")
        # Should NOT raise — close swallows 4xx/5xx because the backend
        # cleans up stale sessions on a timer and we're best-effort here.
        await session.close()
