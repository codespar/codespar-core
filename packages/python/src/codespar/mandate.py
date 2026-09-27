"""
Offline V3/V4 mandate verification for the CodeSpar Python SDK.

A third party holding only a presentation token and a raw Ed25519 public key
(from the agent's ``did:web`` document) can reconstruct the exact signing string
and verify the agent + issuer signatures — no CodeSpar API call. This mirrors
``@codespar/sdk/mandate`` (TS) and ``codespar mandate verify`` (CLI); all three
byte-lock the canonical string against the same fixture, so they cannot drift.

Import it explicitly (``from codespar.mandate import verify_mandate_token``) — it
is not re-exported from the top-level ``codespar`` namespace, keeping the crypto
dependency out of the base import path. Decoding and signing-string
reconstruction are pure stdlib (zero dependencies). Ed25519 *verification* needs
the optional ``cryptography`` extra::

    pip install 'codespar[verify]'

``verify_ed25519`` / ``verify_mandate_token`` (when given a key) raise a clear
``RuntimeError`` if that extra is not installed.
"""

from __future__ import annotations

import base64
import json
import time
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

__all__ = [
    "DecodedMandateToken",
    "MandateDecodeError",
    "MandateVerification",
    "SignatureCheck",
    "agent_did_from_kid",
    "decode_mandate_token",
    "reconstruct_signing_string",
    "verify_ed25519",
    "verify_mandate_token",
]


class MandateDecodeError(ValueError):
    """Raised when a token is not a well-formed mandate presentation token.

    The message is the stable machine code: ``invalid_payload`` or
    ``mandate_format_unsupported``.
    """


@dataclass
class DecodedMandateToken:
    """A decoded token: the signed fields plus the signature envelope."""

    mandate: dict[str, Any]
    # Org-HMAC hex digest. Present on every version; NOT offline-verifiable
    # (needs the org secret) — carried through for completeness.
    signature: str
    agent_sig: str | None = None
    issuer_sig: str | None = None
    kid: str | None = None


@dataclass
class SignatureCheck:
    """Per-signature outcome.

    ``skipped`` = carried but no key supplied; ``absent`` = the token does not
    carry it. Neither is a pass.
    """

    present: bool
    # "verified" | "failed" | "skipped" | "absent"
    status: str
    kid: str | None = None


@dataclass
class MandateVerification:
    """Result of :func:`verify_mandate_token`.

    ``verified`` is ``True`` iff BOTH Ed25519 signatures are carried and
    verify, the agent's under the key the token names, and the token is not
    expired. ``failures`` says why it is ``False`` (empty exactly when it is
    ``True``), with the same codes as ``@codespar/sdk/mandate``: ``kid_mismatch``,
    ``kid_not_in_document``, ``agent_sig_absent`` / ``_unchecked`` /
    ``_invalid``, ``issuer_sig_absent`` / ``_unchecked`` / ``_invalid``,
    ``expired``.
    """

    verified: bool
    mandate: dict[str, Any]
    agent: SignatureCheck
    issuer: SignatureCheck
    agent_did: str | None = None
    # The key the token names: the signed agent_kid (V3+), else the envelope kid.
    kid: str | None = None
    failures: list[str] = field(default_factory=list)
    expired: bool = False
    # V4: the signed issuance time, UNIX seconds.
    issued_at: int | None = None


# Only the formats whose signing string this module knows. A later format
# reconstructed with an older tail would fail as "tampered", which is the wrong
# answer: it is unreadable here, not forged.
_SUPPORTED_FORMATS = (2, 3, 4)


def _b64url_decode(s: str) -> bytes:
    # Node emits base64url without padding; restore it before decoding.
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _s(value: Any) -> str:
    # Absent optional fields render as the empty string so the separator count
    # stays invariant — never the literal "None".
    return "" if value is None else str(value)


def _is_valid_fields(r: dict[str, Any]) -> bool:
    version = r.get("format_version")
    if not isinstance(version, int) or isinstance(version, bool):
        return False
    if not isinstance(r.get("id"), str):
        return False
    if not isinstance(r.get("agent_id"), str):
        return False
    if r.get("type") not in ("payment", "subscription", "delegation"):
        return False
    if not isinstance(r.get("amount"), str):
        return False
    if not isinstance(r.get("currency"), str):
        return False
    if not isinstance(r.get("purposes"), list):
        return False
    expires_at = r.get("expires_at")
    if not isinstance(expires_at, int) or isinstance(expires_at, bool):
        return False
    secret_version = r.get("secret_version")
    if not isinstance(secret_version, int) or isinstance(secret_version, bool):
        return False
    # V3 binds the KYC'd principal and the signing key into the signed string.
    if version in (3, 4):
        if not isinstance(r.get("principal_kyc_ref"), str):
            return False
        if not isinstance(r.get("agent_kid"), str):
            return False
    # V4 adds the signed issuance time.
    if version == 4:
        issued_at = r.get("issued_at")
        if not isinstance(issued_at, int) or isinstance(issued_at, bool):
            return False
    return True


