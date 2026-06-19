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
from typing import Any, Literal, TypeAlias

Preset = Literal["brazilian", "mexican", "argentinian", "colombian", "all"]
HttpMethod = Literal["GET", "POST", "PUT", "PATCH", "DELETE"]
SessionStatus = Literal["active", "closed", "error"]
AuthType = Literal["oauth", "api_key", "cert", "none"]

# ── Test-mode mocks ───────────────────────────────────────────────
#
# Mirrors the TS MockObject / MockValue aliases in @codespar/types.
# A single MockObject is a static mock (same response every call);
# a list of MockObject is a stateful mock consumed in order, one
# per matching call, then ``mocks_exhausted`` once the list is
# drained.
MockObject: TypeAlias = dict[str, Any]
MockValue: TypeAlias = MockObject | list[MockObject]


@dataclass(slots=True)
class ManageConnections:
    """Options for blocking session creation until servers are connected."""

    wait_for_connections: bool = False
    timeout: int = 30_000


@dataclass(slots=True)
class SessionConfig:
    """Per-session configuration passed to ``CodeSpar.create``.

    ``mocks`` is the test-mode field — a dict keyed on canonical tool
    names (slash form, e.g. ``asaas/create_payment``) where each value
    is either a single MockObject (static mock) or a list of MockObject
    (stateful mock, consumed in order). Forwarded verbatim to
    ``POST /v1/sessions`` so the OSS-runtime double-underscore form
    (``asaas__create_payment``) reaches the backend unrewritten and
    surfaces as ``mocks_invalid``. Requires a ``csk_test_*`` key
    against a ``test``-environment project.
    """

    servers: list[str] | None = None
    preset: Preset | None = None
    manage_connections: ManageConnections | None = None
    metadata: dict[str, str] | None = None
    project_id: str | None = None
    mocks: dict[str, MockValue] | None = None


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


# ── codespar_discover wire shape ──────────────────────────────────
#
# Typed return for ``Session.discover(use_case)``. Mirrors
# DiscoverResult in @codespar/types 0.2.0; backend produces this from
# the tool-search handler in codespar-enterprise. Both PSDK methods
# (sync + async) wrap ``execute("codespar_discover", ...)`` and parse
# the JSON ``data`` field into these dataclasses.

ConnectionStatus = Literal["connected", "disconnected", "not_required", "expired"]
SearchStrategy = Literal["embedding", "trigram", "empty"]
ConnectionDifficulty = Literal["easy", "medium", "hard"]


@dataclass(slots=True)
class DiscoverPlanStep:
    step: str
    description: str | None = None
    prereq: bool | None = None
    action: bool | None = None


@dataclass(slots=True)
class DiscoverToolMatch:
    server_id: str
    tool_name: str
    description: str
    http_method: str
    endpoint_template: str
    cosine_distance: float | None
    trigram_similarity: float | None
    connection_status: ConnectionStatus
    known_pitfalls: list[str] = field(default_factory=list)
    recommended_plan: list[DiscoverPlanStep] = field(default_factory=list)


@dataclass(slots=True)
class DiscoverResult:
    use_case: str
    search_strategy: SearchStrategy
    recommended: DiscoverToolMatch | None
    related: list[DiscoverToolMatch] = field(default_factory=list)
    next_steps: list[str] = field(default_factory=list)


@dataclass(slots=True)
class DiscoverOptions:
    """Optional knobs for ``Session.discover``. None values are dropped."""

    category: str | None = None
    country: str | None = None
    limit: int | None = None


# ── codespar_manage_connections wire shape ────────────────────────


WizardAction = Literal["list", "status", "initiate"]


@dataclass(slots=True)
class ConnectionStatusRow:
    server_id: str
    display_name: str
    auth_type: str
    status: ConnectionStatus
    difficulty: ConnectionDifficulty
    connection_metadata: dict[str, Any] = field(default_factory=dict)
    connected_at: str | None = None


@dataclass(slots=True)
class RequiredSecret:
    name: str
    hint: str | None = None


