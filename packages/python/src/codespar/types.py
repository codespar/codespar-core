"""
Type definitions for the CodeSpar Python SDK.

Every shape here mirrors the TypeScript @codespar/sdk types so the
payloads on the wire match byte-for-byte — the backend
(codespar-enterprise) is the single source of truth, and both SDKs
are just client-side adapters over the same HTTP contract.

Using plain dataclasses (not pydantic) to keep the dependency footprint
small and imports fast. If we need runtime validation later, we can
layer pydantic on without changing this surface.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal

Preset = Literal["brazilian", "mexican", "argentinian", "colombian", "all"]
HttpMethod = Literal["GET", "POST", "PUT", "PATCH", "DELETE"]
SessionStatus = Literal["active", "closed", "error"]
AuthType = Literal["oauth", "api_key", "cert", "none"]


@dataclass(slots=True)
class ManageConnections:
    """Options for blocking session creation until servers are connected."""

    wait_for_connections: bool = False
    timeout: int = 30_000


@dataclass(slots=True)
class SessionConfig:
    """Per-session configuration passed to ``CodeSpar.create``."""

    servers: list[str] | None = None
    preset: Preset | None = None
    manage_connections: ManageConnections | None = None
    metadata: dict[str, str] | None = None
    project_id: str | None = None


@dataclass(slots=True)
class Tool:
    """A tool exposed by a connected server."""

    name: str
    description: str
    input_schema: dict[str, Any]
    server: str


@dataclass(slots=True)
class ToolResult:
    """Result of a single tool execution."""

    success: bool
    data: Any
    error: str | None
    duration: int
    server: str
    tool: str
    tool_call_id: str | None = None
    called_at: str | None = None


@dataclass(slots=True)
class ToolCallRecord:
    """A row in the backend's session_tool_calls table, surfaced on send/sendStream."""

    id: str
    tool_name: str
    server_id: str
    status: Literal["success", "error"]
    duration_ms: int
    input: Any
    output: Any
    error_code: str | None


@dataclass(slots=True)
class SendResult:
    """Final payload of a Session.send natural-language turn."""

    message: str
    tool_calls: list[ToolCallRecord] = field(default_factory=list)
    iterations: int = 0


@dataclass(slots=True)
class ServerConnection:
    """A server the session can call, as seen by the backend."""

    id: str
    name: str
    category: str
    country: str
    auth_type: AuthType
    connected: bool


@dataclass(slots=True)
class ProxyRequest:
    """Raw HTTP proxy call to a connected server's upstream API."""

    server: str
    endpoint: str
    method: HttpMethod
    body: Any = None
    params: dict[str, Any] | None = None
    headers: dict[str, str] | None = None


@dataclass(slots=True)
class ProxyResult:
    """Response of a raw proxy call. `data` is parsed JSON when possible."""

    status: int
    data: Any
    headers: dict[str, str]
    duration: int
    proxy_call_id: str | None = None


@dataclass(slots=True)
class AuthConfig:
    """Input to ``Session.authorize`` — where the provider redirects the user."""

    redirect_uri: str
    scopes: str | None = None


@dataclass(slots=True)
class AuthResult:
    """Output of ``Session.authorize`` — the Connect Link the end user opens."""

    link_token: str
    authorize_url: str
    expires_at: str


# Streaming event shapes. These mirror the TS StreamEvent discriminated
# union; Python doesn't have discriminated unions as first-class, so we
# use a base + subclasses with a literal `type` tag.


@dataclass(slots=True)
class UserMessageEvent:
    content: str
    type: Literal["user_message"] = "user_message"


@dataclass(slots=True)
class AssistantTextEvent:
    content: str
    iteration: int
    type: Literal["assistant_text"] = "assistant_text"


@dataclass(slots=True)
class ToolUseEvent:
    id: str
    name: str
    input: dict[str, Any]
    type: Literal["tool_use"] = "tool_use"


@dataclass(slots=True)
class ToolResultEvent:
    tool_call: ToolCallRecord
    type: Literal["tool_result"] = "tool_result"


@dataclass(slots=True)
class DoneEvent:
    result: SendResult
    type: Literal["done"] = "done"


@dataclass(slots=True)
class ErrorEvent:
    error: str
    message: str | None = None
    type: Literal["error"] = "error"


StreamEvent = (
    UserMessageEvent
    | AssistantTextEvent
    | ToolUseEvent
    | ToolResultEvent
    | DoneEvent
    | ErrorEvent
)


@dataclass(slots=True)
class SessionInfo:
    """Read-only metadata about a session, attached to the Session instance."""

    id: str
    user_id: str
    servers: list[str]
    created_at: datetime
    status: SessionStatus
    mcp_url: str
    mcp_headers: dict[str, str]