def decode_mandate_token(token: str) -> DecodedMandateToken:
    """Decode a base64url JSON presentation token.

    Splits the envelope (``signature`` / ``agent_sig`` / ``issuer_sig`` / ``kid``)
    from the signed fields so ``mandate`` is exactly the field set the signatures
    cover. Does not verify anything. Raises :class:`MandateDecodeError` on a
    malformed or unsupported token.
    """
    try:
        raw = json.loads(_b64url_decode(token).decode("utf-8"))
    except Exception as exc:
        raise MandateDecodeError("invalid_payload") from exc

    if not isinstance(raw, dict):
        raise MandateDecodeError("invalid_payload")

    version = raw.get("format_version")
    if (
        not isinstance(version, int)
        or isinstance(version, bool)
        or version not in _SUPPORTED_FORMATS
    ):
        raise MandateDecodeError("mandate_format_unsupported")

    if not _is_valid_fields(raw):
        raise MandateDecodeError("invalid_payload")

    signature = raw.get("signature")
    if not isinstance(signature, str):
        raise MandateDecodeError("invalid_payload")

    envelope = {"signature", "agent_sig", "issuer_sig", "kid"}
    mandate: dict[str, Any] = {k: v for k, v in raw.items() if k not in envelope}

    def _str_or_none(key: str) -> str | None:
        value = raw.get(key)
        return value if isinstance(value, str) else None

    return DecodedMandateToken(
        mandate=mandate,
        signature=signature,
        agent_sig=_str_or_none("agent_sig"),
        issuer_sig=_str_or_none("issuer_sig"),
        kid=_str_or_none("kid"),
    )


def reconstruct_signing_string(fields: dict[str, Any]) -> str:
    r"""Reconstruct the canonical signing string the Ed25519 signatures cover.

    Field order: V2 = 12 fields; V3 = V2 + ``principal_kyc_ref`` +
    ``agent_kid`` (14); V4 = V3 with ``issued_at`` inserted before
    ``agent_kid`` (15), so ``agent_kid`` stays last. Absent optionals render
    empty; ``purposes`` is comma-joined after a lexicographic sort with
    escaping (``\`` -> ``\\`` first, then ``,`` -> ``\,``). Colons inside
    ``agent_kid`` (from ``did:web``) are emitted verbatim.
    """

    def esc(member: str) -> str:
        return member.replace("\\", "\\\\").replace(",", "\\,")

    purposes = ",".join(esc(p) for p in sorted(fields.get("purposes") or []))
    version = int(fields.get("format_version") or 0)
    parts = [
        str(fields.get("format_version")),
        _s(fields.get("id")),
        _s(fields.get("agent_id")),
        _s(fields.get("type")),
        _s(fields.get("amount")),
        _s(fields.get("currency")),
        purposes,
        str(fields.get("expires_at")),
        _s(fields.get("max_amount")),
        _s(fields.get("parent_id")),
        _s(fields.get("denomination")),
        str(fields.get("secret_version")),
    ]
    if version >= 3:
        parts.append(_s(fields.get("principal_kyc_ref")))
    if version >= 4:
        parts.append(_s(fields.get("issued_at")))
    if version >= 3:
        parts.append(_s(fields.get("agent_kid")))
    return ":".join(parts)


def verify_ed25519(signing_string: str, signature_b64url: str, pubkey: bytes) -> bool:
    """Verify an Ed25519 signature (base64url) over a signing string.

    Uses only the raw 32-byte public key. Returns ``False`` — never raises — on a
    bad signature or malformed key. Requires the optional ``cryptography``
    dependency; raises ``RuntimeError`` with install guidance if it is absent.
    """
    try:
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives.asymmetric.ed25519 import (
            Ed25519PublicKey,
        )
    except ImportError as exc:
        raise RuntimeError(
            "Ed25519 verification requires the optional 'cryptography' dependency. "
            "Install it with: pip install 'codespar[verify]'"
        ) from exc

    try:
        key = Ed25519PublicKey.from_public_bytes(pubkey)
    except Exception:
        # A malformed key is a verification failure, not an error.
        return False
    try:
        key.verify(_b64url_decode(signature_b64url), signing_string.encode("utf-8"))
        return True
    except InvalidSignature:
        return False


def _to_pubkey(key: str | bytes | bytearray | None) -> bytes | None:
    if key is None:
        return None
    if isinstance(key, str):
        clean = key.strip().lower()
        if clean.startswith("0x"):
            clean = clean[2:]
        if len(clean) != 64 or any(c not in "0123456789abcdef" for c in clean):
            return None
        return bytes.fromhex(clean)
    raw = bytes(key)
    return raw if len(raw) == 32 else None


def agent_did_from_kid(kid: str) -> str:
    """Strip the ``#<fragment>`` from an agent key id to recover the bare DID."""
    idx = kid.find("#")
    return kid if idx == -1 else kid[:idx]


