"""The SDK reports the version it actually is (oss-sdk#11).

Three places wrote the version down by hand and none of them checked the
others: ``pyproject.toml`` (what pip installs and what the registry shows),
``codespar.__version__`` (what a user prints) and the ``User-Agent`` in
``_http.build_headers`` (what our own logs attribute a request to). They had
drifted to three different values, so a request from 0.11.0 arrived labelled
0.10.0 and every server-side question of the form "which SDK version is doing
this?" was answered wrong.

``pyproject.toml`` is the authority here, because it is the one a published
artifact is actually built from. Everything else is compared against it, read
at test time so no copy of the number can silently fall behind again.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest

import codespar
from codespar._http import build_headers

if sys.version_info >= (3, 11):
    import tomllib
else:  # pragma: no cover - the package requires >=3.10
    tomllib = pytest.importorskip("tomli")

PYPROJECT = Path(__file__).resolve().parents[1] / "pyproject.toml"


def published_version() -> str:
    with PYPROJECT.open("rb") as fh:
        return tomllib.load(fh)["project"]["version"]


def test_control_the_published_version_was_actually_read() -> None:
    """Without this, a failed read would compare None with None and pass."""
    assert re.fullmatch(r"\d+\.\d+\.\d+.*", published_version())


def test_dunder_version_is_the_published_version() -> None:
    assert codespar.__version__ == published_version()


def test_user_agent_carries_the_published_version() -> None:
    headers = build_headers("csk_test_x", None)
    assert headers["User-Agent"] == f"codespar-python/{published_version()}"


def test_user_agent_is_present_on_the_project_scoped_path_too() -> None:
    """The header set is built once, but both branches must carry it."""
    headers = build_headers("csk_test_x", "prj_abc", accept_sse=True)
    assert headers["User-Agent"] == f"codespar-python/{published_version()}"
    assert headers["x-codespar-project"] == "prj_abc"
