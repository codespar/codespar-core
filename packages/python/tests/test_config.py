"""Constructor + config validation. Pure unit tests — no HTTP."""

from __future__ import annotations

import pytest

from codespar import AsyncCodeSpar, CodeSpar, ConfigError, SessionConfig
from codespar._presets import preset_to_servers


def test_async_client_requires_api_key() -> None:
    with pytest.raises(ConfigError):
        AsyncCodeSpar(api_key="")


def test_async_client_rejects_bad_api_key_prefix() -> None:
    with pytest.raises(ConfigError):
        AsyncCodeSpar(api_key="sk_live_abc")


def test_async_client_accepts_csk_prefix() -> None:
    cs = AsyncCodeSpar(api_key="csk_live_abc")
    assert cs.base_url == "https://api.codespar.dev"
    assert cs.project_id is None


def test_async_client_strips_trailing_slash_on_base_url() -> None:
    cs = AsyncCodeSpar(api_key="csk_live_abc", base_url="http://localhost:8080/")
    assert cs.base_url == "http://localhost:8080"


def test_async_client_stores_project_id() -> None:
    cs = AsyncCodeSpar(api_key="csk_live_abc", project_id="prj_0123456789abcdef")
    assert cs.project_id == "prj_0123456789abcdef"


def test_sync_client_requires_api_key() -> None:
    with pytest.raises(ConfigError):
        CodeSpar(api_key="")


def test_preset_brazilian() -> None:
    assert preset_to_servers("brazilian") == [
        "zoop",
        "nuvem-fiscal",
        "melhor-envio",
        "z-api",
        "omie",
    ]


def test_preset_none_falls_back_to_sandbox_default() -> None:
    assert preset_to_servers(None) == ["zoop", "nuvem-fiscal"]


def test_session_config_defaults() -> None:
    cfg = SessionConfig()
    assert cfg.servers is None
    assert cfg.preset is None
    assert cfg.metadata is None
    assert cfg.project_id is None
    assert cfg.manage_connections is None
