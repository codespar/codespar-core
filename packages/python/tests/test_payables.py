"""
``cs.payables`` parity with the TypeScript facade: the wire each call
sends to /v1/payables/files and /v1/payables/batches (multipart with a
boundary, snake_case, Idempotency-Key), on the async and the sync
client, and that a 409 carrying the current batch raises with the batch
readable from the error.
"""

from __future__ import annotations

import io
import json
import re
from pathlib import Path
from typing import Any

import httpx
import pytest
from pytest_httpx import HTTPXMock

from codespar import ApiError, AsyncCodeSpar, CodeSpar, payable_batch_from_error

BASE = "https://api.codespar.dev"

FILE: dict[str, Any] = {
    "file_id": "pfile_example",
    "kind": "pdf",
    "sha256": "0" * 64,
    "size_bytes": 16,
    "items_found": 1,
    "unresolved": 0,
    "expires_at": "2026-10-25T12:00:00.000Z",
}

BATCH: dict[str, Any] = {
    "batch_id": "pbat_example",
    "status": "ready",
    "version": 3,
    "list_hash": "hash_v3",
    "currency": "BRL",
    "totals": {"items": 1, "payable_items": 1, "excluded": 0, "amount_minor": 5000},
    "confirmation": None,
    "items": [
        {
            "item_id": "pbl_AbCdEfGhIjKlMnOp",
            "position": 0,
            "origin": {"file_id": None, "page": None, "row": None, "kind": "manual"},
            "rail": "pix",
            "state": "ready",
            "missing": [],
            "destination": {
                "kind": "pix_key",
                "display": "***.456.789-**",
                "beneficiary_name": "Pessoa de Teste",
                "beneficiary_document_masked": "***.456.789-**",
                "due_date": None,
            },
            "amount_minor": 5000,
            "amount_source": "stated_by_person",
            "description": "Aluguel",
            "reference": None,
            "checks": [{"code": "pix_key_resolved", "status": "pass", "message": "ok"}],
            "payment": None,
        }
    ],
    "created_at": "2026-10-24T12:00:00.000Z",
    "source": "api",
    "conversation_id": None,
    "discarded": None,
}


def _part(request: httpx.Request) -> tuple[str, str, bytes]:
    """(filename, content type, bytes) of the single ``file`` part."""
    ctype = request.headers["content-type"]
    match = re.match(r"multipart/form-data; boundary=(.+)$", ctype)
    assert match, ctype
    boundary = match.group(1).encode()
    body = request.read()
    parts = [p for p in body.split(b"--" + boundary)[1:-1]]
    assert len(parts) == 1
    head, _, content = parts[0].partition(b"\r\n\r\n")
    disposition = head.decode()
    assert 'name="file"' in disposition
    filename = re.search(r'filename="([^"]+)"', disposition)
    part_type = re.search(r"Content-Type: (.+)", disposition)
    assert filename and part_type
    return filename.group(1), part_type.group(1).strip(), content.removesuffix(b"\r\n")


async def test_upload_from_path_sends_multipart(httpx_mock: HTTPXMock, tmp_path: Path) -> None:
    pdf = tmp_path / "conta.pdf"
    pdf.write_bytes(b"%PDF-1.7 example")
    httpx_mock.add_response(
        method="POST", url=f"{BASE}/v1/payables/files", json=FILE, status_code=201
    )
    async with AsyncCodeSpar(api_key="csk_test_x", project_id="prj_0123456789abcdef") as cs:
        result = await cs.payables.files.upload(pdf)
    assert result == FILE
    request = httpx_mock.get_request()
    assert request is not None
    assert request.headers["authorization"] == "Bearer csk_test_x"
    assert request.headers["x-codespar-project"] == "prj_0123456789abcdef"
    assert _part(request) == ("conta.pdf", "application/pdf", b"%PDF-1.7 example")


