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


async def test_charge_wrapper_forwards_timeout(httpx_mock, monkeypatch) -> None:
    """charge(..., timeout=N) must reach execute's request_json call with timeout=N."""
    seen: dict = {}
    import codespar._http as http_mod

    real = http_mod.request_json

    # Intercept only the execute call (POST .../execute); let create go through normally.
    async def spy(client, method, path, /, **kw):
        if "/execute" in path:
            seen["timeout"] = kw.get("timeout")
        return await real(client, method, path, **kw)

    monkeypatch.setattr("codespar._async_session.request_json", spy)

    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions",
        method="POST",
        json={
            "id": "s1",
            "org_id": "o",
            "user_id": "u",
            "servers": [],
            "status": "active",
            "created_at": "2026-01-01T00:00:00Z",
            "closed_at": None,
        },
    )
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions/s1/execute",
        method="POST",
        json={
            "success": True,
            "data": {
                "id": "ch_1",
                "status": "pending",
                "amount": 100.0,
                "currency": "BRL",
                "method": "pix",
            },
            "error": None,
            "duration": 10,
            "server": "asaas",
            "tool": "codespar_charge",
        },
    )

    from codespar.types import ChargeArgs, ChargeBuyer

    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        session = await cs.create("u", preset="brazilian")
        await session.charge(
            ChargeArgs(
                amount=100.0,
                currency="BRL",
                method="pix",
                description="test",
                buyer=ChargeBuyer(name="Test User"),
            ),
            timeout=7.0,
        )

    assert seen.get("timeout") == 7.0


async def test_discover_wrapper_forwards_timeout(httpx_mock, monkeypatch) -> None:
    """discover(..., timeout=N) must reach execute's request_json call with timeout=N."""
    seen: dict = {}
    import codespar._http as http_mod

    real = http_mod.request_json

    async def spy(client, method, path, /, **kw):
        if "/execute" in path:
            seen["timeout"] = kw.get("timeout")
        return await real(client, method, path, **kw)

    monkeypatch.setattr("codespar._async_session.request_json", spy)

    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions",
        method="POST",
        json={
            "id": "s2",
            "org_id": "o",
            "user_id": "u",
            "servers": [],
            "status": "active",
            "created_at": "2026-01-01T00:00:00Z",
            "closed_at": None,
        },
    )
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions/s2/execute",
        method="POST",
        json={
            "success": True,
            "data": {
                "use_case": "send pix",
                "search_strategy": "semantic",
                "recommended": None,
                "related": [],
                "next_steps": [],
            },
            "error": None,
            "duration": 5,
            "server": "catalog",
            "tool": "codespar_discover",
        },
    )

    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        session = await cs.create("u", preset="brazilian")
        await session.discover("send pix", timeout=3.5)

    assert seen.get("timeout") == 3.5


async def test_create_rejects_non_numeric_timeout() -> None:
    from codespar import ConfigError

    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        with pytest.raises(ConfigError):
            await cs.create("u", preset="brazilian", timeout="30")  # type: ignore[arg-type]


async def test_create_rejects_bool_timeout() -> None:
    from codespar import ConfigError

    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        with pytest.raises(ConfigError):
            await cs.create("u", preset="brazilian", timeout=True)  # type: ignore[arg-type]


async def _open_session(httpx_mock, cs):
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions",
        method="POST",
        json={
            "id": "s1",
            "org_id": "o",
            "user_id": "u",
            "servers": [],
            "status": "active",
            "created_at": "2026-01-01T00:00:00Z",
            "closed_at": None,
        },
    )
    return await cs.create("u", preset="brazilian")


async def test_close_swallows_backend_timeout(httpx_mock) -> None:
    """close() is best-effort: a backend timeout must not crash the caller."""
    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        session = await _open_session(httpx_mock, cs)
        httpx_mock.add_exception(httpx.ReadTimeout("slow"))  # the DELETE
        await session.close()  # must NOT raise


@pytest.mark.parametrize("bad", [True, "30", 0, -5, float("nan")])
async def test_session_method_rejects_invalid_timeout(httpx_mock, bad) -> None:
    from codespar import ConfigError

    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        session = await _open_session(httpx_mock, cs)
        with pytest.raises(ConfigError):
            await session.send("hi", timeout=bad)  # type: ignore[arg-type]
