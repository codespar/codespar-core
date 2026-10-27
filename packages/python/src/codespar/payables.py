"""
``cs.payables`` — pay documents and batches.

Upload files (boleto PDFs, Pix QR images, CSV/XLSX lists), build a
batch, complement what the files did not say, and pay the exact list
you reviewed. Mirrors ``cs.payables`` in the TypeScript SDK; responses
are the wire shape as typed dicts.

Paying binds to the list's ``version`` and ``list_hash``: any change
after you read the batch makes ``pay`` raise ``ApiError`` with status
409 and code ``payable_batch_version_mismatch``, and
``payable_batch_from_error`` returns the current batch from it.
Repeating ``pay`` with the same version and hash resumes; it never pays
an item twice.
"""

from __future__ import annotations

import mimetypes
import os
import uuid
from typing import IO, TYPE_CHECKING, Any, Literal, TypedDict, Union
from urllib.parse import quote

import httpx

from ._http import request_json
from .errors import ApiError

if TYPE_CHECKING:
    from ._sync_client import _LoopRunner

PayableBatchStatus = Literal[
    "reviewing",
    "ready",
    "confirmed",
    "executing",
    "completed",
    "partially_completed",
    "failed",
    "canceled",
]

PayableBatchItemState = Literal[
    "needs_complement",
    "resolving",
    "ready",
    "excluded",
    "rejected",
    "dispatching",
    "executed",
    "refused",
    "uncertain",
]

PayableBatchSource = Literal["api", "chat", "dashboard", "cli", "mcp"]

#: A path, raw bytes, or a binary file object opened for reading.
UploadFile = Union[str, "os.PathLike[str]", bytes, bytearray, memoryview, IO[bytes]]


class PayableFile(TypedDict):
    """A file read by ``POST /v1/payables/files``. Only its digest and findings are kept."""

    file_id: str
    kind: Literal["pdf", "image", "csv", "xlsx"]
    sha256: str
    size_bytes: int
    items_found: int
    unresolved: int
    expires_at: str


class _PayableBatchItemCheckRequired(TypedDict):
    code: str
    status: Literal["pass", "fail", "warn"]
    message: str


class PayableBatchItemCheck(_PayableBatchItemCheckRequired, total=False):
    #: True when a test project's own responder answered the consult, not the rail.
    simulated: bool


class PayableBatchItemRefusal(TypedDict):
    code: str
    message: str


class PayableBatchItemPayment(TypedDict):
    state: Literal["executed", "refused", "uncertain"]
    attempt_id: str | None
    receipt_id: str | None
    end_to_end_id: str | None
    refusal: PayableBatchItemRefusal | None


class PayableBatchItemOrigin(TypedDict):
    file_id: str | None
    page: int | None
    row: int | None
    kind: Literal[
        "boleto_line",
        "br_code",
        "pix_key",
        "qr_image",
        "barcode_image",
        "csv_row",
        "manual",
        "document",
    ]


PayableWayRail = Literal["pix", "boleto"]


class PayableBatchItemWayUnavailable(TypedDict):
    """Why a way cannot be paid now (payables v1.1): ``br_code_expired``,
    ``br_code_not_found``, ``boleto_expired``, ``boleto_refused``,
    ``rail_unavailable`` or ``no_sandbox_fixture``; the message is the person's."""

    code: str
    message: str


class PayableBatchItemWayOrigin(TypedDict):
    page: int | None
    kind: str


class PayableBatchItemWay(TypedDict):
    """One way of paying the item (payables v1.1). Two when one page printed a
    boleto and a Pix code for the same bill: one item, paid once, through
    ``rail``; choose with ``update_item(..., rail=...)``."""

    rail: PayableWayRail
    origin: PayableBatchItemWayOrigin
    destination: "PayableBatchItemDestination | None"
    unavailable: PayableBatchItemWayUnavailable | None


class PayableBatchItemDocument(TypedDict):
    """What the page says about the document (payables v1.1): shown as such,
    never confirmed in place of the rail's values."""

    title: str | None
    issuer: str | None
    due_date: str | None
    amount_minor: int | None


class _PayableBatchItemDestinationRequired(TypedDict):
    kind: Literal["boleto", "pix_key", "br_code_static", "br_code_dynamic"]
    display: str
    beneficiary_name: str | None
    beneficiary_document_masked: str | None
    due_date: str | None


class PayableBatchItemDestination(_PayableBatchItemDestinationRequired, total=False):
    """``beneficiary_institution`` and ``key`` since payables v1.1 (rule 6b):
    the payee's institution name when the resolution returns one, and a Pix
    destination's FULL key for a person's confirmation step only (show it
    nowhere else; lists and anything a model reads keep ``display``)."""

    beneficiary_institution: str | None
    key: str | None


