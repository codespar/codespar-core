"""
``cs.receipts`` and ``cs.account`` — documents on demand.

The payment receipt (comprovante) of a sealed receipt, as PDF or PNG, and
the account statement (extrato) of a period, as PDF or as PNG pages. Mirrors ``cs.receipts``
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


class StatementDocument(Document):
    """A statement: for a PNG page, ``pages`` is how many PNG pages it has.

    Read from ``X-CodeSpar-Document-Pages``; None for the PDF, which has no such header.
    """

    pages: int | None


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


def _pages(header: str | None) -> int | None:
    if header is None or not header.strip().isdigit():
        return None
    n = int(header)
    return n if n >= 1 else None


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
        format: DocumentFormat = "pdf",
        page: int | None = None,
        currency: str | None = None,
        timeout: float | None = None,
    ) -> StatementDocument:
        """The extrato of the project's account over ``[from_date, to_date]``.

        Calendar days as ``YYYY-MM-DD``, ``to_date`` inclusive, at most 92 days.
        ``pdf`` (default) is the whole period; ``png`` is ONE page as an image,
        chosen by ``page`` (1-based, default 1; 25 lines a page, at most 8
        pages). ``pages`` on the answer says how many there are; a page past
        the last raises 404 ``statement_page_not_found``.
        """
        if not from_date or not to_date:
            raise ApiError(
                "account.statement: from_date and to_date are required (YYYY-MM-DD)",
                status=0,
                code="invalid_args",
            )
        if format not in ("pdf", "png"):
            raise ApiError(
                "account.statement: format must be pdf or png", status=0, code="invalid_args"
            )
        if page is not None and (
            format != "png" or isinstance(page, bool) or not isinstance(page, int) or page < 1
        ):
            raise ApiError(
                "account.statement: page is a whole number, 1 or more, with format png",
                status=0,
                code="invalid_args",
            )
        query = {"from": from_date, "to": to_date, "format": format}
        if format == "png":
            query["page"] = str(page or 1)
        if currency:
            query["currency"] = currency
        path = f"/v1/account/statement?{urlencode(query)}"
        accept = "application/pdf" if format == "pdf" else "image/png"
        response = await request_bytes(
            self._client,
            path,
            api_key=self._api_key,
            project_id=self._project_id,
            accept=accept,
            timeout=timeout,
        )
        name = (
            f"extrato-{from_date}-{to_date}.pdf"
            if format == "pdf"
            else f"extrato-{from_date}-{to_date}-p{page or 1}.png"
        )
        doc = _document(response, name, accept)
        return StatementDocument(
            **doc, pages=_pages(response.headers.get("x-codespar-document-pages"))
        )


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
        format: DocumentFormat = "pdf",
        page: int | None = None,
        currency: str | None = None,
        timeout: float | None = None,
    ) -> StatementDocument:
        return self._runner.run(
            self._inner.statement(
                from_date, to_date, format=format, page=page, currency=currency, timeout=timeout
            )
        )