@dataclass(slots=True)
class ConnectionWizardInstructions:
    server_id: str
    display_name: str
    auth_type: str
    difficulty: ConnectionDifficulty
    status: ConnectionStatus
    connect_url: str
    next_action: str
    instructions: list[str] = field(default_factory=list)
    required_secrets: list[RequiredSecret] = field(default_factory=list)
    known_pitfalls: list[str] = field(default_factory=list)


@dataclass(slots=True)
class ConnectionWizardResult:
    action: WizardAction
    connections: list[ConnectionStatusRow] = field(default_factory=list)
    status: ConnectionStatusRow | None = None
    initiate: ConnectionWizardInstructions | None = None


@dataclass(slots=True)
class ConnectionWizardOptions:
    """Input shape for ``Session.connection_wizard``. None values dropped."""

    action: WizardAction | None = None
    server_id: str | None = None
    country: str | None = None
    environment: Literal["live", "test"] | None = None
    return_to: str | None = None


# ── codespar_charge wire shape ─────────────────────────────────────


ChargeMethod = Literal["pix", "boleto", "card"]


@dataclass(slots=True)
class ChargeBuyer:
    """Buyer details for an inbound charge — always required.

    The buyer object is the discriminator that distinguishes
    ``codespar_charge`` (buyer pays merchant) from ``codespar_pay``
    (outbound transfer to a recipient). Charges are merchant-issued and
    presented to the buyer for payment.
    """

    name: str
    email: str | None = None
    document: str | None = None
    phone: str | None = None


@dataclass(slots=True)
class ChargeArgs:
    """Input shape for ``Session.charge``.

    ``amount`` is in MAJOR currency units (R$ 125.00 → 125), matching
    Asaas + Mercado Pago + Stripe Checkout's natural API shape. The
    backend transform converts to minor units when the chosen provider
    expects cents (Stripe).
    """

    amount: float
    currency: str
    method: ChargeMethod
    description: str
    buyer: ChargeBuyer
    due_date: str | None = None


@dataclass(slots=True)
class ChargeResult:
    id: str
    status: str
    amount: float
    currency: str
    method: str
    charge_url: str | None = None
    pix_qr_code: str | None = None
    pix_copy_paste: str | None = None
    raw: Any = None


# ── codespar_ship wire shape ───────────────────────────────────────


ShipAction = Literal["label", "track", "quote"]
ShipServiceLevel = Literal["fastest", "cheapest", "standard"]


@dataclass(slots=True)
class ShipAddress:
    """Sender / recipient address for shipping."""

    postal_code: str
    city: str | None = None
    state: str | None = None
    country: str | None = None
    line_1: str | None = None
    number: str | None = None


@dataclass(slots=True)
class ShipItem:
    """An item in a shipment — weight + (optional) dimensions."""

    weight_g: float
    description: str | None = None
    width_cm: float | None = None
    height_cm: float | None = None
    length_cm: float | None = None
    quantity: int | None = None
    declared_value: float | None = None


@dataclass(slots=True)
class ShipArgs:
    """Input shape for ``Session.ship``.

    Three actions over a unified envelope:
      - ``label``  Generate a shipping label (issues a tracking code)
      - ``quote``  Calculate carrier rates for a route + items
      - ``track``  Fetch current tracking status for a shipment

    Mirrors the backend's MetaShipArgs so the wire payload matches
    byte-for-byte. Operator overrides (Melhor Envio service ids, NFe
    access keys for declared-value shipments) flow through ``metadata``.
    """

    action: ShipAction
    origin: ShipAddress | None = None
    destination: ShipAddress | None = None
    items: list[ShipItem] | None = None
    service_level: ShipServiceLevel | None = None
    tracking_code: str | None = None
    metadata: dict[str, Any] | None = None


@dataclass(slots=True)
class ShipResult:
    id: str
    status: str
    tracking_code: str | None = None
    label_url: str | None = None
    carrier: str | None = None
    estimated_delivery: str | None = None
    cost_minor: int | None = None
    raw: Any = None


# ── codespar_ledger wire shape ─────────────────────────────────────


LedgerAction = Literal["entry", "balance", "account"]


