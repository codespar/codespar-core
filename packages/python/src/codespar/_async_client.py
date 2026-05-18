"""
``AsyncCodeSpar`` — the canonical client class.

Holds an httpx.AsyncClient, exposes ``create(user_id, ...)`` to start a
session, and mirrors the TS ``CodeSpar`` constructor 1:1. The sync
``CodeSpar`` in ``_sync_client.py`` wraps every call through
``asyncio.run`` so the lightweight use-case works without the caller
having to write ``async def``.
"""

from __future__ import annotations

import os
import re
from types import TracebackType

import httpx

from ._async_session import (
    AsyncSession,
    build_session_info,
    wait_for_connections,
)
from ._http import DEFAULT_BASE_URL, request_json
from ._presets import preset_to_servers
from .errors import ApiError, ConfigError
from .types import SessionConfig

# Wire format for a project scope. Kept in sync with the TS SDK
# (`PROJECT_ID_REGEX` in packages/core/src/types.ts) so both clients
# reject the same project_id inputs.
_PROJECT_ID_RE = re.compile(r"^prj_[A-Za-z0-9]{16}$")


def _resolve_base_url(explicit: str | None) -> str:
    """Resolve the effective base URL.

    Mirrors the TypeScript constructor cascade — explicit option wins,
    then the ``CODESPAR_BASE_URL`` env var, then the production
    default. The env var lets a caller point the same client wiring
    at a local OSS runtime or at ``api.codespar.dev`` without
    rebuilding the call sites.
    """
    if explicit is not None:
        return explicit
    return os.environ.get("CODESPAR_BASE_URL") or DEFAULT_BASE_URL


class AsyncCodeSpar:
    """
    Async CodeSpar client. Pass an API key, create sessions, run them,
    close them. One client can spawn many sessions in parallel.

    Example::

        async with AsyncCodeSpar(api_key="csk_live_...") as cs:
            session = await cs.create("user_123", preset="brazilian")
            result = await session.send("charge R$500 via Pix")
            print(result.message)

    Timeout UNIT: every ``timeout`` here is in **seconds** (httpx
    convention) — e.g. ``timeout=30`` is 30 seconds. The TypeScript SDK
    (``@codespar/sdk``) uses **milliseconds** for the equivalent option.
    Do not copy a numeric timeout between the two SDKs without
    converting (30s in Python == ``timeout: 30000`` in TS).

    Cancellation: there is no AbortSignal in Python. Cancel an in-flight
    call by cancelling the awaiting asyncio task (e.g. asyncio.timeout()
    or task.cancel()); httpx tears the connection down. Note this only
    closes the connection — it does not undo an upstream side effect the
    backend already dispatched.
    """

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str | None = None,
        project_id: str | None = None,
        timeout: float = 60.0,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        if not api_key or not api_key.startswith("csk_"):
            raise ConfigError(
                "api_key is required and must start with 'csk_'. "
                "Get one from https://dashboard.codespar.dev."
            )
        if project_id is not None and not _PROJECT_ID_RE.match(project_id):
            raise ConfigError(
                "project_id must match ^prj_[A-Za-z0-9]{16}$ (e.g. 'prj_...')."
            )
        self._api_key = api_key
        self._base_url = _resolve_base_url(base_url).rstrip("/")
        self._project_id = project_id
        # Share one transport across every session spawned by this
        # client. Closing the client closes every in-flight request.
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(
            base_url=self._base_url,
            timeout=timeout,
        )

    @property
    def base_url(self) -> str:
        return self._base_url

    @property
    def project_id(self) -> str | None:
        return self._project_id

    async def create(
        self,
        user_id: str,
        config: SessionConfig | None = None,
        /,
        **kwargs: object,
    ) -> AsyncSession:
        """
        Start a session scoped to ``user_id``.

        ``config`` can be passed as a ``SessionConfig`` dataclass or as
        keyword arguments — both shapes work::

            await cs.create("user_123", preset="brazilian")
            await cs.create("user_123", SessionConfig(preset="brazilian"))
        """
        # Extract before _resolve_config so it doesn't reach the allowed-kwarg check.
        raw_timeout = kwargs.pop("timeout", None)
        timeout: float | None
        if raw_timeout is None:
            timeout = None
        elif isinstance(raw_timeout, bool) or not isinstance(raw_timeout, (int, float)):
            raise ConfigError(
                f"create(): 'timeout' must be a number of seconds, got {type(raw_timeout).__name__}"
            )
        else:
            timeout = float(raw_timeout)

        resolved = self._resolve_config(config, kwargs)
        servers = resolved.servers or preset_to_servers(resolved.preset)
        project_id = resolved.project_id or self._project_id

        body: dict[str, object] = {"servers": servers, "user_id": user_id}
        if resolved.metadata:
            body["metadata"] = resolved.metadata
        # Forward mocks verbatim — including the empty dict, which the
        # backend accepts (strict-mode R3a activates only on non-empty
        # maps). Omitting the key entirely keeps the absent-case wire
        # body byte-identical to the pre-PRD shape (R18 wire-neutral).
        if resolved.mocks is not None:
            body["mocks"] = resolved.mocks

        data = await request_json(
            self._client,
            "POST",
            "/v1/sessions",
            api_key=self._api_key,
            project_id=project_id,
            body=body,
            timeout=timeout,
        )
        if not isinstance(data, dict):
            raise ApiError("create: malformed response", status=0, body=data)

        info = build_session_info(
            data,
            base_url=self._base_url,
            api_key=self._api_key,
            project_id=project_id,
        )
        session = AsyncSession(
            info=info,
            client=self._client,
            api_key=self._api_key,
            project_id=project_id,
            base_url=self._base_url,
        )

        if resolved.manage_connections and resolved.manage_connections.wait_for_connections:
            await wait_for_connections(
                session,
                timeout_ms=resolved.manage_connections.timeout,
            )

        return session

    # ── lifecycle ───────────────────────────────────────────────────────

    async def aclose(self) -> None:
        """Close the underlying httpx transport."""
        if self._owns_client:
            await self._client.aclose()

    async def __aenter__(self) -> AsyncCodeSpar:
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        await self.aclose()

    # ── internals ───────────────────────────────────────────────────────

    def _resolve_config(
        self,
        config: SessionConfig | None,
        kwargs: dict[str, object],
    ) -> SessionConfig:
        """Accept either a SessionConfig dataclass or kwargs, never both."""
        if config is not None and kwargs:
            raise ConfigError(
                "Pass SessionConfig or keyword arguments, not both."
            )
        if config is not None:
            return config
        if not kwargs:
            return SessionConfig()

        allowed = {
            "servers",
            "preset",
            "manage_connections",
            "metadata",
            "project_id",
            "mocks",
        }
        unknown = set(kwargs) - allowed
        if unknown:
            raise ConfigError(
                f"create(): unknown keyword argument(s): {', '.join(sorted(unknown))}"
            )
        return SessionConfig(**kwargs)  # type: ignore[arg-type]
