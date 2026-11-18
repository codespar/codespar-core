"""
codespar_card Python parity tests (enterprise CONTRATO-codespar-card §3-§6).

Same answers as the TS ``packages/core/src/__tests__/card.test.ts``: issued,
pending, card view, list, refusal inside the tool envelope, refusal as a
non-2xx body, failure with no code. Driven over a mocked backend through the
real ``session.card(...)`` (async and sync).
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from pytest_httpx import HTTPXMock

from codespar import (
    ApiError,
    AsyncCodeSpar,
    CardArgs,
    CardContractMigrationError,
    CardFailed,
    CardIssued,
    CardList,
    CardPendingHuman,
    CardProcessing,
    CardRefusal,
    CardUncertain,
    CardView,
    CodeSpar,
    IssueArgs,
)

BASE = "https://api.codespar.dev"
EXECUTE = f"{BASE}/v1/sessions/ses_card/execute"

RAIN_VIEW: dict[str, Any] = {
    "id": "rcrd_abc",
    "issuer": "rain",
    "program": "rain_usd",
    "currency": "USD",
    "status": "not_activated",
    "issuer_status": "notActivated",
    "last4": "1234",
    "network": None,
    "mandate_id": "mnd_usd",
    "consumer_id": "cons_1",
    "created_at": "2026-11-18T12:00:00.000Z",
    "available_actions": [],
    "funding": {"asset": "USDC"},
}

ISSUE_USD = CardArgs(
    action="issue",
    currency="USD",
    mandate_id="mnd_usd",
    consumer_id="cons_1",
    idempotency_key="idem_1",
)


def _issued(card: dict[str, Any]) -> dict[str, Any]:
    return {
        "state": "issued",
        "issue_request_id": "cir_1",
        "issuer": card["issuer"],
        "program": card["program"],
        "selection": {"provider_requested": None, "chosen_by": "currency"},
        "card": card,
        "authorization_id": "caia_1",
        "authorization_active": True,
    }


def _session_json() -> dict[str, Any]:
    return {
        "id": "ses_card",
        "org_id": "org_test",
        "user_id": "consumer_123",
        "servers": [],
        "status": "active",
        "created_at": "2026-11-18T12:00:00Z",
        "closed_at": None,
    }


def _envelope(data: Any, *, success: bool = True, error: str | None = None) -> dict[str, Any]:
    return {
        "success": success,
        "data": data,
        "error": error,
        "duration": 5,
        "server": "_codespar",
        "tool": "codespar_card",
    }


def _mock_session(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(url=f"{BASE}/v1/sessions", method="POST", json=_session_json())


def _sent(httpx_mock: HTTPXMock) -> dict[str, Any]:
    req = next(r for r in httpx_mock.get_requests() if r.url.path.endswith("/execute"))
    body: dict[str, Any] = json.loads(req.content)
    return body


@pytest.mark.asyncio
async def test_issue_dispatches_codespar_card_and_returns_issued(httpx_mock: HTTPXMock) -> None:
    _mock_session(httpx_mock)
    httpx_mock.add_response(
        url=EXECUTE,
        method="POST",
        json=_envelope(_issued(RAIN_VIEW)),
    )
    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        session = await cs.create("consumer_123", servers=[])
        result = await session.card(ISSUE_USD)

    assert isinstance(result, CardIssued)
    assert result.state == "issued"
    assert (result.card.id, result.issuer, result.program, result.card.currency) == (
        "rcrd_abc",
        "rain",
        "rain_usd",
        "USD",
    )
    assert result.card.status == "not_activated"
    assert result.card.issuer_status == "notActivated"
    assert result.card.available_actions == []
    assert result.card.network is None
    assert result.card.funding is not None and result.card.funding.asset == "USDC"
    assert result.authorization_id == "caia_1"
    assert result.authorization_active is True
    assert result.selection is not None
    assert result.selection.chosen_by == "currency"
    assert result.selection.provider_requested is None
    assert result.issue_request_id == "cir_1"

    body = _sent(httpx_mock)
    assert body["tool"] == "codespar_card"
    assert body["input"] == {
        "action": "issue",
        "currency": "USD",
        "mandate_id": "mnd_usd",
        "consumer_id": "cons_1",
        "idempotency_key": "idem_1",
    }


@pytest.mark.asyncio
async def test_issue_pending_returns_pending_action(httpx_mock: HTTPXMock) -> None:
    _mock_session(httpx_mock)
    httpx_mock.add_response(
        url=EXECUTE,
        method="POST",
        json=_envelope(
            {
                "state": "pending_human",
                "issue_request_id": "cir_2",
                "issuer": "pomelo",
                "program": "pomelo_brl",
                "pending_action": {
                    "id": "pa_1",
                    "kind": "authorize_automated_issuance",
                    "actor": "company_signatory",
                    "url": "https://codespar.dev/dashboard/x",
                },
            }
        ),
    )
    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        session = await cs.create("consumer_123", servers=[])
        result = await session.card(
            CardArgs(
                action="issue",
                currency="BRL",
                provider="pomelo",
                mandate_id="m",
                consumer_id="c",
                idempotency_key="k",
            )
        )
    assert isinstance(result, CardPendingHuman)
    assert result.state == "pending_human"
    assert result.issue_request_id == "cir_2"
    assert result.pending_action.kind == "authorize_automated_issuance"
    assert result.pending_action.actor == "company_signatory"
    assert result.pending_action.url == "https://codespar.dev/dashboard/x"
    assert _sent(httpx_mock)["input"]["provider"] == "pomelo"


@pytest.mark.asyncio
async def test_issue_without_idempotency_key_sends_nothing(httpx_mock: HTTPXMock) -> None:
    _mock_session(httpx_mock)
    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        session = await cs.create("consumer_123", servers=[])
        with pytest.raises(ApiError, match="idempotency_key is required"):
            await session.card(
                CardArgs(action="issue", currency="BRL", mandate_id="m", consumer_id="c")
            )
    assert not any(r.url.path.endswith("/execute") for r in httpx_mock.get_requests())


@pytest.mark.asyncio
async def test_get_returns_card_view(httpx_mock: HTTPXMock) -> None:
    _mock_session(httpx_mock)
    httpx_mock.add_response(url=EXECUTE, method="POST", json=_envelope(RAIN_VIEW))
    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        session = await cs.create("consumer_123", servers=[])
        result = await session.card(CardArgs(action="get", card_id="rcrd_abc"))
    assert type(result) is CardView
    assert result.id == "rcrd_abc"
    assert _sent(httpx_mock)["input"] == {"action": "get", "card_id": "rcrd_abc"}


@pytest.mark.asyncio
async def test_list_returns_cards(httpx_mock: HTTPXMock) -> None:
    _mock_session(httpx_mock)
    httpx_mock.add_response(url=EXECUTE, method="POST", json=_envelope({"cards": [RAIN_VIEW]}))
    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        session = await cs.create("consumer_123", servers=[])
        result = await session.card(CardArgs(action="list", issuer="rain"))
    assert isinstance(result, CardList)
    assert [c.id for c in result.cards] == ["rcrd_abc"]
    assert _sent(httpx_mock)["input"] == {"action": "list", "issuer": "rain"}


@pytest.mark.asyncio
async def test_envelope_refusal_is_returned_with_details(httpx_mock: HTTPXMock) -> None:
    _mock_session(httpx_mock)
    programs = [
        {"program": "pomelo_brl", "issuer": "pomelo", "currency": "BRL", "available": True},
        {
            "program": "rain_usd",
            "issuer": "rain",
            "currency": "USD",
            "available": False,
            "reason": "live_blocked",
            "operations": ["issue", "get", "list"],
        },
    ]
    httpx_mock.add_response(
        url=EXECUTE,
        method="POST",
        json=_envelope(
            {
                "error": "Rain is not available for this project",
                "code": "card_issuer_unavailable",
                "details": {"reason": "live_blocked", "available_programs": programs},
            },
            success=False,
            error="Rain is not available for this project",
        ),
    )
    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        session = await cs.create("consumer_123", servers=[])
        result = await session.card(ISSUE_USD)
    assert isinstance(result, CardRefusal)
    assert result.state == "refused"
    assert result.code == "card_issuer_unavailable"
    assert result.reason == "live_blocked"
    assert result.http_status == 200
    assert result.message == "Rain is not available for this project"
    assert result.available_programs is not None
    assert [(p.program, p.available, p.reason) for p in result.available_programs] == [
        ("pomelo_brl", True, None),
        ("rain_usd", False, "live_blocked"),
    ]


@pytest.mark.asyncio
async def test_action_unsupported_carries_available_actions(httpx_mock: HTTPXMock) -> None:
    _mock_session(httpx_mock)
    httpx_mock.add_response(
        url=EXECUTE,
        method="POST",
        json=_envelope(
            {
                "error": "freeze is not supported on rain_usd",
                "code": "card_action_unsupported",
                "details": {
                    "issuer": "rain",
                    "program": "rain_usd",
                    "action": "freeze",
                    "available_actions": [],
                },
            },
            success=False,
            error="freeze is not supported on rain_usd",
        ),
    )
    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        session = await cs.create("consumer_123", servers=[])
        result = await session.card(CardArgs(action="freeze", card_id="rcrd_abc"))
    assert isinstance(result, CardRefusal)
    assert (result.code, result.issuer, result.program, result.action) == (
        "card_action_unsupported",
        "rain",
        "rain_usd",
        "freeze",
    )
    assert result.available_actions == []


@pytest.mark.asyncio
async def test_non_2xx_refusal_is_returned_with_its_status(httpx_mock: HTTPXMock) -> None:
    _mock_session(httpx_mock)
    httpx_mock.add_response(
        url=EXECUTE,
        method="POST",
        status_code=409,
        json={"error": "idempotency_key_conflict", "message": "same key, different body"},
    )
    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        session = await cs.create("consumer_123", servers=[])
        result = await session.card(ISSUE_USD)
    assert isinstance(result, CardRefusal)
    assert result.code == "idempotency_key_conflict"
    assert result.message == "same key, different body"
    assert result.http_status == 409


@pytest.mark.asyncio
async def test_failure_without_code_raises(httpx_mock: HTTPXMock) -> None:
    _mock_session(httpx_mock)
    httpx_mock.add_response(
        url=EXECUTE,
        method="POST",
        json=_envelope(None, success=False, error="Tool not registered: codespar_card"),
    )
    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        session = await cs.create("consumer_123", servers=[])
        with pytest.raises(ApiError, match="card failed: Tool not registered: codespar_card"):
            await session.card(CardArgs(action="get", card_id="icrd_1"))


@pytest.mark.asyncio
async def test_unknown_issue_state_raises(httpx_mock: HTTPXMock) -> None:
    _mock_session(httpx_mock)
    httpx_mock.add_response(url=EXECUTE, method="POST", json=_envelope({"state": "pending"}))
    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        session = await cs.create("consumer_123", servers=[])
        with pytest.raises(ApiError, match="unexpected issue state"):
            await session.card(ISSUE_USD)


def test_sync_card_is_the_same_call(httpx_mock: HTTPXMock) -> None:
    _mock_session(httpx_mock)
    httpx_mock.add_response(
        url=EXECUTE,
        method="POST",
        json=_envelope({**RAIN_VIEW, "status": "blocked", "available_actions": []}),
    )
    with CodeSpar(api_key="csk_test_x") as cs:
        session = cs.create("consumer_123", servers=[])
        result = session.card(CardArgs(action="cancel", card_id="icrd_1", reason="lost"))
    assert isinstance(result, CardView)
    assert _sent(httpx_mock)["input"] == {
        "action": "cancel",
        "card_id": "icrd_1",
        "reason": "lost",
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("state", "cls"),
    [("processing", CardProcessing), ("uncertain", CardUncertain), ("failed", CardFailed)],
)
async def test_non_final_issue_states_are_distinct(
    httpx_mock: HTTPXMock, state: str, cls: type
) -> None:
    _mock_session(httpx_mock)
    httpx_mock.add_response(
        url=EXECUTE,
        method="POST",
        json=_envelope(
            {
                "state": state,
                "issue_request_id": "cir_3",
                "issuer": "rain",
                "program": "rain_usd",
                "code": "issuer_declined",
            }
        ),
    )
    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        session = await cs.create("consumer_123", servers=[])
        result = await session.card(ISSUE_USD)
    assert type(result) is cls
    assert result.state == state
    assert result.issue_request_id == "cir_3"
    if isinstance(result, CardFailed):
        assert result.code == "issuer_declined"


@pytest.mark.asyncio
async def test_deprecated_issue_warns_and_sends_codespar_card(httpx_mock: HTTPXMock) -> None:
    _mock_session(httpx_mock)
    httpx_mock.add_response(url=EXECUTE, method="POST", json=_envelope(_issued(RAIN_VIEW)))
    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        session = await cs.create("consumer_123", servers=[])
        with pytest.warns(DeprecationWarning, match=r"session\.issue\(\) is deprecated"):
            result = await session.issue(ISSUE_USD)
    assert isinstance(result, CardIssued)
    body = _sent(httpx_mock)
    assert body["tool"] == "codespar_card"
    assert body["input"]["idempotency_key"] == "idem_1"


@pytest.mark.asyncio
async def test_deprecated_issue_refuses_old_shape_before_sending(httpx_mock: HTTPXMock) -> None:
    _mock_session(httpx_mock)
    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        session = await cs.create("consumer_123", servers=[])
        with (
            pytest.warns(DeprecationWarning),
            pytest.raises(CardContractMigrationError) as exc,
        ):
            await session.issue(
                IssueArgs(action="card-virtual", cardholder_id="usr_1", program_id="afg_1")
            )
    assert exc.value.code == "card_contract_migration_required"
    assert exc.value.legacy_fields == ["cardholder_id", "program_id"]
    assert "mandate_id, consumer_id and idempotency_key" in str(exc.value)
    assert not any(r.url.path.endswith("/execute") for r in httpx_mock.get_requests())


def test_sync_deprecated_issue_warns_once_per_call(httpx_mock: HTTPXMock) -> None:
    _mock_session(httpx_mock)
    httpx_mock.add_response(url=EXECUTE, method="POST", json=_envelope(RAIN_VIEW))
    with CodeSpar(api_key="csk_test_x") as cs:
        session = cs.create("consumer_123", servers=[])
        with pytest.warns(DeprecationWarning) as record:
            session.issue(CardArgs(action="get", card_id="rcrd_abc"))
    assert len([w for w in record if issubclass(w.category, DeprecationWarning)]) == 1


@pytest.mark.asyncio
async def test_cards_readiness(httpx_mock: HTTPXMock) -> None:
    doc = {
        "programs": [
            {
                "program": "rain_usd",
                "issuer": "rain",
                "currency": "USD",
                "ready": False,
                "requirements": [
                    {"kind": "accept_terms", "status": "pending", "actor": "holder"},
                    {"kind": "environment", "status": "blocked", "actor": "org_admin"},
                ],
            }
        ]
    }
    httpx_mock.add_response(url=f"{BASE}/v1/cards/readiness", method="GET", json=doc)
    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        assert await cs.cards.readiness() == doc


def test_cards_readiness_sync(httpx_mock: HTTPXMock) -> None:
    doc = {"programs": []}
    httpx_mock.add_response(url=f"{BASE}/v1/cards/readiness", method="GET", json=doc)
    with CodeSpar(api_key="csk_test_x") as cs:
        assert cs.cards.readiness() == doc


@pytest.mark.asyncio
async def test_enterprise_refusal_envelope(httpx_mock: HTTPXMock) -> None:
    """The tool-result refusal enterprise sends: {error: {code, message, details}, http_status}."""
    _mock_session(httpx_mock)
    httpx_mock.add_response(
        url=EXECUTE,
        method="POST",
        json=_envelope(
            {
                "error": {
                    "code": "card_issuer_unavailable",
                    "message": "rain_usd is not available here",
                    "details": {
                        "reason": "live_blocked",
                        "available_programs": [
                            {"program": "pomelo_brl", "issuer": "pomelo", "currency": "BRL"}
                        ],
                    },
                },
                "http_status": 422,
            },
            success=False,
            error="card_issuer_unavailable",
        ),
    )
    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        session = await cs.create("consumer_123", servers=[])
        result = await session.card(ISSUE_USD)
    assert isinstance(result, CardRefusal)
    assert result.code == "card_issuer_unavailable"
    assert result.message == "rain_usd is not available here"
    assert result.reason == "live_blocked"
    assert result.http_status == 422
    assert result.available_programs is not None
    assert result.available_programs[0].program == "pomelo_brl"
    assert result.available_programs[0].available is None


@pytest.mark.asyncio
async def test_issue_sends_holder(httpx_mock: HTTPXMock) -> None:
    _mock_session(httpx_mock)
    view = {**RAIN_VIEW, "id": "icrd_1", "issuer": "pomelo", "program": "pomelo_brl"}
    httpx_mock.add_response(url=EXECUTE, method="POST", json=_envelope(_issued(view)))
    holder = {"full_name": "A B", "email": "a@b.dev"}
    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        session = await cs.create("consumer_123", servers=[])
        await session.card(
            CardArgs(
                action="issue",
                currency="BRL",
                mandate_id="m",
                consumer_id="c",
                idempotency_key="k",
                holder=holder,
            )
        )
    assert _sent(httpx_mock)["input"]["holder"] == holder
