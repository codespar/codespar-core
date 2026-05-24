"""
Tests for the Python ApiError code-extraction precedence.

The original HTTP layer read ``parsed.get("error")`` as the structured
code field. The hosted-test-mode envelopes (see codespar-enterprise's
Backend D3 + D7) standardise on ``code`` as the discriminant — the
managed backend now returns ``{"code": "mocks_not_permitted",
"message": "..."}`` for the create-time gate envelopes. ``code``
takes precedence over ``error`` so the new envelopes surface
correctly; ``error`` is still honored as a fallback for pre-PRD
responses that haven't migrated.

The ApiError class itself is unchanged — only the call-site
extraction logic in ``_http.request_json`` shifts.
"""

from __future__ import annotations

import pytest
from pytest_httpx import HTTPXMock

from codespar import ApiError, AsyncCodeSpar


async def test_code_field_takes_precedence_over_error_field(
    httpx_mock: HTTPXMock,
) -> None:
    """When both `code` and `error` are present, `code` wins."""
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions",
        method="POST",
        status_code=403,
        json={
            "code": "mocks_not_permitted",
            "error": "old_legacy_code",
            "message": "csk_test_* key required",
        },
    )

    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        with pytest.raises(ApiError) as exc_info:
            await cs.create("user_demo", preset="brazilian")

    assert exc_info.value.code == "mocks_not_permitted"
    assert exc_info.value.status == 403


async def test_code_field_alone_is_extracted(httpx_mock: HTTPXMock) -> None:
    """The new envelope shape — only `code`, no legacy `error` key."""
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions",
        method="POST",
        status_code=400,
        json={"code": "mocks_invalid", "message": "tool name not canonical"},
    )

    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        with pytest.raises(ApiError) as exc_info:
            await cs.create("user_demo", preset="brazilian")

    assert exc_info.value.code == "mocks_invalid"


async def test_error_field_still_honored_when_code_missing(
    httpx_mock: HTTPXMock,
) -> None:
    """Pre-PRD envelopes that only carry `error` remain compatible."""
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions",
        method="POST",
        status_code=400,
        json={"error": "validation_failed", "message": "missing servers"},
    )

    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        with pytest.raises(ApiError) as exc_info:
            await cs.create("user_demo", preset="brazilian")

    assert exc_info.value.code == "validation_failed"


async def test_non_string_code_field_is_ignored(httpx_mock: HTTPXMock) -> None:
    """A numeric `code` doesn't poison the extraction — falls back."""
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions",
        method="POST",
        status_code=500,
        json={"code": 42, "error": "server_error", "message": "boom"},
    )

    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        with pytest.raises(ApiError) as exc_info:
            await cs.create("user_demo", preset="brazilian")

    assert exc_info.value.code == "server_error"
