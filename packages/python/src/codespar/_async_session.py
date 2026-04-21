"""
Async Session implementation.

Every public method maps 1:1 to the TypeScript ``Session`` in
``@codespar/sdk``. The shared httpx client is owned by the parent
``AsyncCodeSpar`` so closing the CodeSpar instance closes the
session's transport too.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import AsyncIterator
from datetime import datetime
from typing import Any

import httpx

from ._http import request_json, stream_sse
from .errors import ApiError, ConfigError
from .types import (
    AssistantTextEvent,
    AuthConfig,
    AuthResult,
    DoneEvent,
    ErrorEvent,
    ProxyRequest,
    ProxyResult,
    SendResult,
    ServerConnection,
    SessionInfo,
    StreamEvent,
    Tool,
    ToolCallRecord,
    ToolResult,
    ToolResultEvent,
    ToolUseEvent,
    UserMessageEvent,
)


def _parse_tool_call_record(raw: dict[str, Any]) -> ToolCallRecord:
    return ToolCallRecord(
        id=str(raw.get("id", "")),
        tool_name=str(raw.get("tool_name", "")),
        server_id=str(raw.get("server_id", "")),
        status=raw.get("status", "success"),
        duration_ms=int(raw.get("duration_ms", 0) or 0),
        input=raw.get("input"),
        output=raw.get("output"),
        error_code=raw.get("error_code"),
    )


def _parse_send_result(raw: dict[str, Any]) -> SendResult:
    tool_calls_raw = raw.get("tool_calls") or []
    return SendResult(
        message=str(raw.get("message", "")),
        tool_calls=[_parse_tool_call_record(tc) for tc in tool_calls_raw],
        iterations=int(raw.get("iterations", 0) or 0),
    )


def _parse_stream_event(raw: dict[str, Any]) -> StreamEvent | None:
    """
    Normalize a raw SSE payload into a typed ``StreamEvent``.

    Returns ``None`` for unknown event types so a future backend event
    doesn't crash an SDK that predates it — forwards compatibility
    matters more than strict parsing at this layer.
    """
    event_type = raw.get("type")
    match event_type:
        case "user_message":
            return UserMessageEvent(content=str(raw.get("content", "")))
        case "assistant_text":
            return AssistantTextEvent(
                content=str(raw.get("content", "")),
                iteration=int(raw.get("iteration", 0) or 0),
            )
        case "tool_use":
            return ToolUseEvent(
                id=str(raw.get("id", "")),
                name=str(raw.get("name", "")),
                input=raw.get("input") or {},
            )
        case "tool_result":
            tc = raw.get("toolCall") or raw.get("tool_call")
            if not isinstance(tc, dict):
                return None
            return ToolResultEvent(tool_call=_parse_tool_call_record(tc))
        case "done":
            result = raw.get("result")
            payload = _parse_send_result(result if isinstance(result, dict) else {})
            return DoneEvent(result=payload)
        case "error":
            return ErrorEvent(
                error=str(raw.get("error", "error")),
                message=raw.get("message") if isinstance(raw.get("message"), str) else None,
            )
        case _:
            return None


class AsyncSession:
    """
    A live CodeSpar session — async interface.

    Instances are created via ``AsyncCodeSpar.create(user_id, ...)`` and
    hold a reference to the parent client's shared httpx transport.
    """

    def __init__(
        self,
        *,
        info: SessionInfo,
        client: httpx.AsyncClient,
        api_key: str,
        project_id: str | None,
        base_url: str,
    ) -> None:
        self.info = info
        self._client = client
        self._api_key = api_key
        self._project_id = project_id
        self._base_url = base_url
        self._cached_tools: list[Tool] | None = None
        self._cached_connections: list[ServerConnection] | None = None

    # ── identity passthroughs ───────────────────────────────────────────

    @property
    def id(self) -> str:
        return self.info.id

    @property
    def user_id(self) -> str:
        return self.info.user_id

    @property
    def servers(self) -> list[str]:
        return list(self.info.servers)

    @property
    def mcp(self) -> dict[str, Any]:
        """Config for MCP-compatible clients (Claude Desktop, Cursor)."""
        return {
            "url": self.info.mcp_url,
            "headers": dict(self.info.mcp_headers),
        }

    # ── tools ───────────────────────────────────────────────────────────

    async def tools(self) -> list[Tool]:
        """Return the tools available in this session. Cached after first call."""
        if self._cached_tools is not None:
            return list(self._cached_tools)
        await self.connections()
        return list(self._cached_tools or [])

    async def find_tools(self, intent: str) -> list[Tool]:
        """Substring match on tool name + description. Case-insensitive."""
        all_tools = await self.tools()
        q = intent.lower()
        return [t for t in all_tools if q in t.name.lower() or q in t.description.lower()]

    # ── execution ───────────────────────────────────────────────────────

    async def execute(self, tool_name: str, params: dict[str, Any]) -> ToolResult:
        """Call a specific tool by name. Always returns a ToolResult, even on error."""
        start = _now_ms()
        try:
            data = await request_json(
                self._client,
                "POST",
                f"/v1/sessions/{self.id}/execute",
                api_key=self._api_key,
                project_id=self._project_id,
                body={"tool": tool_name, "input": params},
            )
        except ApiError as exc:
            return ToolResult(
                success=False,
                data=None,
                error=f"{exc.status}: {exc.body or exc}",
                duration=_now_ms() - start,
                server="",
                tool=tool_name,
            )
        if not isinstance(data, dict):
            return ToolResult(
                success=False,
                data=None,
                error="malformed response",
                duration=_now_ms() - start,
                server="",
                tool=tool_name,
            )
        return ToolResult(
            success=bool(data.get("success", False)),
            data=data.get("data"),
            error=data.get("error"),
            duration=int(data.get("duration", 0) or 0),
            server=str(data.get("server", "")),
            tool=str(data.get("tool", tool_name)),
            tool_call_id=data.get("tool_call_id"),
            called_at=data.get("called_at"),
        )

    # ── proxy ───────────────────────────────────────────────────────────

    async def proxy_execute(self, request: ProxyRequest) -> ProxyResult:
        """
        Raw HTTP proxy to a connected server's upstream API. Auth is
        injected by the backend — never send provider keys here.
        """
        data = await request_json(
            self._client,
            "POST",
            f"/v1/sessions/{self.id}/proxy_execute",
            api_key=self._api_key,
            project_id=self._project_id,
            body={
                "server": request.server,
                "endpoint": request.endpoint,
                "method": request.method,
                "body": request.body,
                "params": request.params,
                "headers": request.headers,
            },
        )
        if not isinstance(data, dict):
            raise ApiError("proxy_execute: malformed response", status=0, body=data)
        return ProxyResult(
            status=int(data.get("status", 0) or 0),
            data=data.get("data"),
            headers=dict(data.get("headers") or {}),
            duration=int(data.get("duration", 0) or 0),
            proxy_call_id=data.get("proxy_call_id"),
        )

    # ── natural-language ────────────────────────────────────────────────

    async def send(self, message: str) -> SendResult:
        """Send a natural-language message. Blocks until the agent loop finishes."""
        data = await request_json(
            self._client,
            "POST",
            f"/v1/sessions/{self.id}/send",
            api_key=self._api_key,
            project_id=self._project_id,
            body={"message": message},
        )
        if not isinstance(data, dict):
            raise ApiError("send: malformed response", status=0, body=data)
        return _parse_send_result(data)

    async def send_stream(self, message: str) -> AsyncIterator[StreamEvent]:
        """
        Stream a natural-language turn. Yields events as they arrive.

        Usage::

            async for event in session.send_stream("process this order"):
                match event.type:
                    case "assistant_text":
                        print(event.content, end="")
                    case "tool_use":
                        print(f"[tool] {event.name}")
        """
        async for raw in stream_sse(
            self._client,
            f"/v1/sessions/{self.id}/send",
            api_key=self._api_key,
            project_id=self._project_id,
            body={"message": message},
        ):
            event = _parse_stream_event(raw)
            if event is not None:
                yield event

    # ── Connect Links ───────────────────────────────────────────────────

    async def authorize(self, server_id: str, config: AuthConfig) -> AuthResult:
        """
        Start a Connect Link OAuth flow. Returns the URL your UI should
        open for the end user; CodeSpar's callback stores tokens and
        forwards the user to ``config.redirect_uri``.
        """
        data = await request_json(
            self._client,
            "POST",
            "/v1/connect/start",
            api_key=self._api_key,
            project_id=self._project_id,
            body={
                "server_id": server_id,
                "user_id": self.user_id,
                "redirect_uri": config.redirect_uri,
                "scopes": config.scopes,
            },
        )
        if not isinstance(data, dict):
            raise ApiError("authorize: malformed response", status=0, body=data)
        return AuthResult(
            link_token=str(data.get("link_token", "")),
            authorize_url=str(data.get("authorize_url", "")),
            expires_at=str(data.get("expires_at", "")),
        )

    # ── connections ─────────────────────────────────────────────────────

    async def connections(self) -> list[ServerConnection]:
        """List server connections and refresh the internal tools cache."""
        try:
            data = await request_json(
                self._client,
                "GET",
                f"/v1/sessions/{self.id}/connections",
                api_key=self._api_key,
                project_id=self._project_id,
            )
        except ApiError:
            return list(self._cached_connections or [])
        if not isinstance(data, dict):
            return list(self._cached_connections or [])

        raw_servers = data.get("servers") or []
        raw_tools = data.get("tools") or []
        servers = [
            ServerConnection(
                id=str(s.get("id", "")),
                name=str(s.get("name", "")),
                category=str(s.get("category", "")),
                country=str(s.get("country", "")),
                auth_type=s.get("auth_type", "none"),
                connected=bool(s.get("connected", False)),
            )
            for s in raw_servers
            if isinstance(s, dict)
        ]
        tools = [
            Tool(
                name=str(t.get("name", "")),
                description=str(t.get("description", "")),
                input_schema=dict(t.get("input_schema") or {}),
                server=str(t.get("server", "")),
            )
            for t in raw_tools
            if isinstance(t, dict)
        ]
        self._cached_connections = servers
        self._cached_tools = tools
        return list(servers)

    # ── lifecycle ───────────────────────────────────────────────────────

    async def close(self) -> None:
        """Close the session on the backend. Safe to call multiple times.
        Best-effort — a 4xx/5xx here shouldn't crash the caller. The
        backend cleans up stale sessions on a timer anyway."""
        with contextlib.suppress(ApiError):
            await request_json(
                self._client,
                "DELETE",
                f"/v1/sessions/{self.id}",
                api_key=self._api_key,
                project_id=self._project_id,
            )


def _now_ms() -> int:
    return int(asyncio.get_event_loop().time() * 1000)


async def wait_for_connections(session: AsyncSession, timeout_ms: int) -> None:
    """
    Poll ``session.connections()`` until every server reports connected,
    or until ``timeout_ms`` elapses. Matches TS ``manageConnections``.
    """
    if timeout_ms <= 0:
        raise ConfigError("wait_for_connections: timeout_ms must be positive")
    deadline = _now_ms() + timeout_ms
    while True:
        conns = await session.connections()
        if conns and all(c.connected for c in conns):
            return
        if _now_ms() >= deadline:
            return
        await asyncio.sleep(1.0)


def build_session_info(
    raw: dict[str, Any],
    *,
    base_url: str,
    api_key: str,
    project_id: str | None,
) -> SessionInfo:
    """Map backend POST /v1/sessions response into a ``SessionInfo``."""
    created_raw = raw.get("created_at", "")
    try:
        created = datetime.fromisoformat(str(created_raw).replace("Z", "+00:00"))
    except ValueError:
        created = datetime.now()

    mcp_headers: dict[str, str] = {"Authorization": f"Bearer {api_key}"}
    if project_id:
        mcp_headers["x-codespar-project"] = project_id

    return SessionInfo(
        id=str(raw.get("id", "")),
        user_id=str(raw.get("user_id", "")),
        servers=list(raw.get("servers") or []),
        created_at=created,
        status=raw.get("status", "active"),
        mcp_url=f"{base_url}/v1/sessions/{raw.get('id', '')}/mcp",
        mcp_headers=mcp_headers,
    )
