"""
AgentGate type-narrowed helpers — Python parallel of agent-gate.ts.

Mirrors the TypeScript surface 1:1: five frozen dataclasses, five
discriminant constants, the ``AgentGateCode`` Literal union, the
``AGENT_GATE_CODES`` frozenset, five PEP 647 ``TypeGuard``
predicates, and ``assert_exhaustive_agent_gate``.

Each guard checks both the ``code`` discriminant against
``AGENT_GATE_CODES`` AND its own required sibling fields. A
payload with a well-formed ``code`` but a missing sibling returns
False rather than narrowing positive on the discriminant alone —
the test suite enforces this invariant per guard.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Final, Literal, TypeGuard

# ── discriminant constants ────────────────────────────────────────

POLICY_DENIED: Final[Literal["policy_denied"]] = "policy_denied"
APPROVAL_REQUIRED: Final[Literal["approval_required"]] = "approval_required"
MOCKS_EXHAUSTED: Final[Literal["mocks_exhausted"]] = "mocks_exhausted"
MOCKS_ENGINE_ERROR: Final[Literal["mocks_engine_error"]] = "mocks_engine_error"
TOOL_NOT_MOCKED: Final[Literal["tool_not_mocked"]] = "tool_not_mocked"

AgentGateCode = Literal[
    "policy_denied",
    "approval_required",
    "mocks_exhausted",
    "mocks_engine_error",
    "tool_not_mocked",
]

AGENT_GATE_CODES: Final[frozenset[str]] = frozenset(
    [
        POLICY_DENIED,
        APPROVAL_REQUIRED,
        MOCKS_EXHAUSTED,
        MOCKS_ENGINE_ERROR,
        TOOL_NOT_MOCKED,
    ]
)


# ── output dataclasses (frozen, slotted) ──────────────────────────


@dataclass(slots=True, frozen=True)
class PolicyDeniedOutput:
    rule_id: str
    message: str
    code: Literal["policy_denied"] = POLICY_DENIED


@dataclass(slots=True, frozen=True)
class ApprovalRequiredOutput:
    approval_id: str
    expires_at: str
    message: str
    code: Literal["approval_required"] = APPROVAL_REQUIRED


@dataclass(slots=True, frozen=True)
class MocksExhaustedOutput:
    message: str
    code: Literal["mocks_exhausted"] = MOCKS_EXHAUSTED


@dataclass(slots=True, frozen=True)
class MocksEngineErrorOutput:
    message: str
    code: Literal["mocks_engine_error"] = MOCKS_ENGINE_ERROR


@dataclass(slots=True, frozen=True)
class ToolNotMockedOutput:
    tool_name: str
    message: str
    code: Literal["tool_not_mocked"] = TOOL_NOT_MOCKED


AgentGateToolResultOutput = (
    PolicyDeniedOutput
    | ApprovalRequiredOutput
    | MocksExhaustedOutput
    | MocksEngineErrorOutput
    | ToolNotMockedOutput
)


# ── guards ────────────────────────────────────────────────────────


def _is_object(value: Any) -> TypeGuard[dict[str, Any]]:
    return isinstance(value, dict)


def _has_str(obj: dict[str, Any], key: str) -> bool:
    return isinstance(obj.get(key), str)


def is_policy_denied(value: Any) -> TypeGuard[dict[str, Any]]:
    if not _is_object(value):
        return False
    code = value.get("code")
    if code != POLICY_DENIED or code not in AGENT_GATE_CODES:
        return False
    return _has_str(value, "rule_id") and _has_str(value, "message")


def is_approval_required(value: Any) -> TypeGuard[dict[str, Any]]:
    if not _is_object(value):
        return False
    code = value.get("code")
    if code != APPROVAL_REQUIRED or code not in AGENT_GATE_CODES:
        return False
    return (
        _has_str(value, "approval_id")
        and _has_str(value, "expires_at")
        and _has_str(value, "message")
    )


def is_mocks_exhausted(value: Any) -> TypeGuard[dict[str, Any]]:
    if not _is_object(value):
        return False
    code = value.get("code")
    if code != MOCKS_EXHAUSTED or code not in AGENT_GATE_CODES:
        return False
    return _has_str(value, "message")


def is_mocks_engine_error(value: Any) -> TypeGuard[dict[str, Any]]:
    if not _is_object(value):
        return False
    code = value.get("code")
    if code != MOCKS_ENGINE_ERROR or code not in AGENT_GATE_CODES:
        return False
    return _has_str(value, "message")


def is_tool_not_mocked(value: Any) -> TypeGuard[dict[str, Any]]:
    if not _is_object(value):
        return False
    code = value.get("code")
    if code != TOOL_NOT_MOCKED or code not in AGENT_GATE_CODES:
        return False
    return _has_str(value, "tool_name") and _has_str(value, "message")


def assert_exhaustive_agent_gate(value: Any) -> None:
    """Raise on any AgentGate payload not matched by the five guards.

    Equivalent to TypeScript's ``assertExhaustiveAgentGate(value: never)``
    — call from a default branch after handling each variant so a sixth
    code landing without a handler trips at the boundary instead of
    being silently swallowed.
    """
    raise AssertionError(
        f"agent-gate: unexpected output variant {value!r}",
    )
