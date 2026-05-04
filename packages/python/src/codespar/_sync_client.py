"""
Sync wrappers over ``AsyncCodeSpar`` / ``AsyncSession``.

The async implementation is canonical; these classes do one thing:
run async methods to completion on a dedicated background event loop
so sync Python code can use the SDK without rewriting to asyncio.

Using a dedicated loop (not ``asyncio.run`` per call) keeps the
underlying httpx connection pool alive across calls, which matters
for scripts that create a session and then iterate over send() ten
times — we don't want to tear down TLS on every turn.
"""

from __future__ import annotations

import asyncio
import threading
from collections.abc import Coroutine, Iterator
from types import TracebackType
from typing import Any, TypeVar

from ._async_client import AsyncCodeSpar
from ._async_session import AsyncSession
from .errors import ConfigError
from .types import (
    AuthConfig,
    AuthResult,
    ChargeArgs,
    ChargeResult,
    ShipArgs,
    ShipResult,
    ConnectionWizardOptions,
    ConnectionWizardResult,
    DiscoverOptions,
    DiscoverResult,
    PaymentStatusResult,
    ProxyRequest,
    ProxyResult,
    SendResult,
    ServerConnection,
    SessionConfig,
    SessionInfo,
    StreamEvent,
    Tool,
    ToolResult,
    VerificationStatusResult,
)

T = TypeVar("T")


class _LoopRunner:
    """Background thread hosting a persistent asyncio loop."""

    def __init__(self) -> None:
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(
            target=self._loop.run_forever,
            name="codespar-async-loop",
            daemon=True,
        )
        self._thread.start()

    def run(self, coro: Coroutine[Any, Any, T]) -> T:
        future = asyncio.run_coroutine_threadsafe(coro, self._loop)
        return future.result()

    def close(self) -> None:
        self._loop.call_soon_threadsafe(self._loop.stop)
        self._thread.join(timeout=5)
        self._loop.close()


