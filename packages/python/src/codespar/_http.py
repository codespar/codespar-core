"""
HTTP primitives shared by the async + sync clients.

Every call through the SDK goes through ``request_json`` / ``stream_sse``
so header injection, auth, project-id threading, and error mapping live
in one place. Neither the public ``AsyncCodeSpar`` nor ``Session``
classes import httpx directly — if we ever swap the transport, only
this file changes.
"""

from __future__ import annotations

import json
import math
from collections.abc import AsyncIterator
from typing import Any

import httpx

from .errors import ApiError, ConfigError, StreamError, TimeoutError

DEFAULT_BASE_URL = "https://api.codespar.dev"


def normalize_timeout(timeout: float | None) -> float | None:
    """Fail-fast validation for every per-call timeout (seconds).

    Centralized here so EVERY request path — create() and every session
    method, unary or streaming — rejects the same bad inputs before a
    request starts, rather than letting httpx misinterpret them or fail
    late with a non-CodeSpar error around a commerce side effect.
    ``None`` means "use the client default".
    """
    if timeout is None:
        return None
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)):
        raise ConfigError(
            f"timeout must be a number of seconds, got {type(timeout).__name__}"
        )
    if math.isnan(timeout) or math.isinf(timeout) or timeout <= 0:
        raise ConfigError(
            f"timeout must be a positive, finite number of seconds, got {timeout!r}"
        )
    return float(timeout)


def build_headers(
    api_key: str, project_id: str | None, *, accept_sse: bool = False
) -> dict[str, str]:
    """Standard header set for every authenticated request."""
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
        "User-Agent": "codespar-python/0.10.0",
    }
    if project_id:
        headers["x-codespar-project"] = project_id
    if accept_sse:
        headers["Accept"] = "text/event-stream"
    else:
        headers["Accept"] = "application/json"
    return headers


async def request_json(
    client: httpx.AsyncClient,
    method: str,
    path: str,
    *,
    api_key: str,
    project_id: str | None,
    body: Any = None,
    timeout: float | None = None,
) -> Any:
    """Do an authenticated JSON request, return parsed body or raise ApiError."""
    timeout = normalize_timeout(timeout)
    headers = build_headers(api_key, project_id)
    try:
        response = await client.request(
            method,
            path,
            headers=headers,
            json=body if body is not None else None,
            timeout=timeout,
        )
    except httpx.TimeoutException as exc:
        raise TimeoutError(str(exc), cause=exc) from exc
    except httpx.HTTPError as exc:  # network, timeout, connect failure
        raise ApiError(f"{method} {path} failed: {exc}", status=0) from exc

    # 204 No Content — used by close()
    if response.status_code == 204:
        return None

    raw = response.text
    parsed: Any = None
    if raw:
        try:
            parsed = response.json()
        except json.JSONDecodeError:
            parsed = raw

    if not response.is_success:
        code: str | None = None
        message = f"{method} {path} failed: {response.status_code}"
        if isinstance(parsed, dict):
            # ``code`` is the discriminant on the hosted-test-mode
            # envelopes. ``error`` is the legacy field kept as a
            # fallback so older envelopes still surface a structured
            # code value rather than None.
            raw_code = parsed.get("code")
            if isinstance(raw_code, str):
                code = raw_code
            else:
                raw_error = parsed.get("error")
                if isinstance(raw_error, str):
                    code = raw_error
            msg = parsed.get("message")
            if isinstance(msg, str):
                message = f"{message} — {msg}"
            elif code:
                message = f"{message} — {code}"
        raise ApiError(message, status=response.status_code, body=parsed, code=code)

    return parsed


async def stream_sse(
    client: httpx.AsyncClient,
    path: str,
    *,
    api_key: str,
    project_id: str | None,
    body: Any,
    timeout: float | None = None,
) -> AsyncIterator[dict[str, Any]]:
    """
    POST a JSON body and yield parsed SSE data frames from the response.

    Only ``data:`` lines are surfaced to the caller; ``event:`` and
    comment lines (``: keep-alive``) are swallowed. Each yielded dict
    is the JSON payload from a single SSE frame. Callers interpret
    the ``type`` field themselves.
    """
    timeout = normalize_timeout(timeout)
    headers = build_headers(api_key, project_id, accept_sse=True)
    try:
        async with client.stream(
            "POST",
            path,
            headers=headers,
            json=body,
            timeout=timeout,
        ) as response:
            if not response.is_success:
                raw = await response.aread()
                text = raw.decode("utf-8", errors="replace")
                raise ApiError(
                    f"POST {path} (stream) failed: {response.status_code} — {text[:200]}",
                    status=response.status_code,
                    body=text,
                )

            buffer = ""
            async for chunk in response.aiter_text():
                buffer += chunk
                # SSE frames are separated by blank lines ("\n\n").
                while "\n\n" in buffer:
                    frame, buffer = buffer.split("\n\n", 1)
                    payload: str | None = None
                    for line in frame.split("\n"):
                        if line.startswith("data:"):
                            payload = (payload or "") + line[len("data:") :].strip()
                    if not payload:
                        continue
                    try:
                        yield json.loads(payload)
                    except json.JSONDecodeError as exc:
                        raise StreamError(f"malformed SSE payload: {payload[:120]}") from exc
    except httpx.TimeoutException as exc:
        raise TimeoutError(str(exc), cause=exc) from exc
    except httpx.HTTPError as exc:
        raise StreamError(f"POST {path} (stream) transport error: {exc}") from exc


async def stream_sse_get(
    client: httpx.AsyncClient,
    path: str,
    *,
    api_key: str,
    project_id: str | None,
    timeout: float | None = None,
) -> AsyncIterator[tuple[str, dict[str, Any]]]:
    """
    GET an SSE endpoint and yield ``(event_name, data)`` pairs as
    they arrive. Used by the status-stream wrappers
    (``payment_status_stream`` / ``verification_status_stream``)
    where the route is GET-based and emits named events
    (``snapshot`` / ``update`` / ``done``) rather than the
    chat-loop's anonymous JSON frames. Heartbeat comment frames
    (``: heartbeat 12345``) are filtered.
    """
    timeout = normalize_timeout(timeout)
    headers = build_headers(api_key, project_id, accept_sse=True)
    try:
        async with client.stream("GET", path, headers=headers, timeout=timeout) as response:
            if not response.is_success:
                raw = await response.aread()
                text = raw.decode("utf-8", errors="replace")
                raise ApiError(
                    f"GET {path} (stream) failed: {response.status_code} — {text[:200]}",
                    status=response.status_code,
                    body=text,
                )

            buffer = ""
            async for chunk in response.aiter_text():
                buffer += chunk
                while "\n\n" in buffer:
                    frame, buffer = buffer.split("\n\n", 1)
                    if frame.startswith(":"):
                        continue
                    event_name = "message"
                    payload: str | None = None
                    for line in frame.split("\n"):
                        if line.startswith("event:"):
                            event_name = line[len("event:") :].strip()
                        elif line.startswith("data:"):
                            payload = (payload or "") + line[len("data:") :].strip()
                    if not payload:
                        continue
                    try:
                        yield event_name, json.loads(payload)
                    except json.JSONDecodeError as exc:
                        raise StreamError(
                            f"malformed SSE payload: {payload[:120]}"
                        ) from exc
    except httpx.TimeoutException as exc:
        raise TimeoutError(str(exc), cause=exc) from exc
    except httpx.HTTPError as exc:
        raise StreamError(f"GET {path} (stream) transport error: {exc}") from exc
