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
from collections.abc import AsyncIterator, Awaitable, Callable
from datetime import datetime
from typing import Any

import httpx

from ._http import request_json, stream_sse, stream_sse_get
from .errors import ApiError, ConfigError
from .types import (
    AssistantTextEvent,
    AuthConfig,
    AuthResult,
    ChargeArgs,
    ChargeResult,
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
    PaymentStatusEvent,
    PaymentStatusResult,
    ProxyRequest,
    ProxyResult,
    RequiredSecret,
    SendResult,
    ServerConnection,
    SessionInfo,
    ShipArgs,
    ShipResult,
    StreamEvent,
    Tool,
    ToolCallRecord,
    ToolResult,
    ToolResultEvent,
    ToolUseEvent,
    UserMessageEvent,
    VerificationStatusEvent,
    VerificationStatusResult,
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


def _parse_plan_step(raw: dict[str, Any]) -> DiscoverPlanStep:
    return DiscoverPlanStep(
        step=str(raw.get("step", "")),
        description=raw.get("description"),
        prereq=raw.get("prereq"),
        action=raw.get("action"),
    )


def _parse_tool_match(raw: dict[str, Any]) -> DiscoverToolMatch:
    return DiscoverToolMatch(
        server_id=str(raw.get("server_id", "")),
        tool_name=str(raw.get("tool_name", "")),
        description=str(raw.get("description", "")),
        http_method=str(raw.get("http_method", "")),
        endpoint_template=str(raw.get("endpoint_template", "")),
        cosine_distance=raw.get("cosine_distance"),
        trigram_similarity=raw.get("trigram_similarity"),
        connection_status=raw.get("connection_status", "disconnected"),
        known_pitfalls=list(raw.get("known_pitfalls") or []),
        recommended_plan=[_parse_plan_step(p) for p in (raw.get("recommended_plan") or [])],
    )


def _parse_discover_result(raw: dict[str, Any]) -> DiscoverResult:
    rec_raw = raw.get("recommended")
    rec = _parse_tool_match(rec_raw) if isinstance(rec_raw, dict) else None
    related_raw = raw.get("related") or []
    return DiscoverResult(
        use_case=str(raw.get("use_case", "")),
        search_strategy=raw.get("search_strategy", "empty"),
        recommended=rec,
        related=[_parse_tool_match(t) for t in related_raw if isinstance(t, dict)],
        next_steps=[str(s) for s in (raw.get("next_steps") or [])],
    )


def _parse_status_row(raw: dict[str, Any]) -> ConnectionStatusRow:
    return ConnectionStatusRow(
        server_id=str(raw.get("server_id", "")),
        display_name=str(raw.get("display_name", "")),
        auth_type=str(raw.get("auth_type", "")),
        status=raw.get("status", "disconnected"),
        difficulty=raw.get("difficulty", "easy"),
        connection_metadata=dict(raw.get("connection_metadata") or {}),
        connected_at=raw.get("connected_at"),
    )


def _parse_required_secret(raw: dict[str, Any]) -> RequiredSecret:
    return RequiredSecret(
        name=str(raw.get("name", "")),
        hint=raw.get("hint"),
    )


def _parse_initiate(raw: dict[str, Any]) -> ConnectionWizardInstructions:
    return ConnectionWizardInstructions(
        server_id=str(raw.get("server_id", "")),
        display_name=str(raw.get("display_name", "")),
        auth_type=str(raw.get("auth_type", "")),
        difficulty=raw.get("difficulty", "easy"),
        status=raw.get("status", "disconnected"),
        connect_url=str(raw.get("connect_url", "")),
        next_action=str(raw.get("next_action", "")),
        instructions=[str(s) for s in (raw.get("instructions") or [])],
        required_secrets=[
            _parse_required_secret(s)
            for s in (raw.get("required_secrets") or [])
            if isinstance(s, dict)
        ],
        known_pitfalls=[str(p) for p in (raw.get("known_pitfalls") or [])],
    )


def _parse_wizard_result(raw: dict[str, Any]) -> ConnectionWizardResult:
    status_raw = raw.get("status")
    initiate_raw = raw.get("initiate")
    return ConnectionWizardResult(
        action=raw.get("action", "list"),
        connections=[
            _parse_status_row(c)
            for c in (raw.get("connections") or [])
            if isinstance(c, dict)
        ],
        status=_parse_status_row(status_raw) if isinstance(status_raw, dict) else None,
        initiate=_parse_initiate(initiate_raw) if isinstance(initiate_raw, dict) else None,
    )


def _parse_charge_result(raw: dict[str, Any]) -> ChargeResult:
    return ChargeResult(
        id=str(raw.get("id", "")),
        status=str(raw.get("status", "")),
        amount=float(raw.get("amount", 0) or 0),
        currency=str(raw.get("currency", "")),
        method=str(raw.get("method", "")),
        charge_url=raw.get("charge_url"),
        pix_qr_code=raw.get("pix_qr_code"),
        pix_copy_paste=raw.get("pix_copy_paste"),
        raw=raw.get("raw"),
    )


def _parse_ship_result(raw: dict[str, Any]) -> ShipResult:
    return ShipResult(
        id=str(raw.get("id", "")),
        status=str(raw.get("status", "")),
        tracking_code=raw.get("tracking_code"),
        label_url=raw.get("label_url"),
        carrier=raw.get("carrier"),
        estimated_delivery=raw.get("estimated_delivery"),
        cost_minor=raw.get("cost_minor"),
        raw=raw.get("raw"),
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

    # ── meta-tool typed wrappers ────────────────────────────────────────

    async def discover(
        self,
        use_case: str,
        options: DiscoverOptions | None = None,
    ) -> DiscoverResult:
        """
        Search the catalog for a tool that matches a free-form use case.
        Typed wrapper around ``execute("codespar_discover", {...})`` —
        same wire shape, returns a parsed ``DiscoverResult`` so callers
        don't have to dig through ``ToolResult.data`` themselves.
        """
        params: dict[str, Any] = {"use_case": use_case}
        if options:
            if options.category is not None:
                params["category"] = options.category
            if options.country is not None:
                params["country"] = options.country
            if options.limit is not None:
                params["limit"] = options.limit
        result = await self.execute("codespar_discover", params)
        if not result.success:
            raise ApiError(
                f"discover failed: {result.error or 'unknown'}",
                status=0,
                body=result.error,
            )
        if not isinstance(result.data, dict):
            raise ApiError("discover: malformed response", status=0, body=result.data)
        return _parse_discover_result(result.data)

    async def connection_wizard(
        self,
        options: ConnectionWizardOptions,
    ) -> ConnectionWizardResult:
        """
        Surface the connection wizard for a server (or list every
        server's status). Typed wrapper around
        ``execute("codespar_manage_connections", {...})`` — UI components
        receive the parsed ``ConnectionWizardResult`` and render the
        wizard without further parsing.

        SECURITY: NEVER pass credentials through this method.
        Credentials only travel via the dashboard's connect modal or
        the OAuth callback. This method only returns deep-links +
        instructions + required secret NAMES.
        """
        params: dict[str, Any] = {}
        if options.action is not None:
            params["action"] = options.action
        if options.server_id is not None:
            params["server_id"] = options.server_id
        if options.country is not None:
            params["country"] = options.country
        if options.environment is not None:
            params["environment"] = options.environment
        if options.return_to is not None:
            params["return_to"] = options.return_to
        result = await self.execute("codespar_manage_connections", params)
        if not result.success:
            raise ApiError(
                f"connection_wizard failed: {result.error or 'unknown'}",
                status=0,
                body=result.error,
            )
        if not isinstance(result.data, dict):
            raise ApiError(
                "connection_wizard: malformed response",
                status=0,
                body=result.data,
            )
        return _parse_wizard_result(result.data)

    async def charge(self, args: ChargeArgs) -> ChargeResult:
        """
        Create an INBOUND charge — the buyer pays the merchant. Typed
        wrapper around ``execute("codespar_charge", {...})``. Distinct
        from the legacy ``codespar_pay`` rail (which routes to outbound
        transfers / payouts). Routes to providers that issue charges
        (Asaas create_payment, MP create_payment, Stripe payment_intent).

        ``args.amount`` is in MAJOR currency units (R$ 125.00 → 125.0).
        The backend transform converts to minor units when the chosen
        provider expects cents (Stripe).
        """
        params: dict[str, Any] = {
            "amount": args.amount,
            "currency": args.currency,
            "method": args.method,
            "description": args.description,
            "buyer": {
                "name": args.buyer.name,
                **({"email": args.buyer.email} if args.buyer.email else {}),
                **({"document": args.buyer.document} if args.buyer.document else {}),
                **({"phone": args.buyer.phone} if args.buyer.phone else {}),
            },
        }
        if args.due_date is not None:
            params["due_date"] = args.due_date
        result = await self.execute("codespar_charge", params)
        if not result.success:
            raise ApiError(
                f"charge failed: {result.error or 'unknown'}",
                status=0,
                body=result.error,
            )
        if not isinstance(result.data, dict):
            raise ApiError("charge: malformed response", status=0, body=result.data)
        return _parse_charge_result(result.data)

    async def ship(self, args: ShipArgs) -> ShipResult:
        """
        Generate a shipping label OR fetch tracking status. Typed
        wrapper around ``execute("codespar_ship", {...})``. Routes to
        Melhor Envio (BR domestic — Correios + private carriers) by
        default; international carriers ship under the same
        ``{origin, destination, items}`` envelope as additional rails
        come online.

        ``args.action`` is one of ``label`` | ``track`` | ``quote``.
        For ``label`` and ``quote``: origin + destination + items are
        required. For ``track``: only ``tracking_code`` is required.
        Operator overrides (Melhor Envio service id, NFe access key
        for declared-value shipments) flow through ``args.metadata``.
        """
        params: dict[str, Any] = {"action": args.action}
        if args.origin is not None:
            params["origin"] = {
                "postal_code": args.origin.postal_code,
                **({"city": args.origin.city} if args.origin.city else {}),
                **({"state": args.origin.state} if args.origin.state else {}),
                **({"country": args.origin.country} if args.origin.country else {}),
                **({"line_1": args.origin.line_1} if args.origin.line_1 else {}),
                **({"number": args.origin.number} if args.origin.number else {}),
            }
        if args.destination is not None:
            params["destination"] = {
                "postal_code": args.destination.postal_code,
                **({"city": args.destination.city} if args.destination.city else {}),
                **({"state": args.destination.state} if args.destination.state else {}),
                **({"country": args.destination.country} if args.destination.country else {}),
                **({"line_1": args.destination.line_1} if args.destination.line_1 else {}),
                **({"number": args.destination.number} if args.destination.number else {}),
            }
        if args.items is not None:
            params["items"] = [
                {
                    "weight_g": it.weight_g,
                    **({"description": it.description} if it.description else {}),
                    **({"width_cm": it.width_cm} if it.width_cm is not None else {}),
                    **({"height_cm": it.height_cm} if it.height_cm is not None else {}),
                    **({"length_cm": it.length_cm} if it.length_cm is not None else {}),
                    **({"quantity": it.quantity} if it.quantity is not None else {}),
                    **(
                        {"declared_value": it.declared_value}
                        if it.declared_value is not None
                        else {}
                    ),
                }
                for it in args.items
            ]
        if args.service_level is not None:
            params["service_level"] = args.service_level
        if args.tracking_code is not None:
            params["tracking_code"] = args.tracking_code
        if args.metadata is not None:
            params["metadata"] = args.metadata
        result = await self.execute("codespar_ship", params)
        if not result.success:
            raise ApiError(
                f"ship failed: {result.error or 'unknown'}",
                status=0,
                body=result.error,
            )
        if not isinstance(result.data, dict):
            raise ApiError("ship: malformed response", status=0, body=result.data)
        return _parse_ship_result(result.data)

    async def verification_status(
        self, tool_call_id: str
    ) -> VerificationStatusResult:
        """
        Async KYC poll for a meta-tool ``codespar_kyc`` call. Correlates
        a ``tool_call_id`` (the ``tc_xxx`` returned by ``execute``) back
        to the latest known disposition (pending → approved / rejected /
        review / expired). Generic across providers — relies on the
        ``idempotency_key`` propagated upstream + the
        ``external_reference`` field on the normalized event payload.
        Returns ``verification_status="unknown"`` for legacy calls that
        didn't propagate a key.

        Priority: approved > rejected > review > expired > pending.

        ``hosted_url`` is best-effort: Persona / Truora identity rails
        surface a buyer-facing link the agent can re-show; server-side
        scoring rails (Sift, Konduto risk-score) return None because
        no buyer-facing flow exists.
        """
        from urllib.parse import quote

        data = await request_json(
            self._client,
            "GET",
            f"/v1/tool-calls/{quote(tool_call_id, safe='')}/verification-status",
            api_key=self._api_key,
            project_id=self._project_id,
        )
        if not isinstance(data, dict):
            raise ApiError(
                "verification_status: malformed response", status=0, body=data
            )
        events_raw = data.get("events") or []
        return VerificationStatusResult(
            tool_call_id=str(data.get("tool_call_id", tool_call_id)),
            verification_status=data.get("verification_status", "unknown"),
            idempotency_key=data.get("idempotency_key"),
            original_status=str(data.get("original_status", "")),
            hosted_url=data.get("hosted_url"),
            events=[
                VerificationStatusEvent(
                    event_type=str(e.get("event_type", "")),
                    received_at=str(e.get("received_at", "")),
                    provider=e.get("provider"),
                    verification_id=e.get("verification_id"),
                )
                for e in events_raw
                if isinstance(e, dict)
            ],
        )

    async def verification_status_stream(
        self,
        tool_call_id: str,
        *,
        on_update: Callable[[VerificationStatusResult], Awaitable[None] | None]
        | None = None,
    ) -> VerificationStatusResult:
        """
        SSE-streamed sibling of ``verification_status``. Opens
        ``GET /v1/tool-calls/:id/verification-status/stream`` and
        invokes ``on_update`` (sync or async) for the initial
        snapshot + each subsequent state change. Resolves with the
        last envelope observed, which the backend pushes 5s after a
        terminal disposition (approved / rejected / expired) before
        closing the stream.

        Cancel from the caller side by wrapping the awaitable in an
        ``asyncio.Task`` and calling ``.cancel()`` — the backend
        sees the disconnect as a normal client close.

        The polling sibling stays live for backward compat — pick
        whichever fits the call site.
        """
        from urllib.parse import quote

        last: VerificationStatusResult | None = None
        async for event_name, raw in stream_sse_get(
            self._client,
            f"/v1/tool-calls/{quote(tool_call_id, safe='')}/verification-status/stream",
            api_key=self._api_key,
            project_id=self._project_id,
        ):
            if event_name in ("snapshot", "update"):
                if not isinstance(raw, dict):
                    continue
                events_raw = raw.get("events") or []
                last = VerificationStatusResult(
                    tool_call_id=str(raw.get("tool_call_id", tool_call_id)),
                    verification_status=raw.get("verification_status", "unknown"),
                    idempotency_key=raw.get("idempotency_key"),
                    original_status=str(raw.get("original_status", "")),
                    hosted_url=raw.get("hosted_url"),
                    events=[
                        VerificationStatusEvent(
                            event_type=str(e.get("event_type", "")),
                            received_at=str(e.get("received_at", "")),
                            provider=e.get("provider"),
                            verification_id=e.get("verification_id"),
                        )
                        for e in events_raw
                        if isinstance(e, dict)
                    ],
                )
                if on_update is not None:
                    result = on_update(last)
                    if asyncio.iscoroutine(result):
                        await result
            elif event_name == "done":
                break
        if last is None:
            raise ApiError(
                "verification_status_stream: stream closed before snapshot",
                status=0,
                body=None,
            )
        return last

    async def payment_status(self, tool_call_id: str) -> PaymentStatusResult:
        """
        Async settlement check for a meta-tool payment call. Correlates
        a ``tool_call_id`` (the ``tc_xxx`` returned by ``execute``) back
        to the latest known status (pending → succeeded / failed /
        refunded). Generic across providers — relies on the
        ``idempotency_key`` propagated upstream + the
        ``external_reference`` field on the normalized event payload.
        Returns ``payment_status="unknown"`` for legacy calls that
        didn't propagate a key.
        """
        from urllib.parse import quote

        data = await request_json(
            self._client,
            "GET",
            f"/v1/tool-calls/{quote(tool_call_id, safe='')}/payment-status",
            api_key=self._api_key,
            project_id=self._project_id,
        )
        if not isinstance(data, dict):
            raise ApiError(
                "payment_status: malformed response", status=0, body=data
            )
        events_raw = data.get("events") or []
        return PaymentStatusResult(
            tool_call_id=str(data.get("tool_call_id", tool_call_id)),
            payment_status=data.get("payment_status", "unknown"),
            idempotency_key=data.get("idempotency_key"),
            original_status=str(data.get("original_status", "")),
            events=[
                PaymentStatusEvent(
                    event_type=str(e.get("event_type", "")),
                    received_at=str(e.get("received_at", "")),
                    provider=e.get("provider"),
                    provider_action=e.get("provider_action"),
                    payment_id=e.get("payment_id"),
                )
                for e in events_raw
                if isinstance(e, dict)
            ],
        )

    async def payment_status_stream(
        self,
        tool_call_id: str,
        *,
        on_update: Callable[[PaymentStatusResult], Awaitable[None] | None]
        | None = None,
    ) -> PaymentStatusResult:
        """
        SSE-streamed sibling of ``payment_status``. Opens
        ``GET /v1/tool-calls/:id/payment-status/stream`` and invokes
        ``on_update`` (sync or async) for the initial snapshot + each
        subsequent state change. Resolves with the last envelope
        observed; the backend pushes a final ``done`` frame 5s after
        a terminal state (succeeded / failed / refunded).

        Cancel from the caller side by wrapping the awaitable in an
        ``asyncio.Task`` and calling ``.cancel()``. The polling
        sibling (``payment_status``) stays live for backward compat.
        """
        from urllib.parse import quote

        last: PaymentStatusResult | None = None
        async for event_name, raw in stream_sse_get(
            self._client,
            f"/v1/tool-calls/{quote(tool_call_id, safe='')}/payment-status/stream",
            api_key=self._api_key,
            project_id=self._project_id,
        ):
            if event_name in ("snapshot", "update"):
                if not isinstance(raw, dict):
                    continue
                events_raw = raw.get("events") or []
                last = PaymentStatusResult(
                    tool_call_id=str(raw.get("tool_call_id", tool_call_id)),
                    payment_status=raw.get("payment_status", "unknown"),
                    idempotency_key=raw.get("idempotency_key"),
                    original_status=str(raw.get("original_status", "")),
                    events=[
                        PaymentStatusEvent(
                            event_type=str(e.get("event_type", "")),
                            received_at=str(e.get("received_at", "")),
                            provider=e.get("provider"),
                            provider_action=e.get("provider_action"),
                            payment_id=e.get("payment_id"),
                        )
                        for e in events_raw
                        if isinstance(e, dict)
                    ],
                )
                if on_update is not None:
                    result = on_update(last)
                    if asyncio.iscoroutine(result):
                        await result
            elif event_name == "done":
                break
        if last is None:
            raise ApiError(
                "payment_status_stream: stream closed before snapshot",
                status=0,
                body=None,
            )
        return last

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
