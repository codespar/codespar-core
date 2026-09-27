"""
p2-identity#6 (codespar-core#123): what ``verify_mandate_token`` may call
"verified".

Three verdicts the verifier used to give and must not: verified with the agent
signature missing, verified by a key the token does not name (a retired key
listed beside the active one), and verified after ``expires_at``. And one
format it could not read: V4, which signs ``issued_at``.

Every refusal sits next to the closest legitimate token still verifying, so a
verifier that refuses everything fails here too. Mirrors
``packages/core/src/__tests__/mandate-strict.test.ts``.
"""

from __future__ import annotations

import base64
import json
import os
from pathlib import Path
from typing import Any

import pytest

from codespar.mandate import (
    MandateDecodeError,
    decode_mandate_token,
    reconstruct_signing_string,
    verify_mandate_token,
)

try:
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    HAS_CRYPTO = True
except ImportError:  # pragma: no cover - the dev extra installs it
    HAS_CRYPTO = False

requires_crypto = pytest.mark.skipif(
    not HAS_CRYPTO, reason="needs the optional 'cryptography' extra"
)

FIXTURES = Path(__file__).parent / "_fixtures"
V3: dict[str, Any] = json.loads((FIXTURES / "canonical.v3.fixture.json").read_text())
V4: dict[str, Any] = json.loads((FIXTURES / "canonical.v4.fixture.json").read_text())

# The fixtures expire at 2025-01-01T00:00:00Z.
BEFORE = V3["input"]["expires_at"] - 12 * 3600
AFTER = V3["input"]["expires_at"] + 1

AGENT_DID = "did:web:id.codespar.dev:org_demo:a1"
RETIRED_KID = f"{AGENT_DID}#1"  # the fixture's agent key, retired by a rotation
ACTIVE_KID = f"{AGENT_DID}#2"


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _make_token(fields: dict[str, Any], **envelope: Any) -> str:
    return _b64url(json.dumps({**fields, **envelope}).encode("utf-8"))


def _fixture_token(fx: dict[str, Any], drop: tuple[str, ...] = ()) -> str:
    envelope = {
        "signature": fx["hmac_sha256_hex"],
        "agent_sig": fx["agent_sig_b64url"],
        "issuer_sig": fx["issuer_sig_b64url"],
        "kid": fx["input"]["agent_kid"],
    }
    for key in drop:
        envelope.pop(key)
    return _make_token(fx["input"], **envelope)


def _sign(seed_hex: str, message: str) -> str:
    key = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(seed_hex))
    return _b64url(key.sign(message.encode("utf-8")))


def _fresh_key() -> tuple[str, str]:
    seed = os.urandom(32)
    pub = (
        Ed25519PrivateKey.from_private_bytes(seed)
        .public_key()
        .public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    )
    return seed.hex(), pub.hex()


def _did_doc(keys: list[tuple[str, str]]) -> dict[str, Any]:
    return {
        "id": AGENT_DID,
        "verificationMethod": [
            {
                "id": kid,
                "type": "JsonWebKey2020",
                "controller": AGENT_DID,
                "publicKeyJwk": {"kty": "OKP", "crv": "Ed25519", "x": _b64url(bytes.fromhex(pub))},
            }
            for kid, pub in keys
        ],
    }


BOTH = {"agent_public_key": V3["agent_pubkey_hex"], "issuer_public_key": V3["issuer_pubkey_hex"]}


# ── controls ──────────────────────────────────────────────────────────


@requires_crypto
def test_control_v3_with_both_signatures_inside_window_verifies() -> None:
    res = verify_mandate_token(_fixture_token(V3), **BOTH, now=BEFORE)
    assert res.verified is True
    assert res.failures == []
    assert res.expired is False


@requires_crypto
def test_control_tampered_v3_still_fails() -> None:
    tampered = _make_token(
        {**V3["input"], "amount": "9999"},
        signature=V3["hmac_sha256_hex"],
        agent_sig=V3["agent_sig_b64url"],
        issuer_sig=V3["issuer_sig_b64url"],
        kid=V3["input"]["agent_kid"],
    )
    res = verify_mandate_token(tampered, **BOTH, now=BEFORE)
    assert res.verified is False
    assert res.failures == ["agent_sig_invalid", "issuer_sig_invalid"]


# ── rule 1: a signature the token does not carry is a failure ──────────


@requires_crypto
def test_agent_sig_stripped_is_not_verified() -> None:
    res = verify_mandate_token(_fixture_token(V3, ("agent_sig",)), **BOTH, now=BEFORE)
    assert res.verified is False
    assert res.issuer.status == "verified"
    assert res.agent.status == "absent"
    assert res.failures == ["agent_sig_absent"]


@requires_crypto
def test_issuer_sig_stripped_is_not_verified() -> None:
    res = verify_mandate_token(_fixture_token(V3, ("issuer_sig",)), **BOTH, now=BEFORE)
    assert res.verified is False
    assert res.agent.status == "verified"
    assert res.failures == ["issuer_sig_absent"]


@requires_crypto
def test_carried_signature_nobody_checked_is_not_verified() -> None:
    res = verify_mandate_token(
        _fixture_token(V3), agent_public_key=V3["agent_pubkey_hex"], now=BEFORE
    )
    assert res.verified is False
    assert res.issuer.status == "skipped"
    assert res.failures == ["issuer_sig_unchecked"]


# ── rule 2: only the key the token names ──────────────────────────────


