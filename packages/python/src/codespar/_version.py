"""The one place this package's version is written down.

There used to be three, and none of them checked the others: ``pyproject.toml``
(what pip installs and what the registry shows), ``codespar.__version__`` (what
a user prints) and the ``User-Agent`` literal in ``_http.py`` (what our own
server logs attribute a request to). They drifted to 0.11.0, 0.10.2 and 0.10.0,
so requests from the current SDK arrived labelled as a release two versions old
and every server-side question of the form "which SDK version is doing this?"
got the wrong answer.

Why a literal and not ``importlib.metadata.version("codespar")``: the metadata
lookup answers only when the distribution is INSTALLED, so it needs a literal
fallback for a source checkout anyway — it adds a branch instead of removing the
duplicate, and it makes the version this package reports depend on how it was
loaded. The literal is single and the drift is closed at the seam that actually
failed: ``tests/test_version.py`` reads ``pyproject.toml`` and fails when this
string and the declared version disagree.

So: bump this WITH ``pyproject.toml``, in the same commit.

This module imports nothing from the package. ``__init__`` imports the transport
and the transport needs the version, so anything less isolated is a cycle.
"""

from __future__ import annotations

#: Equal to ``[project].version`` in pyproject.toml. Enforced by tests.
__version__ = "0.11.0"

#: The value every outbound request identifies this SDK with.
USER_AGENT = f"codespar-python/{__version__}"