class PayableBatchItem(TypedDict):
    item_id: str
    position: int
    origin: PayableBatchItemOrigin
    rail: Literal["boleto", "pix"] | None
    rail_chosen_by: Literal["default", "person", "integration"]
    ways: list[PayableBatchItemWay]
    document: PayableBatchItemDocument | None
    state: PayableBatchItemState
    missing: list[Literal["amount", "destination", "pix_key_owner_confirmation", "rail"]]
    destination: PayableBatchItemDestination | None
    amount_minor: int | None
    amount_source: (
        Literal["rail_quote", "br_code", "stated_by_person", "csv", "document"] | None
    )
    description: str | None
    reference: str | None
    checks: list[PayableBatchItemCheck]
    payment: PayableBatchItemPayment | None


class PayableBatchTotals(TypedDict):
    items: int
    payable_items: int
    excluded: int
    amount_minor: int


class PayableBatchConfirmation(TypedDict):
    version: int
    list_hash: str
    confirmed_by: str
    confirmed_at: str
    mandate_id: str


class PayableBatch(TypedDict):
    batch_id: str
    status: PayableBatchStatus
    version: int
    list_hash: str
    currency: Literal["BRL"]
    totals: PayableBatchTotals
    confirmation: PayableBatchConfirmation | None
    items: list[PayableBatchItem]
    created_at: str
    source: PayableBatchSource
    conversation_id: str | None


class PayableBatchCreated(PayableBatch):
    """``batches.create``: the batch, and whether it replays an earlier call with the same key."""

    idempotent_replay: bool


class PayableItemInput(TypedDict, total=False):
    """A charge stated directly instead of read from a file. One carrier per item.

    ``amount_minor`` is required with a bare ``pix_key``: the key never
    determines the amount.
    """

    pix_key: str
    boleto_line: str
    br_code: str
    amount_minor: int
    description: str
    reference: str


def payable_batch_from_error(err: BaseException) -> PayableBatch | None:
    """The current batch a 409 version conflict/mismatch carries in
    ``error.details.batch``, else ``None``."""
    if not isinstance(err, ApiError) or err.status != 409:
        return None
    body = err.body
    error = body.get("error") if isinstance(body, dict) else None
    details = error.get("details") if isinstance(error, dict) else None
    batch = details.get("batch") if isinstance(details, dict) else None
    if isinstance(batch, dict):
        return batch  # type: ignore[return-value]
    return None


def _read_upload(
    file: UploadFile, filename: str | None, content_type: str | None
) -> tuple[str, bytes, str]:
    name: str | None = filename
    if isinstance(file, (str, os.PathLike)):
        path = os.fspath(file)
        with open(path, "rb") as fh:
            content = fh.read()
        name = name or os.path.basename(path)
    elif isinstance(file, (bytes, bytearray, memoryview)):
        content = bytes(file)
    elif hasattr(file, "read"):
        data = file.read()
        if not isinstance(data, (bytes, bytearray)):
            raise TypeError("upload file object must be opened in binary mode")
        content = bytes(data)
        raw_name = getattr(file, "name", None)
        if not name and isinstance(raw_name, str) and raw_name:
            name = os.path.basename(raw_name)
    else:
        raise TypeError("upload file must be a path, bytes or a binary file object")
    name = name or "document"
    # The API decides by magic bytes; the part type is a hint only.
    ctype = content_type or mimetypes.guess_type(name)[0] or "application/octet-stream"
    return name, content, ctype


def _drop_none(values: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in values.items() if v is not None}


class _Transport:
    def __init__(self, client: httpx.AsyncClient, api_key: str, project_id: str | None) -> None:
        self._client = client
        self._api_key = api_key
        self._project_id = project_id

    async def call(
        self,
        method: str,
        path: str,
        *,
        body: Any = None,
        files: dict[str, tuple[str, bytes, str]] | None = None,
        headers: dict[str, str] | None = None,
        timeout: float | None = None,
    ) -> Any:
        data = await request_json(
            self._client,
            method,
            path,
            api_key=self._api_key,
            project_id=self._project_id,
            body=body,
            files=files,
            extra_headers=headers,
            timeout=timeout,
        )
        if not isinstance(data, dict):
            raise ApiError(f"{method} {path}: malformed response", status=0, body=data)
        return data


def _quote(segment: str) -> str:
    return quote(segment, safe="")


def _batch_path(batch_id: str) -> str:
    return f"/v1/payables/batches/{_quote(batch_id)}"


