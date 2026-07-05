"""
Offline V3 mandate verification (``codespar.mandate``).

Byte-locks the canonical signing string against the shared freeze at
``tests/_fixtures/canonical.v3.fixture.json`` — the same JSON the enterprise
codec, the TS SDK, and the CLI pin — so the four implementations cannot drift.

Decode + reconstruction are pure stdlib and always run. Ed25519 verification
needs the optional ``cryptography`` extra; those tests skip when it is absent
(``pip install codespar[verify]`` / the ``dev`` extra installs it in CI).
"""

from __future__ import annotations

import base64
import json
from pathlib import Path
from typing import Any

import pytest

from codespar.mandate import (
    MandateDecodeError,
    agent_did_from_kid,
    decode_mandate_token,
    reconstruct_signing_string,
    verify_ed25519,
    verify_mandate_token,
)

FIXTURE_PATH = Path(__file__).parent / "_fixtures" / "canonical.v3.fixture.json"
FX: dict[str, Any] = json.loads(FIXTURE_PATH.read_text())

try:
    import cryptography  # noqa: F401

    HAS_CRYPTO = True
except ImportError:
    HAS_CRYPTO = False

requires_crypto = pytest.mark.skipif(
    not HAS_CRYPTO,
    reason="offline verify needs the optional 'cryptography' extra (pip install codespar[verify])",
)


def _make_token(fields: dict[str, Any], **envelope: Any) -> str:
    raw = json.dumps({**fields, **envelope}).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


TOKEN = _make_token(
    FX["input"],
    signature=FX["hmac_sha256_hex"],
    agent_sig=FX["agent_sig_b64url"],
    issuer_sig=FX["issuer_sig_b64url"],
    kid=FX["input"]["agent_kid"],
)


# ── decode ────────────────────────────────────────────────────────────


def test_decode_round_trips_envelope_and_splits_signed_fields() -> None:
    dec = decode_mandate_token(TOKEN)
    assert dec.signature == FX["hmac_sha256_hex"]
    assert dec.agent_sig == FX["agent_sig_b64url"]
    assert dec.issuer_sig == FX["issuer_sig_b64url"]
    assert dec.kid == FX["input"]["agent_kid"]
    for leaked in ("signature", "agent_sig", "issuer_sig", "kid"):
        assert leaked not in dec.mandate
    assert dec.mandate["principal_kyc_ref"] == FX["input"]["principal_kyc_ref"]


def test_decode_rejects_garbage() -> None:
    with pytest.raises(MandateDecodeError, match="invalid_payload"):
        decode_mandate_token("!!!nope!!!")


def test_decode_rejects_unsupported_version() -> None:
    bad = _make_token({**FX["input"], "format_version": 1}, signature="x")
    with pytest.raises(MandateDecodeError, match="mandate_format_unsupported"):
        decode_mandate_token(bad)


def test_decode_rejects_v3_missing_required_fields() -> None:
    fields = {k: v for k, v in FX["input"].items() if k not in ("principal_kyc_ref", "agent_kid")}
    with pytest.raises(MandateDecodeError, match="invalid_payload"):
        decode_mandate_token(_make_token(fields, signature="x"))


# ── reconstruct (byte-lock) ───────────────────────────────────────────


def test_reconstruct_is_byte_identical_to_frozen_canonical_string() -> None:
    assert reconstruct_signing_string(FX["input"]) == FX["canonical_string"]


def test_reconstruct_sorts_and_escapes_purposes() -> None:
    fields = {**FX["input"], "purposes": ["utility", "refund"]}
    assert reconstruct_signing_string(fields) == FX["canonical_string"]


def test_reconstruct_from_decoded_mandate_matches() -> None:
    dec = decode_mandate_token(TOKEN)
    assert reconstruct_signing_string(dec.mandate) == FX["canonical_string"]


# ── helpers ───────────────────────────────────────────────────────────


def test_agent_did_from_kid_strips_fragment() -> None:
    assert agent_did_from_kid("did:web:id.codespar.dev:org_demo:a1#1") == (
        "did:web:id.codespar.dev:org_demo:a1"
    )
    assert agent_did_from_kid("did:web:x") == "did:web:x"


