"""
``cs.research`` and ``cs.data_calls`` parity with the TypeScript facade (Shop G3.1):
the wire each call sends, the API's wire returned as is, a key's ``execute``
raised as ``person_required`` and never treated as a run, on the async and the
sync client, and the one-word outcome read from the four states.
"""

from __future__ import annotations

import json

import pytest
from pytest_httpx import HTTPXMock

from codespar import ApiError, AsyncCodeSpar, CodeSpar, data_call_outcome, next_action_of

BASE = "https://api.codespar.dev"
PID = "prp_AbCdEfGhIjKlMnOp"
OFFER = "sof_AbCdEfGhIjKlMnOp"
URL = f"https://codespar.dev/dashboard/shop/data-calls/{PID}"
NEXT = {"kind": "person_authorization", "url": URL, "proposal_id": PID, "description": "x"}
VIEW = {
    "proposal_id": PID,
    "run_state": "ready",
    "awaiting": None,
    "offer": {"offer_id": OFFER, "offer_kind": "data_service", "total_minor": 50},
    "quotation": {"state": "valid", "total_minor": 50},
    "authorization": {"state": "needed", "amount_max_minor": 50},
    "commitment": {"state": "not_started"},
    "payment": {"state": "none"},
    "confirmation": {"state": "none"},
    "actions": {"execute": True, "cancel": True, "requote": False},
}


async def test_research_of_a_data_service_and_a_draft_from_its_offer(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        method="POST",
        url=f"{BASE}/v1/shop/agent/research",
        json={"research": {"id": "srr_x", "offers": [{"id": OFFER}]}},
        status_code=201,
    )
    httpx_mock.add_response(
        method="POST",
        url=f"{BASE}/v1/shop/agent/data-calls",
        json={"data_call": VIEW, "idempotent_replay": False},
        status_code=201,
    )
    httpx_mock.add_response(
        method="GET",
        url=f"{BASE}/v1/shop/agent/data-calls/{PID}",
        json={"data_call": VIEW, "next_action": NEXT},
    )
    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        research = await cs.research.create(
            "consulta de CNPJ",
            task_kind="data_service",
            criteria={"data_service": {"params": {"cnpj": "11222333000181"}}},
        )
        created = await cs.data_calls.create(
            agent_id="ag_x", offer_id=research["offers"][0]["id"], idempotency_key="idem_x_0001"
        )
        read = await cs.data_calls.get(PID)
    assert created == {"data_call": VIEW, "idempotent_replay": False}
    assert read == {"data_call": VIEW, "next_action": NEXT}
    r, d, _ = httpx_mock.get_requests()
    assert json.loads(r.content) == {
        "query": "consulta de CNPJ",
        "task_kind": "data_service",
        "criteria": {"data_service": {"params": {"cnpj": "11222333000181"}}},
    }
    assert json.loads(d.content) == {
        "agent_id": "ag_x",
        "offer_id": OFFER,
        "idempotency_key": "idem_x_0001",
    }
    assert d.headers["authorization"] == "Bearer csk_test_x"


async def test_a_keys_execute_is_person_required_never_a_run(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        method="POST",
        url=f"{BASE}/v1/shop/agent/data-calls/{PID}/execute",
        json={
            "error": {
                "code": "person_required",
                "message": "running a data call is the person's authorization",
                "details": {"next_action": NEXT},
            }
        },
        status_code=403,
    )
    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        with pytest.raises(ApiError) as caught:
            await cs.data_calls.execute(PID)
    assert caught.value.status == 403
    assert caught.value.code == "person_required"
    action = next_action_of(caught.value)
    assert action is not None and action["url"] == URL


def test_the_sync_client_reads_the_same_wire(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        method="GET",
        url=f"{BASE}/v1/shop/agent/data-calls/{PID}",
        json={"data_call": VIEW, "next_action": NEXT},
    )
    with CodeSpar(api_key="csk_test_x") as cs:
        assert cs.data_calls.get(PID)["data_call"] == VIEW


def test_the_outcome_reads_the_four_states_apart() -> None:
    assert (
        data_call_outcome(
            {
                **VIEW,
                "confirmation": {"state": "confirmed", "result_ref": "tdr_1"},
                "payment": {"state": "held"},
            }
        )
        == "succeeded"
    )
    assert (
        data_call_outcome(
            {**VIEW, "commitment": {"state": "uncertain"}, "payment": {"state": "debited"}}
        )
        == "uncertain"
    )
    assert data_call_outcome({**VIEW, "error": {"code": "commitment_terms_changed"}}) == "refused"
    assert (
        data_call_outcome(
            {**VIEW, "commitment": {"state": "failed"}, "confirmation": {"state": "failed"}}
        )
        == "failed"
    )
    assert data_call_outcome(VIEW) == "pending"
