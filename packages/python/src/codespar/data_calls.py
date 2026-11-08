"""
``cs.research`` and ``cs.data_calls`` — Shop research and G3.1 data calls,
over the REST routes (``/v1/shop/agent/research``, ``/v1/shop/agent/data-calls``).

A data call is a per-call data service found by a research of
``task_kind="data_service"``. A key DRAFTS one from such an offer; it never
runs it. Running reserves the Wallet and makes the provider's call: that is the
person's authorization, so ``execute`` with a key always raises ``ApiError``
with status 403 and code ``person_required``. The person runs it in the Shop or
through an MCP client with their login.

Responses are the wire shape as typed dicts, the four states apart:
``quotation``, ``authorization``, ``commitment`` (the call at the provider),
``payment`` (Wallet) and ``confirmation``. ``data_call_outcome`` reads them into
one word. Mirrors ``session.research`` and ``cs.dataCalls`` in the TypeScript SDK.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Literal, TypedDict
from urllib.parse import quote

import httpx

from ._http import request_json
from .errors import ApiError

if TYPE_CHECKING:
    from ._sync_client import _LoopRunner

TaskKind = Literal["product", "service_plan", "reservation", "data_service"]
DataCallOutcome = Literal["succeeded", "uncertain", "refused", "failed", "pending"]


class DataCallCommitment(TypedDict, total=False):
    state: str
    attempt_id: str
    call_id: str
    at: str


class DataCallPayment(TypedDict, total=False):
    state: str
    held_minor: int
    debited_minor: int
    released_minor: int
    receipt_id: str


class DataCallConfirmation(TypedDict, total=False):
    state: str
    at: str
    source: str
    result_ref: str


class DataCall(TypedDict, total=False):
    """A data call as the API answers it (``DataCallView``), the four states apart."""

    proposal_id: str
    run_state: str
    awaiting: dict[str, Any] | None
    offer: dict[str, Any]
    quotation: dict[str, Any]
    authorization: dict[str, Any]
    commitment: DataCallCommitment
    payment: DataCallPayment
    confirmation: DataCallConfirmation
    error: dict[str, Any]
    actions: dict[str, bool]


class DataCallNextAction(TypedDict):
    """The protected action while a call waits for the person: its card, behind their sign-in."""

    kind: Literal["person_authorization"]
    url: str
    proposal_id: str
    description: str


class DataCallRead(TypedDict):
    """``GET /v1/shop/agent/data-calls/:id``: the call and its protected action.

    ``next_action`` is set while the call waits for the person, None otherwise.
    """

    data_call: DataCall
    next_action: DataCallNextAction | None


class DataCallCreated(DataCallRead):
    """``POST /v1/shop/agent/data-calls``."""

    idempotent_replay: bool


def next_action_of(err: BaseException) -> DataCallNextAction | None:
    """The protected action in a ``person_required`` refusal (``ApiError``), or None."""
    if (
        not isinstance(err, ApiError)
        or err.code != "person_required"
        or not isinstance(err.body, dict)
    ):
        return None
    error = err.body.get("error")
    details = error.get("details") if isinstance(error, dict) else None
    action = details.get("next_action") if isinstance(details, dict) else None
    if (
        isinstance(action, dict)
        and action.get("kind") == "person_authorization"
        and isinstance(action.get("url"), str)
    ):
        result: DataCallNextAction = action  # type: ignore[assignment]
        return result
    return None


def data_call_outcome(d: DataCall) -> DataCallOutcome:
    """One word from the four states (the same rule as ``dataCallOutcome`` in TypeScript)."""
    commitment = d.get("commitment", {}).get("state")
    confirmation = d.get("confirmation", {}).get("state")
    if confirmation == "confirmed":
        return "succeeded"
    if commitment == "uncertain":
        return "uncertain"
    if d.get("error") or commitment == "cancelled" or d.get("run_state") == "cancelled":
        return "refused"
    if commitment == "failed" or confirmation == "failed":
        return "failed"
    return "pending"


class _Rest:
    def __init__(self, client: httpx.AsyncClient, api_key: str, project_id: str | None) -> None:
        self._client = client
        self._api_key = api_key
        self._project_id = project_id

    async def _call(
        self, method: str, path: str, *, body: Any = None, timeout: float | None
    ) -> Any:
        data = await request_json(
            self._client,
            method,
            path,
            api_key=self._api_key,
            project_id=self._project_id,
            body=body,
            timeout=timeout,
        )
        if not isinstance(data, dict):
            raise ApiError(f"{method} {path}: malformed response", status=0, body=data)
        return data


class AsyncResearch(_Rest):
    """``cs.research`` on :class:`AsyncCodeSpar`."""

    async def create(
        self,
        query: str,
        *,
        task_kind: TaskKind | None = None,
        criteria: dict[str, Any] | None = None,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """``POST /v1/shop/agent/research``: offers compared, one recommendation; proposes nothing.

        For a data service: ``task_kind="data_service"`` and
        ``criteria={"data_service": {"params": {...}, "sku": ...}}`` (the wire's snake_case).
        """
        body: dict[str, Any] = {"query": query}
        if task_kind is not None:
            body["task_kind"] = task_kind
        if criteria is not None:
            body["criteria"] = criteria
        data = await self._call("POST", "/v1/shop/agent/research", body=body, timeout=timeout)
        research: dict[str, Any] = data["research"]
        return research

    async def get(self, research_id: str, *, timeout: float | None = None) -> dict[str, Any]:
        """``GET /v1/shop/agent/research/:id``."""
        data = await self._call(
            "GET", f"/v1/shop/agent/research/{quote(research_id, safe='')}", timeout=timeout
        )
        research: dict[str, Any] = data["research"]
        return research


class AsyncDataCalls(_Rest):
    """``cs.data_calls`` on :class:`AsyncCodeSpar`."""

    async def create(
        self, *, agent_id: str, offer_id: str, idempotency_key: str, timeout: float | None = None
    ) -> DataCallCreated:
        """``POST /v1/shop/agent/data-calls``: draft from a ``data_service`` offer.

        Nothing is reserved or sent.
        """
        data: DataCallCreated = await self._call(
            "POST",
            "/v1/shop/agent/data-calls",
            body={"agent_id": agent_id, "offer_id": offer_id, "idempotency_key": idempotency_key},
            timeout=timeout,
        )
        return data

    async def get(self, proposal_id: str, *, timeout: float | None = None) -> DataCallRead:
        """``GET /v1/shop/agent/data-calls/:id``: where it stands, the four states apart.

        An uncertain call is reconciled on this read, never resent: read the same id
        again, across restarts, until it is no longer pending.
        """
        data: DataCallRead = await self._call(
            "GET", f"/v1/shop/agent/data-calls/{quote(proposal_id, safe='')}", timeout=timeout
        )
        return data

    async def execute(self, proposal_id: str, *, timeout: float | None = None) -> DataCall:
        """``POST /v1/shop/agent/data-calls/:id/execute``: always refused for a key.

        The API answers ``person_required`` (403) with the person's protected action:
        ``next_action_of(err)`` reads it from the raised ``ApiError``.

        Raises ``ApiError``; present so the refusal is explicit, never a silent no-op.
        """
        await self._call(
            "POST",
            f"/v1/shop/agent/data-calls/{quote(proposal_id, safe='')}/execute",
            timeout=timeout,
        )
        raise ApiError(
            "data_calls.execute: the API answered a key's run without person_required; "
            "refusing to treat it as run",
            status=0,
            body=None,
        )


class Research:
    """``cs.research`` on the sync :class:`CodeSpar`."""

    def __init__(self, inner: AsyncResearch, runner: _LoopRunner) -> None:
        self._inner = inner
        self._runner = runner

    def create(
        self,
        query: str,
        *,
        task_kind: TaskKind | None = None,
        criteria: dict[str, Any] | None = None,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        return self._runner.run(
            self._inner.create(query, task_kind=task_kind, criteria=criteria, timeout=timeout)
        )

    def get(self, research_id: str, *, timeout: float | None = None) -> dict[str, Any]:
        return self._runner.run(self._inner.get(research_id, timeout=timeout))


class DataCalls:
    """``cs.data_calls`` on the sync :class:`CodeSpar`."""

    def __init__(self, inner: AsyncDataCalls, runner: _LoopRunner) -> None:
        self._inner = inner
        self._runner = runner

    def create(
        self, *, agent_id: str, offer_id: str, idempotency_key: str, timeout: float | None = None
    ) -> DataCallCreated:
        return self._runner.run(
            self._inner.create(
                agent_id=agent_id,
                offer_id=offer_id,
                idempotency_key=idempotency_key,
                timeout=timeout,
            )
        )

    def get(self, proposal_id: str, *, timeout: float | None = None) -> DataCallRead:
        return self._runner.run(self._inner.get(proposal_id, timeout=timeout))

    def execute(self, proposal_id: str, *, timeout: float | None = None) -> DataCall:
        return self._runner.run(self._inner.execute(proposal_id, timeout=timeout))
