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