class Session:
    """Sync Session — blocking wrapper around ``AsyncSession``."""

    def __init__(self, async_session: AsyncSession, runner: _LoopRunner) -> None:
        self._async = async_session
        self._runner = runner

    # ── identity passthroughs ───────────────────────────────────────────

    @property
    def id(self) -> str:
        return self._async.id

    @property
    def user_id(self) -> str:
        return self._async.user_id

    @property
    def servers(self) -> list[str]:
        return self._async.servers

    @property
    def info(self) -> SessionInfo:
        return self._async.info

    @property
    def mcp(self) -> dict[str, Any]:
        return self._async.mcp

    # ── blocking calls ──────────────────────────────────────────────────

    def tools(self) -> list[Tool]:
        return self._runner.run(self._async.tools())

    def find_tools(self, intent: str) -> list[Tool]:
        return self._runner.run(self._async.find_tools(intent))

    def execute(self, tool_name: str, params: dict[str, Any]) -> ToolResult:
        return self._runner.run(self._async.execute(tool_name, params))

    def discover(
        self,
        use_case: str,
        options: DiscoverOptions | None = None,
    ) -> DiscoverResult:
        """Sync wrapper around ``AsyncSession.discover``. See that for docs."""
        return self._runner.run(self._async.discover(use_case, options))

    def connection_wizard(
        self,
        options: ConnectionWizardOptions,
    ) -> ConnectionWizardResult:
        """Sync wrapper around ``AsyncSession.connection_wizard``. See that for docs."""
        return self._runner.run(self._async.connection_wizard(options))

    def payment_status(self, tool_call_id: str) -> PaymentStatusResult:
        """Sync wrapper around ``AsyncSession.payment_status``. See that for docs."""
        return self._runner.run(self._async.payment_status(tool_call_id))

    def verification_status(self, tool_call_id: str) -> VerificationStatusResult:
        """Sync wrapper around ``AsyncSession.verification_status``. See that for docs."""
        return self._runner.run(self._async.verification_status(tool_call_id))

    def payment_status_stream(
        self,
        tool_call_id: str,
        *,
        on_update: Any | None = None,
    ) -> PaymentStatusResult:
        """
        Sync wrapper around ``AsyncSession.payment_status_stream``.
        ``on_update`` is invoked synchronously on the SDK's background
        loop for each state change; treat it as a hot path and avoid
        blocking work inside it (offload to a queue if you need sync
        IO). The call blocks until the backend closes the stream
        (terminal state + 5s grace).
        """
        return self._runner.run(
            self._async.payment_status_stream(tool_call_id, on_update=on_update),
        )

    def verification_status_stream(
        self,
        tool_call_id: str,
        *,
        on_update: Any | None = None,
    ) -> VerificationStatusResult:
        """Sync wrapper around ``AsyncSession.verification_status_stream``."""
        return self._runner.run(
            self._async.verification_status_stream(
                tool_call_id, on_update=on_update,
            ),
        )

    def charge(self, args: ChargeArgs) -> ChargeResult:
        """Sync wrapper around ``AsyncSession.charge``. See that for docs."""
        return self._runner.run(self._async.charge(args))

    def ship(self, args: ShipArgs) -> ShipResult:
        """Sync wrapper around ``AsyncSession.ship``. See that for docs."""
        return self._runner.run(self._async.ship(args))

    def proxy_execute(self, request: ProxyRequest) -> ProxyResult:
        return self._runner.run(self._async.proxy_execute(request))

    def send(self, message: str) -> SendResult:
        return self._runner.run(self._async.send(message))

    def send_stream(self, message: str) -> Iterator[StreamEvent]:
        """
        Sync generator that yields stream events as they arrive on the
        background event loop. Bridges the async iterator via a queue
        so calling code stays plain-``for event in session.send_stream``.
        """
        import queue

        q: queue.Queue[StreamEvent | object] = queue.Queue()
        sentinel = object()

        async def pump() -> None:
            try:
                async for event in self._async.send_stream(message):
                    q.put(event)
            except Exception as exc:
                q.put(exc)
            finally:
                q.put(sentinel)

        future = asyncio.run_coroutine_threadsafe(pump(), self._runner._loop)
        try:
            while True:
                item = q.get()
                if item is sentinel:
                    break
                if isinstance(item, BaseException):
                    raise item
                yield item  # type: ignore[misc]
        finally:
            # Make sure pump() finishes before the caller moves on.
            future.result(timeout=1)

    def authorize(self, server_id: str, config: AuthConfig) -> AuthResult:
        return self._runner.run(self._async.authorize(server_id, config))

    def connections(self) -> list[ServerConnection]:
        return self._runner.run(self._async.connections())

    def close(self) -> None:
        self._runner.run(self._async.close())


class CodeSpar:
    """
    Sync CodeSpar client. Drop-in replacement for the async client when
    you're writing a script or a sync framework handler.

    Example::

        cs = CodeSpar(api_key="csk_live_...")
        try:
            session = cs.create("user_123", preset="brazilian")
            print(session.send("charge R$500 via Pix").message)
        finally:
            cs.close()

    Or as a context manager::

        with CodeSpar(api_key="csk_live_...") as cs:
            ...
    """

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str | None = None,
        project_id: str | None = None,
        timeout: float = 60.0,
    ) -> None:
        self._runner = _LoopRunner()
        # Build the async client *on* the runner's loop so its httpx
        # transport binds to the right loop from day one.
        kwargs: dict[str, Any] = {"api_key": api_key, "timeout": timeout}
        if base_url is not None:
            kwargs["base_url"] = base_url
        if project_id is not None:
            kwargs["project_id"] = project_id

        async def factory() -> AsyncCodeSpar:
            return AsyncCodeSpar(**kwargs)

        self._async = self._runner.run(factory())

    @property
    def base_url(self) -> str:
        return self._async.base_url

    @property
    def project_id(self) -> str | None:
        return self._async.project_id

    def create(
        self,
        user_id: str,
        config: SessionConfig | None = None,
        /,
        **kwargs: object,
    ) -> Session:
        if config is not None and kwargs:
            raise ConfigError("Pass SessionConfig or keyword arguments, not both.")
        async_session = self._runner.run(
            self._async.create(user_id, config, **kwargs)
        )
        return Session(async_session, self._runner)

    def close(self) -> None:
        try:
            self._runner.run(self._async.aclose())
        finally:
            self._runner.close()

    def __enter__(self) -> CodeSpar:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.close()
