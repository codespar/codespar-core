"""
``cs.wallet.pix_keys`` parity with the TypeScript facade: the wire each call
sends to /v1/consumers/:consumer_id/pix-keys (auth and project headers, the
explicit key_type, the key only for a non-random type, the encoded key in the
DELETE path), on the async and the sync client, and that a delete without
``confirm=True`` sends nothing.
"""

from __future__ import annotations

import json

import pytest
from pytest_httpx import HTTPXMock

from codespar import ApiError, AsyncCodeSpar, CodeSpar, PixKeyDeleteNotConfirmedError

BASE = "https://api.codespar.dev"
CONSUMER = "sbx_prj_0123456789abcdef"
EVP = "e3bd874d-f40d-4434-9569-10dc83e2e0e4"
LIST = {"account_masked": "••••27", "keys": [{"key": EVP, "key_type": "EVP"}], "count": 1}


async def test_list_reads_the_keys_with_the_headers(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(method="GET", url=f"{BASE}/v1/consumers/{CONSUMER}/pix-keys", json=LIST)
    async with AsyncCodeSpar(api_key="csk_test_x", project_id="prj_0123456789abcdef") as cs:
        out = await cs.wallet.pix_keys.list(CONSUMER)
    assert out == LIST
    request = httpx_mock.get_request()
    assert request is not None
    assert request.headers["authorization"] == "Bearer csk_test_x"
    assert request.headers["x-codespar-project"] == "prj_0123456789abcdef"


async def test_register_sends_the_explicit_type_and_the_key_only_for_a_value_type(
    httpx_mock: HTTPXMock,
) -> None:
    registered = {"key": EVP, "key_type": "EVP", "account_masked": "••••27", "cache_filled": True}
    httpx_mock.add_response(
        method="POST",
        url=f"{BASE}/v1/consumers/{CONSUMER}/pix-keys",
        json=registered,
        status_code=201,
    )
    httpx_mock.add_response(
        method="POST",
        url=f"{BASE}/v1/consumers/{CONSUMER}/pix-keys",
        json=registered,
        status_code=201,
    )
    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        out = await cs.wallet.pix_keys.register(CONSUMER, key="ignored for EVP")
        await cs.wallet.pix_keys.register(CONSUMER, key_type="EMAIL", key="fulano@example.com")
    assert out == registered
    first, second = httpx_mock.get_requests()
    assert json.loads(first.content) == {"key_type": "EVP"}
    assert json.loads(second.content) == {"key_type": "EMAIL", "key": "fulano@example.com"}


async def test_delete_without_confirm_sends_nothing(httpx_mock: HTTPXMock) -> None:
    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        with pytest.raises(PixKeyDeleteNotConfirmedError) as info:
            await cs.wallet.pix_keys.delete(CONSUMER, EVP)
        with pytest.raises(PixKeyDeleteNotConfirmedError):
            await cs.wallet.pix_keys.delete(CONSUMER, EVP, confirm=False)
    assert info.value.code == "pix_key_delete_requires_confirmation"
    assert "deixa de apontar" in info.value.consequence
    assert httpx_mock.get_requests() == []


async def test_delete_with_confirm_sends_the_delete_with_the_key_encoded(
    httpx_mock: HTTPXMock,
) -> None:
    deleted = {"key": "+5531999123456", "account_masked": "••••27", "deleted": True}
    httpx_mock.add_response(
        method="DELETE",
        url=f"{BASE}/v1/consumers/{CONSUMER}/pix-keys/%2B5531999123456",
        json=deleted,
    )
    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        out = await cs.wallet.pix_keys.delete(CONSUMER, "+5531999123456", confirm=True)
    assert out == deleted


async def test_route_refusal_keeps_status_and_code(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        method="POST",
        url=f"{BASE}/v1/consumers/{CONSUMER}/pix-keys",
        status_code=422,
        json={"error": {"code": "pix_key_type_unavailable", "message": "random key only"}},
    )
    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        with pytest.raises(ApiError) as info:
            await cs.wallet.pix_keys.register(CONSUMER, key_type="CPF", key="11144477735")
    assert info.value.status == 422
    assert info.value.code == "pix_key_type_unavailable"


def test_sync_client_mirrors_the_async_facade(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(method="GET", url=f"{BASE}/v1/consumers/{CONSUMER}/pix-keys", json=LIST)
    deleted = {"key": EVP, "account_masked": "••••27", "deleted": True}
    httpx_mock.add_response(
        method="DELETE", url=f"{BASE}/v1/consumers/{CONSUMER}/pix-keys/{EVP}", json=deleted
    )
    with CodeSpar(api_key="csk_test_x") as cs:
        assert cs.wallet.pix_keys.list(CONSUMER) == LIST
        with pytest.raises(PixKeyDeleteNotConfirmedError):
            cs.wallet.pix_keys.delete(CONSUMER, EVP)
        assert cs.wallet.pix_keys.delete(CONSUMER, EVP, confirm=True) == deleted
    assert len(httpx_mock.get_requests()) == 2
