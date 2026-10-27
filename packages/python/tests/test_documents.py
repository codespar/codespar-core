"""
``cs.receipts.document`` and ``cs.account.statement`` (documents on demand):
the request each one sends, what comes back (bytes, content type, the
server's filename, the content hash), the refusals as ``ApiError`` with the
API's code, sync and async.
"""

from __future__ import annotations

import httpx
import pytest
from pytest_httpx import HTTPXMock

from codespar import ApiError, AsyncCodeSpar, CodeSpar, filename_from_disposition

BASE = "https://api.example.test"
PDF = b"%PDF-1.4\n%%EOF\n"
PNG = bytes.fromhex("89504e470d0a1a0a")
SHA = "a" * 64


def _binary(content: bytes, content_type: str, filename: str) -> dict:
    return {
        "content": content,
        "headers": {
            "content-type": content_type,
            "content-disposition": f'attachment; filename="{filename}"',
            "x-codespar-document-sha256": SHA,
        },
    }


def _refusal(http_status: int, code: str, **details: object) -> dict:
    return {
        "status_code": http_status,
        "json": {
            "error": {"code": code, "message": code, "details": details},
            "request_id": "req_1",
        },
    }


def test_receipt_document_pdf_sync(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        method="GET",
        url=f"{BASE}/v1/consumers/receipts/rcpt_x/document?format=pdf",
        **_binary(PDF, "application/pdf", "comprovante-rcpt_x.pdf"),
    )
    cs = CodeSpar(api_key="csk_test_example", base_url=BASE, project_id="prj_abc123DEF456ghi7")
    try:
        doc = cs.receipts.document("rcpt_x")
    finally:
        cs.close()
    request = httpx_mock.get_requests()[0]
    assert request.headers["authorization"] == "Bearer csk_test_example"
    assert request.headers["x-codespar-project"] == "prj_abc123DEF456ghi7"
    assert "application/pdf" in request.headers["accept"]
    assert (
        "content-type" not in request.headers
        or request.headers.get("content-type") != "application/json"
    )
    assert doc["bytes"] == PDF
    assert doc["content_type"] == "application/pdf"
    assert doc["filename"] == "comprovante-rcpt_x.pdf"
    assert doc["sha256"] == SHA


async def test_receipt_document_png_async(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        method="GET",
        url=f"{BASE}/v1/consumers/receipts/rcpt_x/document?format=png",
        **_binary(PNG, "image/png", "comprovante-rcpt_x.png"),
    )
    async with AsyncCodeSpar(api_key="csk_test_example", base_url=BASE) as cs:
        doc = await cs.receipts.document("rcpt_x", format="png")
    assert doc["bytes"][:4] == b"\x89PNG"
    assert doc["content_type"] == "image/png"
    assert doc["filename"] == "comprovante-rcpt_x.png"
    assert "image/png" in httpx_mock.get_requests()[0].headers["accept"]


def test_receipt_document_not_final_is_an_api_error(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        method="GET",
        url=f"{BASE}/v1/consumers/receipts/rcpt_u/document?format=pdf",
        **_refusal(409, "document_not_final", attempt_id="att_1", status="uncertain"),
    )
    cs = CodeSpar(api_key="csk_test_example", base_url=BASE)
    try:
        with pytest.raises(ApiError) as info:
            cs.receipts.document("rcpt_u")
    finally:
        cs.close()
    assert info.value.status == 409
    assert info.value.code == "document_not_final"


def test_receipt_document_local_refusals_send_nothing(httpx_mock: HTTPXMock) -> None:
    cs = CodeSpar(api_key="csk_test_example", base_url=BASE)
    try:
        with pytest.raises(ApiError):
            cs.receipts.document("")
        with pytest.raises(ApiError):
            cs.receipts.document("rcpt_x", format="docx")  # type: ignore[arg-type]
    finally:
        cs.close()
    assert httpx_mock.get_requests() == []


def test_statement_sync(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        method="GET",
        url=f"{BASE}/v1/account/statement?from=2026-09-01&to=2026-09-30&format=pdf",
        **_binary(PDF, "application/pdf", "extrato-2026-09-01-2026-09-30.pdf"),
    )
    cs = CodeSpar(api_key="csk_test_example", base_url=BASE)
    try:
        doc = cs.account.statement("2026-09-01", "2026-09-30")
    finally:
        cs.close()
    assert doc["filename"] == "extrato-2026-09-01-2026-09-30.pdf"
    assert doc["bytes"] == PDF


async def test_statement_period_refusal_async(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        method="GET",
        url=f"{BASE}/v1/account/statement?from=2026-01-01&to=2026-09-30&format=pdf&currency=BRL",
        **_refusal(400, "statement_period_invalid", reason="too_long"),
    )
    async with AsyncCodeSpar(api_key="csk_test_example", base_url=BASE) as cs:
        with pytest.raises(ApiError) as info:
            await cs.account.statement("2026-01-01", "2026-09-30", currency="BRL")
    assert info.value.status == 400
    assert info.value.code == "statement_period_invalid"


def test_statement_falls_back_to_its_own_filename(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        method="GET",
        url=f"{BASE}/v1/account/statement?from=2026-09-01&to=2026-09-30&format=pdf",
        content=PDF,
        headers={"content-type": "application/pdf"},
    )
    cs = CodeSpar(api_key="csk_test_example", base_url=BASE)
    try:
        doc = cs.account.statement("2026-09-01", "2026-09-30")
    finally:
        cs.close()
    assert doc["filename"] == "extrato-2026-09-01-2026-09-30.pdf"
    assert doc["sha256"] is None


def test_filename_from_disposition() -> None:
    assert (
        filename_from_disposition('attachment; filename="comprovante-rcpt_x.pdf"')
        == "comprovante-rcpt_x.pdf"
    )
    assert filename_from_disposition("attachment; filename=extrato.pdf") == "extrato.pdf"
    assert filename_from_disposition('attachment; filename="../x.pdf"') is None
    assert filename_from_disposition(None) is None


def test_network_failure_is_an_api_error(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_exception(httpx.ConnectError("down"))
    cs = CodeSpar(api_key="csk_test_example", base_url=BASE)
    try:
        with pytest.raises(ApiError) as info:
            cs.receipts.document("rcpt_x")
    finally:
        cs.close()
    assert info.value.status == 0