@dataclass(slots=True)
class LedgerLeg:
    """One side of a journal entry. ``account`` is a Midaz account alias
    (e.g. ``@wallet/user_123``); ``amount`` is in minor units (cents)."""

    account: str
    amount: int


@dataclass(slots=True)
class LedgerArgs:
    """Input shape for ``Session.ledger``.

    Three actions over a tenant's self-hosted double-entry ledger
    (Lerian Midaz). Mirrors the backend's MetaLedgerArgs so the wire
    payload matches byte-for-byte. The connection (base_url + org_id +
    ledger_id) is operator-seeded, never passed by the agent. Amounts
    are in MINOR units (cents).
      - ``entry``    Post an n:n journal transaction (source debits must
                     equal destination credits, same asset)
      - ``balance``  Read an account's balances
      - ``account``  Create an account for an asset
    """

    action: LedgerAction
    asset: str | None = None
    scale: int | None = None
    source: list[LedgerLeg] | None = None
    destination: list[LedgerLeg] | None = None
    description: str | None = None
    account: str | None = None
    alias: str | None = None
    name: str | None = None
    type: str | None = None
    metadata: dict[str, Any] | None = None


@dataclass(slots=True)
class LedgerResult:
    id: str | None = None
    status: str | None = None
    account_id: str | None = None
    alias: str | None = None
    balances: Any = None
    raw: Any = None


# ── codespar_issue wire shape ──────────────────────────────────────


IssueAction = Literal["card-virtual", "card-physical", "card-control", "card-get"]


@dataclass(slots=True)
class IssueArgs:
    """Input shape for ``Session.issue`` (Pomelo card issuing).

    Mirrors the backend's MetaIssueArgs. Asset-agnostic — the program
    currency is set on the card program, not per call.
      - ``card-virtual``   Issue a virtual card (active immediately)
      - ``card-physical``  Issue a physical card (needs shipping_address)
      - ``card-control``   Freeze / unfreeze / cancel an existing card
      - ``card-get``       Read a card's status
    """

    action: IssueAction
    cardholder_id: str | None = None
    program_id: str | None = None
    card_id: str | None = None
    control: Literal["freeze", "unfreeze", "cancel"] | None = None
    reason: str | None = None
    shipping_address: dict[str, Any] | None = None
    metadata: dict[str, Any] | None = None


@dataclass(slots=True)
class IssueResult:
    id: str | None = None
    status: str | None = None
    card_type: str | None = None
    last_four: str | None = None
    cardholder_id: str | None = None
    program_id: str | None = None
    raw: Any = None


# ── codespar_shop wire shape ───────────────────────────────────────

ShopAction = Literal["search", "checkout", "checkout_status"]
ShopCheckoutStatus = Literal["in_progress", "ready_for_payment", "canceled"]


@dataclass(slots=True)
class ShopVariant:
    """One buyable SKU under a ``ShopOffer``.

    Note the field-name asymmetry the contract documents (not a bug):
    pass this ``sku_id`` as the checkout item's ``variant_id``. The
    product id is NOT buyable — only the SKU is.
    """

    sku_id: str
    available: bool
    title: str | None = None
    price_minor: int | None = None  # integer minor units (centavos)
    currency: str | None = None  # ISO-4217, default "BRL"


@dataclass(slots=True)
class ShopOffer:
    """A flattened catalog offer returned by ``search``."""

    product_id: str
    available: bool
    variants: list[ShopVariant]
    sku_id: str | None = None
    title: str | None = None
    price_minor: int | None = None
    currency: str | None = None
    image: str | None = None
    url: str | None = None


@dataclass(slots=True)
class ShopCheckoutItem:
    """A line item for a VTEX-rail ``checkout``."""

    variant_id: str  # pass ShopVariant.sku_id here
    quantity: int | None = None  # defaults to 1 when omitted
    seller: str | None = None  # VTEX marketplace sub-seller id


@dataclass(slots=True)
class ShopBuyer:
    """Optional vaulted buyer profile, merged with the saved profile."""

    name: str | None = None
    email: str | None = None
    cpf: str | None = None
    phone: str | None = None


