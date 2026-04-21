"""
Server presets — a shortcut so callers can say ``preset="brazilian"``
instead of listing every server id.

Must stay byte-for-byte identical to the TypeScript SDK
(``@codespar/sdk``, ``packages/core/src/session.ts``) so the same
preset yields the same servers across runtimes.
"""

from __future__ import annotations

from .types import Preset

_PRESET_SERVERS: dict[Preset, list[str]] = {
    "brazilian": ["zoop", "nuvem-fiscal", "melhor-envio", "z-api", "omie"],
    "mexican": ["conekta", "facturapi", "skydropx"],
    "argentinian": ["afip", "andreani"],
    "colombian": ["wompi", "siigo", "coordinadora"],
    "all": [
        "zoop",
        "nuvem-fiscal",
        "melhor-envio",
        "z-api",
        "omie",
        "conekta",
        "facturapi",
        "afip",
        "wompi",
    ],
}

# Sandbox default when the caller gives no preset + no servers list —
# enough to demo Brazilian Pix + NF-e without the user picking.
_SANDBOX_DEFAULT = ["zoop", "nuvem-fiscal"]


def preset_to_servers(preset: Preset | None) -> list[str]:
    """Expand a preset into a list of server ids. Falls back to sandbox default."""
    if preset is None:
        return list(_SANDBOX_DEFAULT)
    return list(_PRESET_SERVERS[preset])
