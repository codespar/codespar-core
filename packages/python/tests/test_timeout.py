import httpx
import pytest

from codespar import AsyncCodeSpar, CodeSparError
from codespar import TimeoutError as CsTimeoutError


def test_timeout_error_is_codespar_error() -> None:
    e = CsTimeoutError("slow")
    assert isinstance(e, CodeSparError)
    assert str(e) == "slow"


async def test_create_maps_httpx_timeout(httpx_mock) -> None:
    httpx_mock.add_exception(httpx.ReadTimeout("slow"))
    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        with pytest.raises(CsTimeoutError):
            await cs.create("user_1", preset="brazilian")


async def test_per_call_timeout_is_forwarded(httpx_mock, monkeypatch) -> None:
    seen: dict = {}
    import codespar._http as http_mod

    real = http_mod.request_json

    async def spy(client, method, path, /, **kw):
        seen["timeout"] = kw.get("timeout")
        return await real(client, method, path, **kw)

    monkeypatch.setattr("codespar._async_client.request_json", spy)
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions",
        method="POST",
        json={
            "id": "s",
            "org_id": "o",
            "user_id": "u",
            "servers": [],
            "status": "active",
            "created_at": "2026-01-01T00:00:00Z",
            "closed_at": None,
        },
    )
    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        await cs.create("u", preset="brazilian", timeout=12.5)
    assert seen["timeout"] == 12.5
