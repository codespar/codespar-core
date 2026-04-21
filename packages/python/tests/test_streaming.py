"""
SSE parsing + send_stream iteration tests.

We build real SSE-framed byte streams (``event: … data: …\\n\\n``) and
feed them through pytest-httpx so the on-the-wire parser is exercised
end to end — not a mock of the inner parser.
"""

from __future__ import annotations

import pytest
from pytest_httpx import HTTPXMock

from codespar import (
    AssistantTextEvent,
    AsyncCodeSpar,
    DoneEvent,
    StreamError,
    ToolResultEvent,
    ToolUseEvent,
)


def _sse_frames(*events: dict[str, object]) -> bytes:
    """Build an SSE byte stream from a sequence of event dicts."""
    import json

    out = bytearray()
    for event in events:
        out.extend(b"event: ")
        out.extend(str(event.get("type", "message")).encode())
        out.extend(b"\n")
        out.extend(b"data: ")
        out.extend(json.dumps(event).encode())
        out.extend(b"\n\n")
    return bytes(out)


def _session_json() -> dict[str, object]:
    return {
        "id": "ses_abc123",
        "org_id": "org_test",
        "user_id": "user_123",
        "servers": ["zoop", "nuvem-fiscal"],
        "status": "active",
        "created_at": "2026-04-21T12:00:00Z",
        "closed_at": None,
    }


async def test_send_stream_yields_typed_events(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions",
        method="POST",
        json=_session_json(),
    )

    stream_bytes = _sse_frames(
        {"type": "assistant_text", "content": "Processing…", "iteration": 1},
        {
            "type": "tool_use",
            "id": "tu_1",
            "name": "codespar_pay",
            "input": {"amount": 500},
        },
        {
            "type": "tool_result",
            "toolCall": {
                "id": "tc_1",
                "tool_name": "codespar_pay",
                "server_id": "asaas",
                "status": "success",
                "duration_ms": 412,
                "input": {"amount": 500},
                "output": {"pix_id": "pix_1"},
                "error_code": None,
            },
        },
        {
            "type": "done",
            "result": {
                "message": "Done.",
                "tool_calls": [],
                "iterations": 1,
            },
        },
    )

    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions/ses_abc123/send",
        method="POST",
        content=stream_bytes,
        headers={"content-type": "text/event-stream"},
    )

    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        session = await cs.create("user_123", preset="brazilian")

        events: list[object] = []
        async for event in session.send_stream("charge R$500 via Pix"):
            events.append(event)

    assert len(events) == 4
    assert isinstance(events[0], AssistantTextEvent)
    assert events[0].content == "Processing…"
    assert isinstance(events[1], ToolUseEvent)
    assert events[1].name == "codespar_pay"
    assert isinstance(events[2], ToolResultEvent)
    assert events[2].tool_call.status == "success"
    assert isinstance(events[3], DoneEvent)
    assert events[3].result.message == "Done."


async def test_send_stream_skips_unknown_event_types(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions",
        method="POST",
        json=_session_json(),
    )
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions/ses_abc123/send",
        method="POST",
        content=_sse_frames(
            {"type": "future_event_type_we_do_not_know", "content": "?"},
            {"type": "assistant_text", "content": "ok", "iteration": 1},
        ),
        headers={"content-type": "text/event-stream"},
    )

    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        session = await cs.create("user_123", preset="brazilian")
        events = [e async for e in session.send_stream("hi")]

    # Unknown event dropped, known one still yielded.
    assert len(events) == 1
    assert isinstance(events[0], AssistantTextEvent)


async def test_send_stream_raises_on_malformed_data(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions",
        method="POST",
        json=_session_json(),
    )
    # Intentionally malformed SSE payload (not JSON)
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions/ses_abc123/send",
        method="POST",
        content=b"event: broken\ndata: this-is-not-json\n\n",
        headers={"content-type": "text/event-stream"},
    )

    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        session = await cs.create("user_123", preset="brazilian")
        with pytest.raises(StreamError):
            async for _ in session.send_stream("hi"):
                pass