def test_verify_with_no_keys_skips_and_is_not_verified() -> None:
    res = verify_mandate_token(TOKEN)
    assert res.agent.status == "skipped"
    assert res.issuer.status == "skipped"
    assert res.verified is False
    assert res.agent_did == "did:web:id.codespar.dev:org_demo:a1"
    assert res.kid == FX["input"]["agent_kid"]


@pytest.mark.skipif(HAS_CRYPTO, reason="only meaningful when cryptography is absent")
def test_verify_without_cryptography_raises_helpful_error() -> None:
    with pytest.raises(RuntimeError, match="cryptography"):
        verify_mandate_token(TOKEN, agent_public_key=FX["agent_pubkey_hex"])


# ── Ed25519 verification (optional extra) ─────────────────────────────


@requires_crypto
def test_verify_ed25519_agent_and_issuer() -> None:
    agent = bytes.fromhex(FX["agent_pubkey_hex"])
    issuer = bytes.fromhex(FX["issuer_pubkey_hex"])
    assert verify_ed25519(FX["canonical_string"], FX["agent_sig_b64url"], agent) is True
    assert verify_ed25519(FX["canonical_string"], FX["issuer_sig_b64url"], issuer) is True


@requires_crypto
def test_verify_ed25519_tamper_and_wrong_key_fail() -> None:
    agent = bytes.fromhex(FX["agent_pubkey_hex"])
    issuer = bytes.fromhex(FX["issuer_pubkey_hex"])
    forged = reconstruct_signing_string({**FX["input"], "amount": "9999"})
    assert verify_ed25519(forged, FX["agent_sig_b64url"], agent) is False
    assert verify_ed25519(FX["canonical_string"], FX["agent_sig_b64url"], issuer) is False
    assert verify_ed25519(FX["canonical_string"], FX["agent_sig_b64url"], b"\x00" * 5) is False


@requires_crypto
def test_verify_mandate_token_both_signatures() -> None:
    res = verify_mandate_token(
        TOKEN,
        agent_public_key=FX["agent_pubkey_hex"],
        issuer_public_key=FX["issuer_pubkey_hex"],
    )
    assert res.verified is True
    assert res.agent.status == "verified"
    assert res.issuer.status == "verified"
    assert res.agent.kid == FX["input"]["agent_kid"]
    assert res.mandate["amount"] == "5000"


@requires_crypto
def test_verify_mandate_token_accepts_raw_bytes_keys() -> None:
    res = verify_mandate_token(
        TOKEN,
        agent_public_key=bytes.fromhex(FX["agent_pubkey_hex"]),
        issuer_public_key=bytes.fromhex(FX["issuer_pubkey_hex"]),
    )
    assert res.verified is True


@requires_crypto
def test_verify_mandate_token_agent_only_skips_issuer() -> None:
    res = verify_mandate_token(TOKEN, agent_public_key=FX["agent_pubkey_hex"])
    assert res.agent.status == "verified"
    assert res.issuer.status == "skipped"
    assert res.verified is True


@requires_crypto
def test_verify_mandate_token_wrong_key_fails() -> None:
    res = verify_mandate_token(TOKEN, agent_public_key=FX["issuer_pubkey_hex"])
    assert res.agent.status == "failed"
    assert res.verified is False


@requires_crypto
def test_verify_mandate_token_tampered_fails() -> None:
    tampered = _make_token(
        {**FX["input"], "amount": "9999"},
        signature=FX["hmac_sha256_hex"],
        agent_sig=FX["agent_sig_b64url"],
        issuer_sig=FX["issuer_sig_b64url"],
        kid=FX["input"]["agent_kid"],
    )
    res = verify_mandate_token(
        tampered,
        agent_public_key=FX["agent_pubkey_hex"],
        issuer_public_key=FX["issuer_pubkey_hex"],
    )
    assert res.verified is False
    assert res.agent.status == "failed"
    assert res.issuer.status == "failed"


@requires_crypto
def test_verify_mandate_token_malformed_hex_key_is_skipped() -> None:
    res = verify_mandate_token(TOKEN, agent_public_key="xyz")
    assert res.agent.status == "skipped"
    assert res.verified is False
