"""
codespar_shop Python parity tests.

Two layers:
  1. Round-trip: parse each canonical wire fixture
     (tests/_fixtures/shop_canonical.json — mirrored from the TS
     packages/types/src/testing/shop-fixtures.ts) into the dataclass
     result and assert every field maps one-to-one. This is the
     dict->dataclass parse-helper round-trip the contract requires
     and the guard against TS<->Python wire drift.
  2. Dispatch: drive ``session.shop(...)`` over a mocked backend and
     assert the action-correct result type + the wire params the
     facade sends.

The fixtures are the same JSON the TS conformance fixtures encode, so
both language surfaces are proven behaviorally identical for the same
wire payload.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from pytest_httpx import HTTPXMock

from codespar import (
    AsyncCodeSpar,
    ShopArgs,
    ShopCheckoutItem,
    ShopCheckoutResult,
    ShopSearchResult,
    ShopStatusResult,
)
from codespar._async_session import _parse_shop_result

FIXTURE_PATH = Path(__file__).parent / "_fixtures" / "shop_canonical.json"
FIXTURES: dict[str, Any] = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


def test_search_fixture_round_trips() -> None:
    result = _parse_shop_result(FIXTURES["search"], "search")
    assert isinstance(result, ShopSearchResult)
    assert result.rail == "vtex"
    assert len(result.products) == 1
    offer = result.products[0]
    assert offer.product_id == "prod_1"
    assert offer.sku_id == "sku_1"
    assert offer.price_minor == 4990
    assert offer.currency == "BRL"
    assert offer.available is True
    assert len(offer.variants) == 1
    # The buyable SKU is on the variant — pass it as checkout variant_id.
    assert offer.variants[0].sku_id == "sku_1"
    assert offer.variants[0].available is True


def test_empty_search_is_success_not_error() -> None:
    result = _parse_shop_result(FIXTURES["search_empty"], "search")
    assert isinstance(result, ShopSearchResult)
    assert result.products == []


def test_checkout_fixture_round_trips() -> None:
    result = _parse_shop_result(FIXTURES["checkout"], "checkout")
    assert isinstance(result, ShopCheckoutResult)
    assert result.checkout_session_id == "cks_abc123"
    assert result.status == "in_progress"
    assert result.message == "checkout started"


def test_status_ready_for_payment_exposes_typed_pix() -> None:
    result = _parse_shop_result(
        FIXTURES["status_ready_for_payment"], "checkout_status"
    )
    assert isinstance(result, ShopStatusResult)
    assert result.status == "ready_for_payment"
    assert result.total_minor == 4990
    assert result.pix_copia_e_cola is not None
    assert "br.gov.bcb.pix" in result.pix_copia_e_cola
    assert result.order_status == "pending"
    assert result.error is None


def test_status_canceled_exposes_typed_error() -> None:
    result = _parse_shop_result(
        FIXTURES["status_canceled"], "checkout_status"
    )
    assert isinstance(result, ShopStatusResult)
    assert result.status == "canceled"
    assert result.error == "browser_worker_checkout_failed"
    assert result.pix_copia_e_cola is None


def _session_json(**overrides: Any) -> dict[str, Any]:
    return {
        "id": "ses_shop",
        "org_id": "org_test",
        "user_id": "consumer_123",
        "servers": ["cobasi"],
        "status": "active",
        "created_at": "2026-04-21T12:00:00Z",
        "closed_at": None,
        **overrides,
    }


def _execute_response_json(data: Any) -> dict[str, Any]:
    return {
        "success": True,
        "data": data,
        "error": None,
        "duration": 5,
        "server": "_codespar",
        "tool": "codespar_shop",
    }


@pytest.mark.asyncio
async def test_shop_search_dispatch(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions",
        method="POST",
        json=_session_json(),
    )
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions/ses_shop/execute",
        method="POST",
        json=_execute_response_json(FIXTURES["search"]),
    )

    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        session = await cs.create("consumer_123", preset="brazilian")
        result = await session.shop(
            ShopArgs(action="search", query="ração para gato", merchant="cobasi", limit=10)
        )
        assert isinstance(result, ShopSearchResult)
        assert result.products[0].variants[0].sku_id == "sku_1"

    # The facade serialized only the search fields.
    requests = httpx_mock.get_requests()
    exec_req = next(r for r in requests if r.url.path.endswith("/execute"))
    body = json.loads(exec_req.content)
    assert body["tool"] == "codespar_shop"
    assert body["input"] == {
        "action": "search",
        "query": "ração para gato",
        "limit": 10,
        "merchant": "cobasi",
    }


@pytest.mark.asyncio
async def test_shop_checkout_serializes_items(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions",
        method="POST",
        json=_session_json(),
    )
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions/ses_shop/execute",
        method="POST",
        json=_execute_response_json(FIXTURES["checkout"]),
    )

    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        session = await cs.create("consumer_123", preset="brazilian")
        result = await session.shop(
            ShopArgs(
                action="checkout",
                merchant="cobasi",
                items=[ShopCheckoutItem(variant_id="sku_1", quantity=1)],
                consumer_id="consumer_123",
            )
        )
        assert isinstance(result, ShopCheckoutResult)
        assert result.status == "in_progress"

    requests = httpx_mock.get_requests()
    exec_req = next(r for r in requests if r.url.path.endswith("/execute"))
    body = json.loads(exec_req.content)
    assert body["input"]["action"] == "checkout"
    assert body["input"]["items"] == [{"variant_id": "sku_1", "quantity": 1}]
    assert body["input"]["consumer_id"] == "consumer_123"


@pytest.mark.asyncio
async def test_shop_failure_raises(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions",
        method="POST",
        json=_session_json(),
    )
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions/ses_shop/execute",
        method="POST",
        json={
            "success": False,
            "data": None,
            "error": "invalid_args",
            "duration": 1,
            "server": "_codespar",
            "tool": "codespar_shop",
        },
    )

    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        session = await cs.create("consumer_123", preset="brazilian")
        with pytest.raises(Exception, match="shop failed: invalid_args"):
            await session.shop(ShopArgs(action="search", query="x"))