class AsyncPayablesFiles:
    def __init__(self, transport: _Transport) -> None:
        self._t = transport

    async def upload(
        self,
        file: UploadFile,
        *,
        filename: str | None = None,
        content_type: str | None = None,
        timeout: float | None = None,
    ) -> PayableFile:
        """``POST /v1/payables/files``: one file, read in the request.

        10 MB, 10 PDF pages, 500 CSV/XLSX rows.
        """
        part = _read_upload(file, filename, content_type)
        data: PayableFile = await self._t.call(
            "POST", "/v1/payables/files", files={"file": part}, timeout=timeout
        )
        return data


class AsyncPayablesBatches:
    def __init__(self, transport: _Transport) -> None:
        self._t = transport

    async def create(
        self,
        *,
        file_ids: list[str] | None = None,
        items: list[PayableItemInput] | None = None,
        source: PayableBatchSource | None = None,
        conversation_id: str | None = None,
        idempotency_key: str | None = None,
        timeout: float | None = None,
    ) -> PayableBatchCreated:
        """``POST /v1/payables/batches``.

        Pass your own ``idempotency_key`` to make a retry return the same
        batch; without one a fresh key is generated per call.
        """
        body = _drop_none(
            {
                "file_ids": file_ids,
                "items": [dict(i) for i in items] if items is not None else None,
                "source": source,
                "conversation_id": conversation_id,
            }
        )
        data: PayableBatchCreated = await self._t.call(
            "POST",
            "/v1/payables/batches",
            body=body,
            headers={"Idempotency-Key": idempotency_key or str(uuid.uuid4())},
            timeout=timeout,
        )
        return data

    async def get(self, batch_id: str, *, timeout: float | None = None) -> PayableBatch:
        """``GET /v1/payables/batches/:batch_id``."""
        data: PayableBatch = await self._t.call("GET", _batch_path(batch_id), timeout=timeout)
        return data

    async def update_item(
        self,
        batch_id: str,
        item_id: str,
        *,
        expected_version: int,
        amount_minor: int | None = None,
        pix_key: str | None = None,
        boleto_line: str | None = None,
        br_code: str | None = None,
        description: str | None = None,
        excluded: bool | None = None,
        rail: PayableWayRail | None = None,
        timeout: float | None = None,
    ) -> PayableBatch:
        """``PATCH /v1/payables/batches/:batch_id/items/:item_id``.

        A stale ``expected_version`` raises 409 ``payable_batch_version_conflict``.
        ``rail`` chooses the way of an item that has two (``ways``, payables
        v1.1); a way the item lacks or that is unavailable raises 409
        ``payable_item_rail_unavailable`` (``error.details.unavailable``).
        """
        body = _drop_none(
            {
                "expected_version": expected_version,
                "amount_minor": amount_minor,
                "pix_key": pix_key,
                "boleto_line": boleto_line,
                "br_code": br_code,
                "description": description,
                "excluded": excluded,
                "rail": rail,
            }
        )
        data: PayableBatch = await self._t.call(
            "PATCH",
            f"{_batch_path(batch_id)}/items/{_quote(item_id)}",
            body=body,
            timeout=timeout,
        )
        return data

    async def add_items(
        self,
        batch_id: str,
        *,
        expected_version: int,
        file_ids: list[str] | None = None,
        items: list[PayableItemInput] | None = None,
        timeout: float | None = None,
    ) -> PayableBatch:
        """``POST /v1/payables/batches/:batch_id/items``."""
        body = _drop_none(
            {
                "expected_version": expected_version,
                "file_ids": file_ids,
                "items": [dict(i) for i in items] if items is not None else None,
            }
        )
        data: PayableBatch = await self._t.call(
            "POST", f"{_batch_path(batch_id)}/items", body=body, timeout=timeout
        )
        return data

    async def pay(
        self,
        batch_id: str,
        *,
        version: int,
        list_hash: str,
        mandate_id: str | None = None,
        idempotency_key: str | None = None,
        timeout: float | None = None,
    ) -> PayableBatch:
        """``POST /v1/payables/batches/:batch_id/pay``: confirm the exact list and pay it.

        Each item carries its own ``payment``; a refused line does not stop
        the others. The default idempotency key is derived from the batch,
        version and hash, so a retry of the same confirmation is the same
        request. While the API answers ``executing`` with items still
        ``ready`` (its ~20 s budget per call), the same call is repeated, up
        to 30 times; the batch returned is the last answer.
        """
        body = _drop_none({"version": version, "list_hash": list_hash, "mandate_id": mandate_id})
        key = idempotency_key or f"pay:{batch_id}:{version}:{list_hash}"
        data: PayableBatch = await self._t.call(
            "POST",
            f"{_batch_path(batch_id)}/pay",
            body=body,
            headers={"Idempotency-Key": key},
            timeout=timeout,
        )
        # Nothing runs on the server after an answer: items never sent wait
        # for the next call, which returns paid items as they are and looks
        # an uncertain one up, never resending it.
        rounds = 1
        while rounds < _PAY_MAX_ROUNDS and _continues_on_repeat(data):
            data = await self._t.call(
                "POST",
                f"{_batch_path(batch_id)}/pay",
                body=body,
                headers={"Idempotency-Key": key},
                timeout=timeout,
            )
            rounds += 1
        return data


