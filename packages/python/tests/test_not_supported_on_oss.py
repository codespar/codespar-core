"""
Tests for the Python parallel of the bidirectional test-parity surface.

  - CODESPAR_BASE_URL env var is the default for the AsyncCodeSpar /
    CodeSpar constructor's ``base_url`` parameter when no explicit
    value is passed.
  - is_not_supported_on_oss guard recognises the new tool-result
    variant and validates the ``capability`` sibling.
"""

from __future__ import annotations

import os
from typing import Any
from unittest.mock import patch

from codespar import AsyncCodeSpar, CodeSpar
from codespar.tool_result_codes import (
    NOT_SUPPORTED_ON_OSS,
    TOOL_RESULT_CODES,
    is_not_supported_on_oss,
)


def test_async_client_reads_codespar_base_url() -> None:
    with patch.dict(os.environ, {"CODESPAR_BASE_URL": "https://oss.example/"}):
        cs = AsyncCodeSpar(api_key="csk_live_x")
        assert cs.base_url == "https://oss.example"


def test_async_client_explicit_base_url_wins_over_env() -> None:
    with patch.dict(os.environ, {"CODESPAR_BASE_URL": "https://env.example"}):
        cs = AsyncCodeSpar(api_key="csk_live_x", base_url="https://override.example")
        assert cs.base_url == "https://override.example"


def test_sync_client_reads_codespar_base_url() -> None:
    with patch.dict(os.environ, {"CODESPAR_BASE_URL": "https://oss.example/"}):
        cs = CodeSpar(api_key="csk_live_x")
        try:
            assert cs.base_url == "https://oss.example"
        finally:
            cs.close()


def test_default_base_url_when_env_unset() -> None:
    """Unset env preserves the production default — no behavior change for callers."""
    env = dict(os.environ)
    env.pop("CODESPAR_BASE_URL", None)
    with patch.dict(os.environ, env, clear=True):
        cs = AsyncCodeSpar(api_key="csk_live_x")
        assert cs.base_url == "https://api.codespar.dev"


def test_not_supported_on_oss_in_codes_frozenset() -> None:
    assert NOT_SUPPORTED_ON_OSS == "not_supported_on_oss"
    assert NOT_SUPPORTED_ON_OSS in TOOL_RESULT_CODES


def test_is_not_supported_on_oss_positive() -> None:
    out: Any = {
        "code": NOT_SUPPORTED_ON_OSS,
        "capability": "session.send",
        "message": "OSS runtime lacks chat-loop support",
    }
    assert is_not_supported_on_oss(out) is True


def test_is_not_supported_on_oss_missing_capability() -> None:
    out: Any = {"code": NOT_SUPPORTED_ON_OSS, "message": "missing"}
    assert is_not_supported_on_oss(out) is False


def test_is_not_supported_on_oss_missing_message() -> None:
    out: Any = {"code": NOT_SUPPORTED_ON_OSS, "capability": "x"}
    assert is_not_supported_on_oss(out) is False


def test_is_not_supported_on_oss_unknown_code() -> None:
    out: Any = {"code": "rogue", "capability": "x", "message": "y"}
    assert is_not_supported_on_oss(out) is False