def _token_naming(named_kid: str, agent_seed_hex: str) -> str:
    fields = {**V3["input"], "agent_kid": named_kid}
    s = reconstruct_signing_string(fields)
    return _make_token(
        fields,
        signature="00",
        agent_sig=_sign(agent_seed_hex, s),
        issuer_sig=_sign(V3["issuer_seed_hex"], s),
        kid=named_kid,
    )


@requires_crypto
def test_retired_key_does_not_verify_a_token_naming_the_active_key() -> None:
    _, active_pub = _fresh_key()
    doc = _did_doc([(RETIRED_KID, V3["agent_pubkey_hex"]), (ACTIVE_KID, active_pub)])
    res = verify_mandate_token(
        _token_naming(ACTIVE_KID, V3["agent_seed_hex"]),
        agent_did_document=doc,
        issuer_public_key=V3["issuer_pubkey_hex"],
        now=BEFORE,
    )
    assert res.verified is False
    assert res.agent.status == "failed"
    assert res.agent.kid == ACTIVE_KID
    assert res.failures == ["agent_sig_invalid"]


@requires_crypto
def test_control_active_key_verifies_the_token_naming_it() -> None:
    active_seed, active_pub = _fresh_key()
    doc = _did_doc([(RETIRED_KID, V3["agent_pubkey_hex"]), (ACTIVE_KID, active_pub)])
    res = verify_mandate_token(
        _token_naming(ACTIVE_KID, active_seed),
        agent_did_document=doc,
        issuer_public_key=V3["issuer_pubkey_hex"],
        now=BEFORE,
    )
    assert res.verified is True
    assert res.agent.kid == ACTIVE_KID


@requires_crypto
def test_kid_the_document_does_not_publish_fails() -> None:
    doc = _did_doc([(RETIRED_KID, V3["agent_pubkey_hex"])])
    res = verify_mandate_token(
        _token_naming(f"{AGENT_DID}#9", V3["agent_seed_hex"]),
        agent_did_document=doc,
        issuer_public_key=V3["issuer_pubkey_hex"],
        now=BEFORE,
    )
    assert res.verified is False
    assert res.agent.status == "failed"
    assert res.failures == ["kid_not_in_document"]


@requires_crypto
def test_unsigned_envelope_kid_cannot_rename_the_signed_agent_kid() -> None:
    token = _make_token(
        V3["input"],
        signature=V3["hmac_sha256_hex"],
        agent_sig=V3["agent_sig_b64url"],
        issuer_sig=V3["issuer_sig_b64url"],
        kid=ACTIVE_KID,
    )
    res = verify_mandate_token(token, **BOTH, now=BEFORE)
    assert res.verified is False
    assert res.kid == V3["input"]["agent_kid"]
    assert res.failures == ["kid_mismatch"]


def test_public_key_and_document_together_are_refused() -> None:
    with pytest.raises(TypeError, match="not both"):
        verify_mandate_token(
            _fixture_token(V3),
            agent_public_key=V3["agent_pubkey_hex"],
            agent_did_document=_did_doc([]),
            now=BEFORE,
        )


# ── rule 3: an expired token is not verified ──────────────────────────


@requires_crypto
def test_one_second_past_expiry_is_not_verified() -> None:
    res = verify_mandate_token(_fixture_token(V3), **BOTH, now=AFTER)
    assert res.verified is False
    assert res.agent.status == "verified"
    assert res.issuer.status == "verified"
    assert res.expired is True
    assert res.failures == ["expired"]


@requires_crypto
def test_default_clock_is_the_real_one() -> None:
    res = verify_mandate_token(_fixture_token(V3), **BOTH)
    assert res.verified is False
    assert res.expired is True


@requires_crypto
def test_at_expires_at_exactly_still_valid() -> None:
    res = verify_mandate_token(_fixture_token(V3), **BOTH, now=V3["input"]["expires_at"])
    assert res.verified is True


# ── V4 (issued_at signed) ─────────────────────────────────────────────


def test_v4_reconstructs_the_frozen_canonical_string() -> None:
    assert reconstruct_signing_string(V4["input"]) == V4["canonical_string"]


@requires_crypto
def test_v4_token_verifies_and_exposes_issued_at() -> None:
    res = verify_mandate_token(
        _fixture_token(V4),
        agent_public_key=V4["agent_pubkey_hex"],
        issuer_public_key=V4["issuer_pubkey_hex"],
        now=BEFORE,
    )
    assert res.verified is True
    assert res.issued_at == V4["input"]["issued_at"]


@requires_crypto
def test_v4_issued_at_moved_by_one_second_breaks_both_signatures() -> None:
    token = _make_token(
        {**V4["input"], "issued_at": V4["input"]["issued_at"] + 1},
        signature=V4["hmac_sha256_hex"],
        agent_sig=V4["agent_sig_b64url"],
        issuer_sig=V4["issuer_sig_b64url"],
        kid=V4["input"]["agent_kid"],
    )
    res = verify_mandate_token(
        token,
        agent_public_key=V4["agent_pubkey_hex"],
        issuer_public_key=V4["issuer_pubkey_hex"],
        now=BEFORE,
    )
    assert res.verified is False
    assert res.failures == ["agent_sig_invalid", "issuer_sig_invalid"]


def test_v4_without_issued_at_is_malformed() -> None:
    fields = {k: v for k, v in V4["input"].items() if k != "issued_at"}
    with pytest.raises(MandateDecodeError, match="invalid_payload"):
        decode_mandate_token(_make_token(fields, signature="00"))


def test_unknown_later_format_is_unsupported() -> None:
    with pytest.raises(MandateDecodeError, match="mandate_format_unsupported"):
        decode_mandate_token(_make_token({**V4["input"], "format_version": 5}, signature="00"))