_PAY_MAX_ROUNDS = 30


def _continues_on_repeat(batch: PayableBatch) -> bool:
    """A pay call stopped at its time budget with items never sent."""
    items = batch.get("items", [])
    return batch.get("status") == "executing" and any(i.get("state") == "ready" for i in items)


class AsyncPayables:
    """``cs.payables`` on ``AsyncCodeSpar``."""

    def __init__(self, client: httpx.AsyncClient, api_key: str, project_id: str | None) -> None:
        transport = _Transport(client, api_key, project_id)
        self.files = AsyncPayablesFiles(transport)
        self.batches = AsyncPayablesBatches(transport)


class PayablesFiles:
    def __init__(self, inner: AsyncPayablesFiles, runner: _LoopRunner) -> None:
        self._inner = inner
        self._runner = runner

    def upload(
        self,
        file: UploadFile,
        *,
        filename: str | None = None,
        content_type: str | None = None,
        timeout: float | None = None,
    ) -> PayableFile:
        return self._runner.run(
            self._inner.upload(file, filename=filename, content_type=content_type, timeout=timeout)
        )


class PayablesBatches:
    def __init__(self, inner: AsyncPayablesBatches, runner: _LoopRunner) -> None:
        self._inner = inner
        self._runner = runner

    def create(
        self,
        *,
        file_ids: list[str] | None = None,
        items: list[PayableItemInput] | None = None,
        source: PayableBatchSource | None = None,
        conversation_id: str | None = None,
        idempotency_key: str | None = None,
        timeout: float | None = None,
    ) -> PayableBatchCreated:
        return self._runner.run(
            self._inner.create(
                file_ids=file_ids,
                items=items,
                source=source,
                conversation_id=conversation_id,
                idempotency_key=idempotency_key,
                timeout=timeout,
            )
        )

    def get(self, batch_id: str, *, timeout: float | None = None) -> PayableBatch:
        return self._runner.run(self._inner.get(batch_id, timeout=timeout))

    def update_item(
        self,
        batch_id: str,
        item_id: str,
        *,
        expected_version: int,
        amount_minor: int | None = None,
        pix_key: str | None = None,
        boleto_line: str | None = None,
        br_code: str | None = None,
        description: str | None = None,
        excluded: bool | None = None,
        rail: PayableWayRail | None = None,
        timeout: float | None = None,
    ) -> PayableBatch:
        return self._runner.run(
            self._inner.update_item(
                batch_id,
                item_id,
                expected_version=expected_version,
                amount_minor=amount_minor,
                pix_key=pix_key,
                boleto_line=boleto_line,
                br_code=br_code,
                rail=rail,
                description=description,
                excluded=excluded,
                timeout=timeout,
            )
        )

    def add_items(
        self,
        batch_id: str,
        *,
        expected_version: int,
        file_ids: list[str] | None = None,
        items: list[PayableItemInput] | None = None,
        timeout: float | None = None,
    ) -> PayableBatch:
        return self._runner.run(
            self._inner.add_items(
                batch_id,
                expected_version=expected_version,
                file_ids=file_ids,
                items=items,
                timeout=timeout,
            )
        )

    def pay(
        self,
        batch_id: str,
        *,
        version: int,
        list_hash: str,
        mandate_id: str | None = None,
        idempotency_key: str | None = None,
        timeout: float | None = None,
    ) -> PayableBatch:
        return self._runner.run(
            self._inner.pay(
                batch_id,
                version=version,
                list_hash=list_hash,
                mandate_id=mandate_id,
                idempotency_key=idempotency_key,
                timeout=timeout,
            )
        )


class Payables:
    """``cs.payables`` on the sync ``CodeSpar``."""

    def __init__(self, inner: AsyncPayables, runner: _LoopRunner) -> None:
        self.files = PayablesFiles(inner.files, runner)
        self.batches = PayablesBatches(inner.batches, runner)
