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
    ConnectionWizardOptions,
    DiscoverOptions,
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


# ── meta-tool typed wrappers ──────────────────────────────────────


def _execute_response_json(data: Any) -> dict[str, Any]:
    """The /execute response shape — wraps the meta-tool output in a
    ToolResult envelope. Matches what real-strategy returns + the
    /v1/sessions/:id/execute route serializes."""
    return {
        "success": True,
        "data": data,
        "error": None,
        "duration": 5,
        "server": "_codespar",
        "tool": "codespar_discover",
    }


async def test_session_discover_parses_recommended(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions",
        method="POST",
        json=_session_json(),
    )
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions/ses_abc123/execute",
        method="POST",
        json=_execute_response_json({
            "use_case": "send a pix payment",
            "search_strategy": "embedding",
            "recommended": {
                "server_id": "asaas",
                "tool_name": "create_payment",
                "description": "Create a Pix charge",
                "http_method": "POST",
                "endpoint_template": "/v3/payments",
                "cosine_distance": 0.18,
                "trigram_similarity": None,
                "connection_status": "connected",
                "known_pitfalls": ["Sandbox keys differ from live"],
                "recommended_plan": [
                    {"step": "validate cpf", "prereq": True},
                ],
            },
            "related": [],
            "next_steps": ["call asaas:create_payment with the inputs from its schema"],
        }),
    )
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions/ses_abc123",
        method="DELETE",
        status_code=204,
    )

    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        session = await cs.create("user_123", preset="brazilian")
        result = await session.discover("send a pix payment")
        assert result.search_strategy == "embedding"
        assert result.recommended is not None
        assert result.recommended.server_id == "asaas"
        assert result.recommended.connection_status == "connected"
        assert result.recommended.known_pitfalls == ["Sandbox keys differ from live"]
        assert len(result.recommended.recommended_plan) == 1
        assert result.recommended.recommended_plan[0].prereq is True
        assert result.next_steps[0].startswith("call asaas:")
        await session.close()


async def test_session_discover_forwards_options(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions",
        method="POST",
        json=_session_json(),
    )
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions/ses_abc123/execute",
        method="POST",
        json=_execute_response_json({
            "use_case": "x",
            "search_strategy": "trigram",
            "recommended": None,
            "related": [],
            "next_steps": [],
        }),
    )
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions/ses_abc123",
        method="DELETE",
        status_code=204,
    )

    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        session = await cs.create("user_123", preset="brazilian")
        await session.discover(
            "x",
            DiscoverOptions(category="payments", country="BR", limit=3),
        )
        await session.close()

    exec_call = next(
        r for r in httpx_mock.get_requests() if r.url.path.endswith("/execute")
    )
    body = json.loads(exec_call.content)
    assert body["tool"] == "codespar_discover"
    assert body["input"] == {
        "use_case": "x",
        "category": "payments",
        "country": "BR",
        "limit": 3,
    }


async def test_session_connection_wizard_initiate(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions",
        method="POST",
        json=_session_json(),
    )
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions/ses_abc123/execute",
        method="POST",
        json=_execute_response_json({
            "action": "initiate",
            "connections": [],
            "status": None,
            "initiate": {
                "server_id": "z-api",
                "display_name": "Z-API",
                "auth_type": "path_secret",
                "difficulty": "hard",
                "status": "disconnected",
                "connect_url": "https://app.codespar.dev/dashboard/auth-configs?connect=z-api",
                "instructions": ["Open the connect link"],
                "required_secrets": [
                    {"name": "instance_id", "hint": "z-api.instance_id"},
                    {"name": "instance_token", "hint": "z-api.instance_token"},
                ],
                "known_pitfalls": [],
                "next_action": "After the user connects, retry the original request",
            },
        }),
    )
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions/ses_abc123",
        method="DELETE",
        status_code=204,
    )

    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        session = await cs.create("user_123", preset="brazilian")
        result = await session.connection_wizard(
            ConnectionWizardOptions(action="initiate", server_id="z-api"),
        )
        assert result.action == "initiate"
        assert result.initiate is not None
        assert result.initiate.server_id == "z-api"
        assert result.initiate.difficulty == "hard"
        assert len(result.initiate.required_secrets) == 2
        assert result.initiate.required_secrets[0].name == "instance_id"
        await session.close()


async def test_session_payment_status_succeeded(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions",
        method="POST",
        json=_session_json(),
    )
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/tool-calls/tc_42/payment-status",
        method="GET",
        json={
            "tool_call_id": "tc_42",
            "payment_status": "succeeded",
            "idempotency_key": "11111111-1111-1111-1111-111111111111",
            "original_status": "success",
            "events": [
                {
                    "event_type": "commerce.payment.succeeded",
                    "received_at": "2026-05-02T10:00:00Z",
                    "provider": "asaas",
                    "provider_action": "PAYMENT_RECEIVED",
                    "payment_id": "pay_xyz",
                },
            ],
        },
    )
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions/ses_abc123",
        method="DELETE",
        status_code=204,
    )

    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        session = await cs.create("user_123", preset="brazilian")
        result = await session.payment_status("tc_42")
        assert result.payment_status == "succeeded"
        assert result.idempotency_key == "11111111-1111-1111-1111-111111111111"
        assert len(result.events) == 1
        assert result.events[0].provider == "asaas"
        await session.close()


async def test_session_verification_status_approved(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions",
        method="POST",
        json=_session_json(),
    )
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/tool-calls/tc_99/verification-status",
        method="GET",
        json={
            "tool_call_id": "tc_99",
            "verification_status": "approved",
            "idempotency_key": "22222222-2222-2222-2222-222222222222",
            "original_status": "success",
            "hosted_url": "https://withpersona.com/verify?inquiry-id=inq_demo",
            "events": [
                {
                    "event_type": "commerce.kyc.approved",
                    "received_at": "2026-05-02T10:05:00Z",
                    "provider": "persona",
                    "verification_id": "inq_demo",
                },
            ],
        },
    )
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions/ses_abc123",
        method="DELETE",
        status_code=204,
    )

    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        session = await cs.create("user_123", preset="brazilian")
        result = await session.verification_status("tc_99")
        assert result.verification_status == "approved"
        assert result.idempotency_key == "22222222-2222-2222-2222-222222222222"
        assert result.hosted_url == "https://withpersona.com/verify?inquiry-id=inq_demo"
        assert len(result.events) == 1
        assert result.events[0].provider == "persona"
        assert result.events[0].verification_id == "inq_demo"
        await session.close()


async def test_session_discover_raises_on_error_envelope(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions",
        method="POST",
        json=_session_json(),
    )
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions/ses_abc123/execute",
        method="POST",
        json={
            "success": False,
            "data": None,
            "error": "no_eligible_providers",
            "duration": 1,
            "server": "",
            "tool": "codespar_discover",
        },
    )
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions/ses_abc123",
        method="DELETE",
        status_code=204,
    )

    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        session = await cs.create("user_123", preset="brazilian")
        with pytest.raises(ApiError, match="no_eligible_providers"):
            await session.discover("anything")
        await session.close()