def _key_for_kid(document: Mapping[str, Any], kid: str) -> bytes | None:
    """The raw Ed25519 key a DID document publishes under exactly ``kid``."""
    methods = document.get("verificationMethod")
    if not isinstance(methods, list):
        return None
    for vm in methods:
        if not isinstance(vm, Mapping) or vm.get("id") != kid:
            continue
        jwk = vm.get("publicKeyJwk")
        if (
            not isinstance(jwk, Mapping)
            or jwk.get("kty") != "OKP"
            or jwk.get("crv") != "Ed25519"
            or not isinstance(jwk.get("x"), str)
        ):
            return None
        try:
            pub = _b64url_decode(jwk["x"])
        except Exception:
            return None
        return pub if len(pub) == 32 else None
    return None


def _failure_for(who: str, status: str) -> str:
    suffix = {"absent": "absent", "skipped": "unchecked"}.get(status, "invalid")
    return f"{who}_sig_{suffix}"


def _check_signature(
    signing_string: str,
    sig: str | None,
    pubkey: bytes | None,
    kid: str | None,
) -> SignatureCheck:
    if sig is None:
        return SignatureCheck(present=False, status="absent", kid=kid)
    if pubkey is None:
        return SignatureCheck(present=True, status="skipped", kid=kid)
    ok = verify_ed25519(signing_string, sig, pubkey)
    return SignatureCheck(present=True, status="verified" if ok else "failed", kid=kid)


def verify_mandate_token(
    token: str,
    *,
    agent_public_key: str | bytes | bytearray | None = None,
    agent_did_document: Mapping[str, Any] | None = None,
    issuer_public_key: str | bytes | bytearray | None = None,
    now: float | None = None,
) -> MandateVerification:
    """Offline-verify a V3 or V4 mandate presentation token.

    Pure and network-free. Pass the issuer public key and either the agent
    public key (hex string or raw bytes; passing it asserts it is the key
    published under the token's ``agent_kid``) or the agent's parsed
    ``did:web`` document as ``agent_did_document``, from which only the
    ``verificationMethod`` whose ``id`` equals the signed ``agent_kid`` is
    used. ``now`` is the clock for the expiry check, in UNIX seconds (default:
    the current time).

    ``verified`` is ``True`` only when both signatures are carried and verify
    and the token has not expired; a carried signature with no key is
    ``skipped`` and counts against it. A V2 token carries no Ed25519
    signature and is never verified here.

    Raises :class:`MandateDecodeError` on an undecodable token, ``TypeError``
    when both ``agent_public_key`` and ``agent_did_document`` are given, and
    ``RuntimeError`` if a key is supplied but the ``cryptography`` extra is not
    installed.
    """
    if agent_public_key is not None and agent_did_document is not None:
        raise TypeError("pass agent_public_key or agent_did_document, not both")
    decoded = decode_mandate_token(token)
    mandate = decoded.mandate
    signing_string = reconstruct_signing_string(mandate)
    failures: list[str] = []

    # The signed agent_kid names the key; the envelope kid is an unsigned copy
    # and may not rename it.
    signed_kid_value = mandate.get("agent_kid")
    signed_kid = signed_kid_value if isinstance(signed_kid_value, str) else None
    kid = signed_kid if signed_kid is not None else decoded.kid
    kid_mismatch = signed_kid is not None and decoded.kid is not None and decoded.kid != signed_kid
    agent_did = agent_did_from_kid(kid) if kid is not None else None

    kid_missing = False
    if agent_did_document is not None:
        agent_key = _key_for_kid(agent_did_document, kid) if kid is not None else None
        kid_missing = agent_key is None
    else:
        agent_key = _to_pubkey(agent_public_key)

    if kid_mismatch:
        failures.append("kid_mismatch")
        agent = SignatureCheck(present=decoded.agent_sig is not None, status="failed", kid=kid)
    elif kid_missing and decoded.agent_sig is not None:
        failures.append("kid_not_in_document")
        agent = SignatureCheck(present=True, status="failed", kid=kid)
    else:
        agent = _check_signature(signing_string, decoded.agent_sig, agent_key, kid)
        if agent.status != "verified":
            failures.append(_failure_for("agent", agent.status))

    issuer = _check_signature(
        signing_string,
        decoded.issuer_sig,
        _to_pubkey(issuer_public_key),
        None,
    )
    if issuer.status != "verified":
        failures.append(_failure_for("issuer", issuer.status))

    clock = time.time() if now is None else now
    # The API refuses a mandate only once the clock is past expires_at.
    expired = clock > mandate["expires_at"]
    if expired:
        failures.append("expired")

    issued_at_value = mandate.get("issued_at")
    return MandateVerification(
        verified=not failures,
        mandate=mandate,
        agent=agent,
        issuer=issuer,
        agent_did=agent_did,
        kid=kid,
        failures=failures,
        expired=expired,
        issued_at=issued_at_value if isinstance(issued_at_value, int) else None,
    )
