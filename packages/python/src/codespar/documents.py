"""
``cs.receipts`` and ``cs.account`` — documents on demand.

The payment receipt (comprovante) of a sealed receipt, as PDF or PNG, and
the account statement (extrato) of a period, as PDF. Mirrors ``cs.receipts``
and ``cs.account`` in the TypeScript SDK (CONTRATO-documentos, 26/10/2026).

Both are reads: generating or downloading a document never repeats a
payment. The API serves a receipt document only for a confirmed payment
(``ApiError`` 409 ``document_not_final`` otherwise) and a statement only
when it reconciles (500 ``statement_not_reconciled``). ``sha256`` is the
API's hash of the document's content: the same receipt answers the same
value on every call.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Literal, TypedDict
from urllib.parse import quote, urlencode

import httpx

from ._http import request_bytes
from .errors import ApiError

if TYPE_CHECKING:
    from ._sync_client import _LoopRunner

DocumentFormat = Literal["pdf", "png"]


class Document(TypedDict):
    """A downloaded document: the bytes, their type, the server's file name and the content hash."""

    bytes: bytes
    content_type: str
    filename: str
    sha256: str | None


_DISPOSITION = re.compile(r"filename\*?=(?:UTF-8'')?\"?([^\";]+)\"?", re.IGNORECASE)


def filename_from_disposition(header: str | None) -> str | None:
    """The filename a ``Content-Disposition`` header names.

    ``comprovante-rcpt_x.pdf`` out of ``attachment; filename="comprovante-rcpt_x.pdf"``;
    None when the header is absent or the name is a path.
    """
    if not header:
        return None
    m = _DISPOSITION.search(header)
    name = m.group(1).strip() if m else None
    if not name or "/" in name or "\\" in name:
        return None
    return name


def _document(response: httpx.Response, fallback_name: str, accept: str) -> Document:
    content_type = (response.headers.get("content-type") or accept).split(";")[0].strip()
    return Document(
        bytes=response.content,
        content_type=content_type,
        filename=filename_from_disposition(response.headers.get("content-disposition"))
        or fallback_name,
        sha256=response.headers.get("x-codespar-document-sha256"),
    )


class AsyncReceipts:
    """``GET /v1/consumers/receipts/:id/document``."""

    def __init__(self, client: httpx.AsyncClient, api_key: str, project_id: str | None) -> None:
        self._client = client
        self._api_key = api_key
        self._project_id = project_id

    async def document(
        self,
        receipt_id: str,
        *,
        format: DocumentFormat = "pdf",
        timeout: float | None = None,
    ) -> Document:
        """The comprovante of the payment this receipt seals.

        ``pdf`` (default, one page of 600x828 pt) or ``png`` (the same page as an image, 2x).
        """
        if not receipt_id:
            raise ApiError(
                "receipts.document: receipt_id is required", status=0, code="invalid_args"
            )
        if format not in ("pdf", "png"):
            raise ApiError(
                "receipts.document: format must be pdf or png", status=0, code="invalid_args"
            )
        accept = "application/pdf" if format == "pdf" else "image/png"
        path = f"/v1/consumers/receipts/{quote(receipt_id, safe='')}/document?format={format}"
        response = await request_bytes(
            self._client,
            path,
            api_key=self._api_key,
            project_id=self._project_id,
            accept=accept,
            timeout=timeout,
        )
        return _document(response, f"comprovante-{receipt_id}.{format}", accept)


class AsyncAccount:
    """``GET /v1/account/statement``."""

    def __init__(self, client: httpx.AsyncClient, api_key: str, project_id: str | None) -> None:
        self._client = client
        self._api_key = api_key
        self._project_id = project_id

    async def statement(
        self,
        from_date: str,
        to_date: str,
        *,
        format: Literal["pdf"] = "pdf",
        currency: str | None = None,
        timeout: float | None = None,
    ) -> Document:
        """The extrato of the project's account over ``[from_date, to_date]``.

        Calendar days as ``YYYY-MM-DD``, ``to_date`` inclusive, at most 92 days.
        """
        if not from_date or not to_date:
            raise ApiError(
                "account.statement: from_date and to_date are required (YYYY-MM-DD)",
                status=0,
                code="invalid_args",
            )
        query = {"from": from_date, "to": to_date, "format": format}
        if currency:
            query["currency"] = currency
        path = f"/v1/account/statement?{urlencode(query)}"
        response = await request_bytes(
            self._client,
            path,
            api_key=self._api_key,
            project_id=self._project_id,
            accept="application/pdf",
            timeout=timeout,
        )
        return _document(response, f"extrato-{from_date}-{to_date}.pdf", "application/pdf")


class Receipts:
    """Sync wrapper of :class:`AsyncReceipts`."""

    def __init__(self, inner: AsyncReceipts, runner: _LoopRunner) -> None:
        self._inner = inner
        self._runner = runner

    def document(
        self, receipt_id: str, *, format: DocumentFormat = "pdf", timeout: float | None = None
    ) -> Document:
        return self._runner.run(self._inner.document(receipt_id, format=format, timeout=timeout))


class Account:
    """Sync wrapper of :class:`AsyncAccount`."""

    def __init__(self, inner: AsyncAccount, runner: _LoopRunner) -> None:
        self._inner = inner
        self._runner = runner

    def statement(
        self,
        from_date: str,
        to_date: str,
        *,
        format: Literal["pdf"] = "pdf",
        currency: str | None = None,
        timeout: float | None = None,
    ) -> Document:
        return self._runner.run(
            self._inner.statement(
                from_date, to_date, format=format, currency=currency, timeout=timeout
            )
        )
