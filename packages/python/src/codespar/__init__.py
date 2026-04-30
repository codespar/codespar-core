"""
CodeSpar Python SDK — commerce infrastructure for AI agents in Latin America.

Two import surfaces:

* ``CodeSpar`` — sync client. Use from scripts, Jupyter, sync web
  frameworks (Flask, Django views).
* ``AsyncCodeSpar`` — async client. Use from FastAPI, LangChain,
  anything already running on asyncio.

Both wrap the same backend (``api.codespar.dev``) and expose the same
session API, so you can start with sync and upgrade to async without
changing the surrounding code.

Quick start::

    from codespar import CodeSpar

    cs = CodeSpar(api_key="csk_live_...")
    session = cs.create("user_123", preset="brazilian")
    result = session.send("Charge R$500 via Pix to +5511999887766")
    print(result.message)
    session.close()
    cs.close()
"""

from __future__ import annotations

from ._async_client import AsyncCodeSpar
from ._async_session import AsyncSession
from ._sync_client import CodeSpar, Session
from .errors import (
    ApiError,
    CodeSparError,
    ConfigError,
    NotConnectedError,
    StreamError,
)
from .types import (
    AssistantTextEvent,
    AuthConfig,
    AuthResult,
    DoneEvent,
    ErrorEvent,
    HttpMethod,
    ManageConnections,
    Preset,
    ProxyRequest,
    ProxyResult,
    SendResult,
    ServerConnection,
    SessionConfig,
    SessionInfo,
    SessionStatus,
    StreamEvent,
    Tool,
    ToolCallRecord,
    ToolResult,
    ToolResultEvent,
    ToolUseEvent,
    UserMessageEvent,
)

__version__ = "0.3.0"

__all__ = [
    "ApiError",
    "AssistantTextEvent",
    "AsyncCodeSpar",
    "AsyncSession",
    # Connect Links
    "AuthConfig",
    "AuthResult",
    # Clients
    "CodeSpar",
    # Errors
    "CodeSparError",
    "ConfigError",
    "DoneEvent",
    "ErrorEvent",
    "HttpMethod",
    "ManageConnections",
    "NotConnectedError",
    "Preset",
    # Proxy
    "ProxyRequest",
    "ProxyResult",
    "SendResult",
    "ServerConnection",
    "Session",
    # Configuration
    "SessionConfig",
    # Session output
    "SessionInfo",
    "SessionStatus",
    "StreamError",
    # Streaming events
    "StreamEvent",
    "Tool",
    "ToolCallRecord",
    "ToolResult",
    "ToolResultEvent",
    "ToolUseEvent",
    "UserMessageEvent",
    # Version
    "__version__",
]
