"""
Exception hierarchy for the CodeSpar SDK.

Kept shallow — one ``CodeSparError`` root with a handful of
specialised subclasses. Every network / API failure is wrapped so
callers can ``except CodeSparError`` without catching the raw httpx
exception tree (which would bleed the transport into user code).
"""

from __future__ import annotations

from typing import Any


class CodeSparError(Exception):
    """Base class for every error raised by the SDK."""

    def __init__(self, message: str, *, cause: BaseException | None = None):
        super().__init__(message)
        self.__cause__ = cause


class ApiError(CodeSparError):
    """HTTP-level failure returned by the CodeSpar backend."""

    def __init__(
        self,
        message: str,
        *,
        status: int,
        body: Any = None,
        code: str | None = None,
    ):
        super().__init__(message)
        self.status = status
        self.body = body
        self.code = code


#: What the person is told before a key is deleted (the TypeScript SDK exports the same).
PIX_KEY_DELETE_CONSEQUENCE = "Depois de excluída, esta chave deixa de apontar para esta conta."


class PixKeyDeleteNotConfirmedError(CodeSparError):
    """``cs.wallet.pix_keys.delete`` was called without ``confirm=True``: nothing was sent."""

    code = "pix_key_delete_requires_confirmation"
    consequence = PIX_KEY_DELETE_CONSEQUENCE

    def __init__(self, key: str):
        super().__init__(
            "pix_keys.delete needs confirm=True after the person confirmed. "
            f"{self.consequence} Nothing was sent."
        )
        self.key = key


class ConfigError(CodeSparError):
    """Raised when the SDK is constructed with invalid / missing config."""


class NotConnectedError(CodeSparError):
    """Raised when an operation needs a connected session that isn't ready."""


class StreamError(CodeSparError):
    """Raised when the SSE stream itself fails (parse / transport)."""


class TimeoutError(CodeSparError):
    """Raised when a request exceeds its timeout (unary or stream idle)."""
