"""
``CODESPAR_BASE_URL`` env-var resolution for the Python client.

The constructor cascade is: explicit ``base_url`` keyword, then the
``CODESPAR_BASE_URL`` env var, then the production default. The env
var lets a caller point the same client wiring at a local OSS
runtime or at ``api.codespar.dev`` without rebuilding the call sites.
"""

from __future__ import annotations

import os
from unittest.mock import patch

from codespar import AsyncCodeSpar, CodeSpar


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
