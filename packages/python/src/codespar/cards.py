"""
``cs.cards`` — card reads over the REST routes that are not a meta-tool call.

``cs.cards.readiness()`` is ``GET /v1/cards/readiness``: per program, whether
it is ready for this project and environment and the checklist of what is
missing, each step naming who must act (``holder``, ``company_signatory`` or
``org_admin``). The server computes it with the same function as the issue
requirements, so the checklist and an issue refusal never disagree.
Read-only. Mirrors ``cs.cards.readiness()`` in the TypeScript SDK; the
response is the wire shape as typed dicts.

Issue, read and control cards through ``session.card(...)``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Literal, TypedDict

import httpx

from ._http import request_json
from .errors import ApiError

if TYPE_CHECKING:
    from ._sync_client import _LoopRunner

CardRequirementStatus = Literal["done", "pending", "blocked", "not_applicable"]


class _CardRequirementRequired(TypedDict):
    #: A pending-action kind, or ``integration_connected`` / ``environment``.
    kind: str
    status: CardRequirementStatus
    actor: str


class CardRequirement(_CardRequirementRequired, total=False):
    """One step of a program's checklist."""

    action_url: str
    reason: str
    pending_action_id: str
    #: complete_holder_profile: exactly the fields still missing.
    missing_fields: list[str]
    mandate_id: str
    bound_api_key_ids: list[str]


class CardProgramReadiness(TypedDict):
    program: str
    issuer: str
    currency: str
    ready: bool
    requirements: list[CardRequirement]


class CardReadiness(TypedDict):
    """``GET /v1/cards/readiness``."""

    #: ``automated`` (API key / OAuth) or ``person`` (the dashboard).
    mode: Literal["automated", "person"]
    programs: list[CardProgramReadiness]


class AsyncCards:
    """``cs.cards`` on :class:`AsyncCodeSpar`."""

    def __init__(self, client: httpx.AsyncClient, api_key: str, project_id: str | None) -> None:
        self._client = client
        self._api_key = api_key
        self._project_id = project_id

    async def readiness(self, *, timeout: float | None = None) -> CardReadiness:
        """``GET /v1/cards/readiness``: what each program needs before an issue can succeed."""
        data = await request_json(
            self._client,
            "GET",
            "/v1/cards/readiness",
            api_key=self._api_key,
            project_id=self._project_id,
            timeout=timeout,
        )
        if not isinstance(data, dict) or not isinstance(data.get("programs"), list):
            raise ApiError("GET /v1/cards/readiness: malformed response", status=0, body=data)
        readiness: CardReadiness = data  # type: ignore[assignment]
        return readiness


class Cards:
    """``cs.cards`` on the sync :class:`CodeSpar`."""

    def __init__(self, inner: AsyncCards, runner: _LoopRunner) -> None:
        self._inner = inner
        self._runner = runner

    def readiness(self, *, timeout: float | None = None) -> CardReadiness:
        return self._runner.run(self._inner.readiness(timeout=timeout))