async def test_upload_from_bytes_and_file_object(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(url=f"{BASE}/v1/payables/files", json=FILE, status_code=201)
    httpx_mock.add_response(url=f"{BASE}/v1/payables/files", json=FILE, status_code=201)
    stream = io.BytesIO(b"a,b\n1,2\n")
    stream.name = "/tmp/lote.csv"
    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        await cs.payables.files.upload(b"\x89PNG example", content_type="image/png")
        await cs.payables.files.upload(stream)
    first, second = httpx_mock.get_requests()
    assert _part(first) == ("document", "image/png", b"\x89PNG example")
    assert _part(second) == ("lote.csv", "text/csv", b"a,b\n1,2\n")


async def test_upload_error_keeps_status_and_code(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/v1/payables/files",
        status_code=415,
        json={
            "error": {"code": "payable_file_type_unsupported", "message": "Not a PDF or image"},
            "request_id": "req_example",
        },
    )
    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        with pytest.raises(ApiError) as info:
            await cs.payables.files.upload(b"plain")
    assert info.value.status == 415
    assert info.value.code == "payable_file_type_unsupported"
    assert "Not a PDF or image" in str(info.value)


async def test_create_sends_snake_case_and_idempotency_key(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(url=f"{BASE}/v1/payables/batches", json=BATCH, status_code=201)
    httpx_mock.add_response(url=f"{BASE}/v1/payables/batches", json=BATCH, status_code=201)
    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        batch = await cs.payables.batches.create(
            file_ids=["pfile_example"],
            items=[{"pix_key": "pessoa@example.com", "amount_minor": 5000}],
            source="api",
            idempotency_key="idem_example_0001",
        )
        await cs.payables.batches.create(items=[{"br_code": "000201example"}])
    assert batch["batch_id"] == "pbat_example"
    first, second = httpx_mock.get_requests()
    assert first.headers["idempotency-key"] == "idem_example_0001"
    assert json.loads(first.content) == {
        "file_ids": ["pfile_example"],
        "items": [{"pix_key": "pessoa@example.com", "amount_minor": 5000}],
        "source": "api",
    }
    assert re.fullmatch(r"[0-9a-f-]{36}", second.headers["idempotency-key"])


async def test_get_update_add_and_pay_paths(httpx_mock: HTTPXMock) -> None:
    for _ in range(5):
        httpx_mock.add_response(json=BATCH)
    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        await cs.payables.batches.get("pbat_example")
        await cs.payables.batches.update_item(
            "pbat_example", "pbl_AbCdEfGhIjKlMnOp", expected_version=3, excluded=True
        )
        # One bill, two ways (payables v1.1): the way is chosen on the same door.
        await cs.payables.batches.update_item(
            "pbat_example", "pbl_AbCdEfGhIjKlMnOp", expected_version=4, rail="boleto"
        )
        await cs.payables.batches.add_items(
            "pbat_example", expected_version=4, items=[{"boleto_line": "2379"}]
        )
        await cs.payables.batches.pay(
            "pbat_example", version=5, list_hash="hash_v5", mandate_id="mdt_example"
        )
    reqs = httpx_mock.get_requests()
    assert [(r.method, r.url.path) for r in reqs] == [
        ("GET", "/v1/payables/batches/pbat_example"),
        ("PATCH", "/v1/payables/batches/pbat_example/items/pbl_AbCdEfGhIjKlMnOp"),
        ("PATCH", "/v1/payables/batches/pbat_example/items/pbl_AbCdEfGhIjKlMnOp"),
        ("POST", "/v1/payables/batches/pbat_example/items"),
        ("POST", "/v1/payables/batches/pbat_example/pay"),
    ]
    assert json.loads(reqs[1].content) == {"expected_version": 3, "excluded": True}
    assert json.loads(reqs[2].content) == {"expected_version": 4, "rail": "boleto"}
    assert json.loads(reqs[3].content) == {
        "expected_version": 4,
        "items": [{"boleto_line": "2379"}],
    }
    assert json.loads(reqs[4].content) == {
        "version": 5,
        "list_hash": "hash_v5",
        "mandate_id": "mdt_example",
    }
    assert reqs[4].headers["idempotency-key"] == "pay:pbat_example:5:hash_v5"


async def test_discard_posts_an_empty_object_and_returns_the_batch(httpx_mock: HTTPXMock) -> None:
    mark = {"at": "2026-10-28T10:00:00.000Z", "items": 1}
    discarded = {**BATCH, "status": "canceled", "discarded": mark}
    httpx_mock.add_response(json=discarded)
    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        batch = await cs.payables.batches.discard("pbat_example")
    assert batch == discarded
    (req,) = httpx_mock.get_requests()
    assert (req.method, req.url.path) == ("POST", "/v1/payables/batches/pbat_example/discard")
    assert json.loads(req.content) == {}
    assert "idempotency-key" not in req.headers


async def test_pay_repeats_while_executing_with_items_ready(httpx_mock: HTTPXMock) -> None:
    item = BATCH["items"][0]
    paid = {
        "state": "executed",
        "attempt_id": "att_1",
        "receipt_id": "rcp_1",
        "end_to_end_id": "E1",
        "refusal": None,
    }
    second = {**item, "item_id": "pbl_ZyXwVuTsRqPoNmLk", "position": 1}
    done = {**item, "state": "executed", "payment": paid}
    httpx_mock.add_response(json={**BATCH, "status": "executing", "items": [done, second]})
    httpx_mock.add_response(
        json={
            **BATCH,
            "status": "completed",
            "items": [done, {**second, "state": "executed", "payment": paid}],
        }
    )
    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        batch = await cs.payables.batches.pay("pbat_example", version=3, list_hash="hash_v3")
    reqs = httpx_mock.get_requests()
    assert len(reqs) == 2
    assert reqs[0].headers["idempotency-key"] == reqs[1].headers["idempotency-key"]
    assert reqs[0].content == reqs[1].content
    assert batch["status"] == "completed"


async def test_pay_does_not_repeat_when_nothing_is_left_to_send(httpx_mock: HTTPXMock) -> None:
    waiting = {**BATCH["items"][0], "state": "dispatching"}
    httpx_mock.add_response(json={**BATCH, "status": "executing", "items": [waiting]})
    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        await cs.payables.batches.pay("pbat_example", version=3, list_hash="hash_v3")
    assert len(httpx_mock.get_requests()) == 1


async def test_version_mismatch_carries_current_batch(httpx_mock: HTTPXMock) -> None:
    current = {**BATCH, "version": 4, "list_hash": "hash_v4"}
    httpx_mock.add_response(
        status_code=409,
        json={
            "error": {
                "code": "payable_batch_version_mismatch",
                "message": "changed",
                "details": {"batch": current},
            },
        },
    )
    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        with pytest.raises(ApiError) as info:
            await cs.payables.batches.pay("pbat_example", version=3, list_hash="hash_v3")
    assert info.value.code == "payable_batch_version_mismatch"
    assert payable_batch_from_error(info.value) == current
    assert payable_batch_from_error(ValueError("other")) is None


def test_sync_client_exposes_the_same_facade(httpx_mock: HTTPXMock, tmp_path: Path) -> None:
    pdf = tmp_path / "conta.pdf"
    pdf.write_bytes(b"%PDF-1.7 example")
    httpx_mock.add_response(url=f"{BASE}/v1/payables/files", json=FILE, status_code=201)
    httpx_mock.add_response(url=f"{BASE}/v1/payables/batches", json=BATCH, status_code=201)
    with CodeSpar(api_key="csk_test_x") as cs:
        uploaded = cs.payables.files.upload(str(pdf))
        batch = cs.payables.batches.create(file_ids=[uploaded["file_id"]])
    assert batch["version"] == 3
    upload_req, create_req = httpx_mock.get_requests()
    assert _part(upload_req)[0] == "conta.pdf"
    assert json.loads(create_req.content) == {"file_ids": ["pfile_example"]}