@dataclass(slots=True)
class ShopAddress:
    """Optional vaulted delivery address; ``cep`` required when present."""

    cep: str
    street: str | None = None
    number: str | None = None
    complement: str | None = None
    neighborhood: str | None = None
    city: str | None = None
    state: str | None = None


@dataclass(slots=True)
class ShopArgs:
    """Input shape for ``Session.shop``.

    The closed action set is ``search | checkout | checkout_status``
    (default ``search``). Per-action field requirements:
      - ``search``: ``query`` required; ``limit`` clamped 1..20.
      - ``checkout``: ``items`` XOR ``url``, gated by rail (``items``
        for VTEX, ``url`` for the Mercado Livre PDP path).
      - ``checkout_status``: ``checkout_session_id`` required.

    Mirrors the TS ``ShopArgs`` discriminated union as a single
    dataclass; the ``shop()`` wrapper serializes only the fields the
    given action uses, matching the TS facade's wire payload.
    """

    action: ShopAction
    query: str | None = None
    limit: int | None = None
    merchant: str | None = None
    items: list[ShopCheckoutItem] | None = None
    url: str | None = None
    consumer_id: str | None = None
    buyer: ShopBuyer | None = None
    address: ShopAddress | None = None
    checkout_session_id: str | None = None


@dataclass(slots=True)
class ShopSearchResult:
    """Result of ``search``. Zero results is ``products=[]``, not error."""

    rail: str
    products: list[ShopOffer]


@dataclass(slots=True)
class ShopCheckoutResult:
    """Result of ``checkout`` — always async, status ``in_progress``."""

    checkout_session_id: str
    status: Literal["in_progress"]
    message: str | None = None


@dataclass(slots=True)
class ShopStatusResult:
    """Result of ``checkout_status``.

    ``pix_copia_e_cola`` + ``total_minor`` are present only at
    ``ready_for_payment``; ``error`` only at ``canceled``.
    """

    checkout_session_id: str
    status: ShopCheckoutStatus
    rail: str | None = None
    total_minor: int | None = None
    pix_copia_e_cola: str | None = None
    order_status: str | None = None
    error: str | None = None


ShopResult = ShopSearchResult | ShopCheckoutResult | ShopStatusResult


# ── /v1/tool-calls/:id/payment-status wire shape ───────────────────


PaymentStatus = Literal[
    "pending", "succeeded", "failed", "refunded", "updated", "unknown"
]


@dataclass(slots=True)
class PaymentStatusEvent:
    event_type: str
    received_at: str
    provider: str | None = None
    provider_action: str | None = None
    payment_id: str | None = None


@dataclass(slots=True)
class PaymentStatusResult:
    """Async settlement state for an originating meta-tool call.

    See ``Session.payment_status`` for usage. ``idempotency_key`` is
    None for legacy / non-meta-tool calls that didn't propagate a key
    upstream — those always resolve to ``payment_status="unknown"``.
    """

    tool_call_id: str
    payment_status: PaymentStatus
    idempotency_key: str | None
    original_status: str
    events: list[PaymentStatusEvent] = field(default_factory=list)


# ── /v1/tool-calls/:id/verification-status wire shape ──────────────


VerificationStatus = Literal[
    "pending", "approved", "rejected", "expired", "review", "unknown"
]


@dataclass(slots=True)
class VerificationStatusEvent:
    event_type: str
    received_at: str
    provider: str | None = None
    verification_id: str | None = None


@dataclass(slots=True)
class VerificationStatusResult:
    """Async KYC state for an originating ``codespar_kyc`` tool call.

    See ``Session.verification_status`` for usage. Priority across
    multiple events: approved > rejected > review > expired > pending.
    ``idempotency_key`` is None for legacy / non-meta-tool calls that
    didn't propagate a key upstream — those always resolve to
    ``verification_status="unknown"``. ``hosted_url`` is best-effort:
    Persona / Truora identity rails surface a buyer-facing URL, but
    server-side scoring rails (Sift, Konduto risk-score) return None.
    """

    tool_call_id: str
    verification_status: VerificationStatus
    idempotency_key: str | None
    original_status: str
    hosted_url: str | None = None
    events: list[VerificationStatusEvent] = field(default_factory=list)
