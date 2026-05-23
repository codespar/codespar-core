"""
AgentGate guard tests — Python parallel of agent-gate.test.ts.

Asserts the same surface: five output dataclasses, five
discriminant constants, the AgentGateCode literal union, the
_AGENT_GATE_CODES frozenset, five PEP 647 TypeGuard predicates,
and assert_exhaustive_agent_gate.

Round-trip parity: the same fixtures used in the TS test exercise
the Python guards and agree on every outcome.
"""

from __future__ import annotations

from typing import Any

import pytest

from codespar.agent_gate import (
    AGENT_GATE_CODES,
    APPROVAL_REQUIRED,
    MOCKS_ENGINE_ERROR,
    MOCKS_EXHAUSTED,
    POLICY_DENIED,
    TOOL_NOT_MOCKED,
    assert_exhaustive_agent_gate,
    is_approval_required,
    is_mocks_engine_error,
    is_mocks_exhausted,
    is_policy_denied,
    is_tool_not_mocked,
)


def test_agent_gate_codes_frozenset_includes_five() -> None:
    assert POLICY_DENIED in AGENT_GATE_CODES
    assert APPROVAL_REQUIRED in AGENT_GATE_CODES
    assert MOCKS_EXHAUSTED in AGENT_GATE_CODES
    assert MOCKS_ENGINE_ERROR in AGENT_GATE_CODES
    assert TOOL_NOT_MOCKED in AGENT_GATE_CODES
    assert len(AGENT_GATE_CODES) == 5


class TestPolicyDenied:
    def test_positive(self) -> None:
        out: Any = {"code": POLICY_DENIED, "rule_id": "spend_cap", "message": "boom"}
        assert is_policy_denied(out) is True

    def test_missing_rule_id(self) -> None:
        out: Any = {"code": POLICY_DENIED, "message": "boom"}
        assert is_policy_denied(out) is False

    def test_missing_message(self) -> None:
        out: Any = {"code": POLICY_DENIED, "rule_id": "spend_cap"}
        assert is_policy_denied(out) is False

    def test_foreign_discriminant(self) -> None:
        out: Any = {"code": APPROVAL_REQUIRED, "rule_id": "x", "message": "y"}
        assert is_policy_denied(out) is False

    def test_unknown_code(self) -> None:
        out: Any = {"code": "totally_made_up", "rule_id": "x", "message": "y"}
        assert is_policy_denied(out) is False

    def test_non_dict(self) -> None:
        assert is_policy_denied(None) is False
        assert is_policy_denied("policy_denied") is False
        assert is_policy_denied(42) is False


class TestApprovalRequired:
    def test_positive(self) -> None:
        out: Any = {
            "code": APPROVAL_REQUIRED,
            "approval_id": "apr_abc",
            "expires_at": "2026-12-01T00:00:00Z",
            "message": "approve",
        }
        assert is_approval_required(out) is True

    def test_missing_approval_id(self) -> None:
        out: Any = {
            "code": APPROVAL_REQUIRED,
            "expires_at": "2026-12-01T00:00:00Z",
            "message": "x",
        }
        assert is_approval_required(out) is False

    def test_missing_expires_at(self) -> None:
        out: Any = {"code": APPROVAL_REQUIRED, "approval_id": "apr_abc", "message": "x"}
        assert is_approval_required(out) is False

    def test_missing_message(self) -> None:
        out: Any = {
            "code": APPROVAL_REQUIRED,
            "approval_id": "apr_abc",
            "expires_at": "x",
        }
        assert is_approval_required(out) is False


class TestMocksExhaustedAndEngineError:
    def test_mocks_exhausted_positive(self) -> None:
        assert (
            is_mocks_exhausted({"code": MOCKS_EXHAUSTED, "message": "drained"}) is True
        )

    def test_mocks_exhausted_missing_message(self) -> None:
        assert is_mocks_exhausted({"code": MOCKS_EXHAUSTED}) is False

    def test_mocks_engine_error_positive(self) -> None:
        assert (
            is_mocks_engine_error(
                {"code": MOCKS_ENGINE_ERROR, "message": "consume failed"}
            )
            is True
        )

    def test_mocks_engine_error_missing_message(self) -> None:
        assert is_mocks_engine_error({"code": MOCKS_ENGINE_ERROR}) is False


class TestToolNotMocked:
    def test_positive(self) -> None:
        out: Any = {
            "code": TOOL_NOT_MOCKED,
            "tool_name": "asaas/create_payment",
            "message": "not in mocks",
        }
        assert is_tool_not_mocked(out) is True

    def test_missing_tool_name(self) -> None:
        out: Any = {"code": TOOL_NOT_MOCKED, "message": "x"}
        assert is_tool_not_mocked(out) is False


def test_assert_exhaustive_agent_gate_raises_on_unknown() -> None:
    with pytest.raises(AssertionError, match="agent-gate"):
        assert_exhaustive_agent_gate({"code": "rogue"})  # type: ignore[arg-type]


def test_round_trip_corpus_agrees_with_ts_guards() -> None:
    """The shared fixture below mirrors the TS describe blocks."""
    corpus = [
        ({"code": POLICY_DENIED, "rule_id": "x", "message": "y"}, "policy"),
        ({"code": POLICY_DENIED, "message": "missing rule"}, None),
        (
            {
                "code": APPROVAL_REQUIRED,
                "approval_id": "a",
                "expires_at": "t",
                "message": "m",
            },
            "approval",
        ),
        ({"code": MOCKS_EXHAUSTED, "message": "drained"}, "exhausted"),
        ({"code": MOCKS_ENGINE_ERROR, "message": "boom"}, "engine"),
        (
            {"code": TOOL_NOT_MOCKED, "tool_name": "asaas/x", "message": "m"},
            "not_mocked",
        ),
        ({"code": "unknown_variant"}, None),
    ]

    def label(value: dict[str, Any]) -> str | None:
        if is_policy_denied(value):
            return "policy"
        if is_approval_required(value):
            return "approval"
        if is_mocks_exhausted(value):
            return "exhausted"
        if is_mocks_engine_error(value):
            return "engine"
        if is_tool_not_mocked(value):
            return "not_mocked"
        return None

    for value, expected in corpus:
        assert label(value) == expected
