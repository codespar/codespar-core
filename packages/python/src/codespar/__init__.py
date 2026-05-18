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
    TimeoutError,
)
from .tool_result_codes import (
    APPROVAL_REQUIRED,
    MOCKS_ENGINE_ERROR,
    MOCKS_EXHAUSTED,
    POLICY_DENIED,
    TOOL_NOT_MOCKED,
    TOOL_RESULT_CODES,
    ApprovalRequiredOutput,
    MocksEngineErrorOutput,
    MocksExhaustedOutput,
    PolicyDeniedOutput,
    ToolNotMockedOutput,
    ToolResultCode,
    ToolResultOutcome,
    assert_exhaustive_tool_result,
    is_approval_required,
    is_mocks_engine_error,
    is_mocks_exhausted,
    is_policy_denied,
    is_tool_not_mocked,
)
from .types import (
    AssistantTextEvent,
    AuthConfig,
    AuthResult,
    ChargeArgs,
    ChargeBuyer,
    ChargeMethod,
    ChargeResult,
    ConnectionDifficulty,
    ConnectionStatus,
    ConnectionStatusRow,
    ConnectionWizardInstructions,
    ConnectionWizardOptions,
    ConnectionWizardResult,
    DiscoverOptions,
    DiscoverPlanStep,
    DiscoverResult,
    DiscoverToolMatch,
    DoneEvent,
    ErrorEvent,
    HttpMethod,
    IssueAction,
    IssueArgs,
    IssueResult,
    LedgerAction,
    LedgerArgs,
    LedgerLeg,
    LedgerResult,
    ManageConnections,
    MockObject,
    MockValue,
    PaymentStatus,
    PaymentStatusEvent,
    PaymentStatusResult,
    Preset,
    ProxyRequest,
    ProxyResult,
    RequiredSecret,
    SearchStrategy,
    SendResult,
    ServerConnection,
    SessionConfig,
    SessionInfo,
    SessionStatus,
    ShipAction,
    ShipAddress,
    ShipArgs,
    ShipItem,
    ShipResult,
    ShipServiceLevel,
    ShopAction,
    ShopAddress,
    ShopArgs,
    ShopBuyer,
    ShopCheckoutItem,
    ShopCheckoutResult,
    ShopCheckoutStatus,
    ShopOffer,
    ShopResult,
    ShopSearchResult,
    ShopStatusResult,
    ShopVariant,
    StreamEvent,
    Tool,
    ToolCallRecord,
    ToolResult,
    ToolResultEvent,
    ToolUseEvent,
    UserMessageEvent,
    VerificationStatus,
    VerificationStatusEvent,
    VerificationStatusResult,
    WizardAction,
)

__version__ = "0.10.1"

__all__ = [
    "APPROVAL_REQUIRED",
    "MOCKS_ENGINE_ERROR",
    "MOCKS_EXHAUSTED",
    "POLICY_DENIED",
    "TOOL_NOT_MOCKED",
    "TOOL_RESULT_CODES",
    "ApiError",
    "ApprovalRequiredOutput",
    "AssistantTextEvent",
    "AsyncCodeSpar",
    "AsyncSession",
    # Connect Links
    "AuthConfig",
    "AuthResult",
    # Inbound charge (codespar_charge)
    "ChargeArgs",
    "ChargeBuyer",
    "ChargeMethod",
    "ChargeResult",
    # Clients
    "CodeSpar",
    # Errors
    "CodeSparError",
    "ConfigError",
    # Connection wizard (codespar_manage_connections)
    "ConnectionDifficulty",
    "ConnectionStatus",
    "ConnectionStatusRow",
    "ConnectionWizardInstructions",
    "ConnectionWizardOptions",
    "ConnectionWizardResult",
    # Tool discovery (codespar_discover)
    "DiscoverOptions",
    "DiscoverPlanStep",
    "DiscoverResult",
    "DiscoverToolMatch",
    "DoneEvent",
    "ErrorEvent",
    "HttpMethod",
    # Issue (codespar_issue)
    "IssueAction",
    "IssueArgs",
    "IssueResult",
    # Ledger (codespar_ledger)
    "LedgerAction",
    "LedgerArgs",
    "LedgerLeg",
    "LedgerResult",
    "ManageConnections",
    # Test-mode mocks
    "MockObject",
    "MockValue",
    "MocksEngineErrorOutput",
    "MocksExhaustedOutput",
    "NotConnectedError",
    # Async settlement (codespar_pay etc.)
    "PaymentStatus",
    "PaymentStatusEvent",
    "PaymentStatusResult",
    "PolicyDeniedOutput",
    "Preset",
    # Proxy
    "ProxyRequest",
    "ProxyResult",
    "RequiredSecret",
    "SearchStrategy",
    "SendResult",
    "ServerConnection",
    "Session",
    # Configuration
    "SessionConfig",
    # Session output
    "SessionInfo",
    "SessionStatus",
    # Shipping (codespar_ship)
    "ShipAction",
    "ShipAddress",
    "ShipArgs",
    "ShipItem",
    "ShipResult",
    "ShipServiceLevel",
    # Shopping (codespar_shop)
    "ShopAction",
    "ShopAddress",
    "ShopArgs",
    "ShopBuyer",
    "ShopCheckoutItem",
    "ShopCheckoutResult",
    "ShopCheckoutStatus",
    "ShopOffer",
    "ShopResult",
    "ShopSearchResult",
    "ShopStatusResult",
    "ShopVariant",
    "StreamError",
    # Streaming events
    "StreamEvent",
    "TimeoutError",
    "Tool",
    "ToolCallRecord",
    "ToolNotMockedOutput",
    "ToolResult",
    # Tool-result code type-narrowed guards
    "ToolResultCode",
    "ToolResultEvent",
    "ToolResultOutcome",
    "ToolUseEvent",
    "UserMessageEvent",
    # Async KYC verification (codespar_kyc)
    "VerificationStatus",
    "VerificationStatusEvent",
    "VerificationStatusResult",
    "WizardAction",
    # Version
    "__version__",
    "assert_exhaustive_tool_result",
    "is_approval_required",
    "is_mocks_engine_error",
    "is_mocks_exhausted",
    "is_policy_denied",
    "is_tool_not_mocked",
]
