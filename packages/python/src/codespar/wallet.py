"""
``cs.wallet`` — a consumer's own account, over the REST routes.

``cs.wallet.pix_keys`` is the typed client of
``/v1/consumers/:consumer_id/pix-keys`` (list, register, delete), the routes
the dashboard's "Minhas chaves" panel and the ``codespar_wallet`` pix_keys_*
actions act through. Mirrors ``cs.wallet.pixKeys`` in the TypeScript SDK;
responses are the wire shape as typed dicts.

Deleting needs ``confirm=True``: without it nothing is sent and
``PixKeyDeleteNotConfirmedError`` carries the consequence sentence, so a
program that forwards a person's answer cannot delete by omission.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Literal, TypedDict
from urllib.parse import quote

import httpx

from ._http import request_json
from .errors import ApiError, PixKeyDeleteNotConfirmedError

if TYPE_CHECKING:
    from ._sync_client import _LoopRunner

PixKeyType = Literal["EVP", "CPF", "CNPJ", "EMAIL", "PHONE"]


class PixKey(TypedDict):
    """One key as the bank lists it."""

    key: str
    key_type: str


class PixKeyList(TypedDict):
    """``GET /v1/consumers/:consumer_id/pix-keys``."""

    account_masked: str
    keys: list[PixKey]
    count: int


class _PixKeyRegisteredRequired(TypedDict):
    key: str
    key_type: str
    account_masked: str


class PixKeyRegistered(_PixKeyRegisteredRequired, total=False):
    """``POST /v1/consumers/:consumer_id/pix-keys``, 201."""

    cache_filled: bool
    #: True when the key came from re-reading the account's list (the bank's answer was unreadable).
    reconciled: bool


class _PixKeyDeletedRequired(TypedDict):
    key: str
    account_masked: str
    deleted: Literal[True]


class PixKeyDeleted(_PixKeyDeletedRequired, total=False):
    """``DELETE /v1/consumers/:consumer_id/pix-keys/:key``."""

    cache_cleared: bool
    cache_refilled_with: str | None


def _keys_path(consumer_id: str) -> str:
    return f"/v1/consumers/{quote(consumer_id, safe='')}/pix-keys"


class AsyncWalletPixKeys:
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

    async def list(self, consumer_id: str, *, timeout: float | None = None) -> PixKeyList:
        """``GET /v1/consumers/:consumer_id/pix-keys``: the account's keys, read from the bank."""
        data: PixKeyList = await self._call("GET", _keys_path(consumer_id), timeout=timeout)
        return data

    async def register(
        self,
        consumer_id: str,
        *,
        key_type: PixKeyType = "EVP",
        key: str | None = None,
        timeout: float | None = None,
    ) -> PixKeyRegistered:
        """``POST /v1/consumers/:consumer_id/pix-keys``.

        ``key_type`` is explicit (EVP, a random key, by default); ``key`` for
        every type but EVP. A Test project's own account registers only EVP.
        """
        body: dict[str, Any] = {"key_type": key_type}
        if key_type != "EVP" and key is not None:
            body["key"] = key
        data: PixKeyRegistered = await self._call(
            "POST", _keys_path(consumer_id), body=body, timeout=timeout
        )
        return data

    async def delete(
        self,
        consumer_id: str,
        key: str,
        *,
        confirm: bool = False,
        timeout: float | None = None,
    ) -> PixKeyDeleted:
        """``DELETE /v1/consumers/:consumer_id/pix-keys/:key``, only with ``confirm=True``."""
        if confirm is not True:
            raise PixKeyDeleteNotConfirmedError(key)
        data: PixKeyDeleted = await self._call(
            "DELETE", f"{_keys_path(consumer_id)}/{quote(key, safe='')}", timeout=timeout
        )
        return data


class AsyncWallet:
    """``cs.wallet`` on :class:`AsyncCodeSpar`."""

    def __init__(self, client: httpx.AsyncClient, api_key: str, project_id: str | None) -> None:
        self.pix_keys = AsyncWalletPixKeys(client, api_key, project_id)


class WalletPixKeys:
    def __init__(self, inner: AsyncWalletPixKeys, runner: _LoopRunner) -> None:
        self._inner = inner
        self._runner = runner

    def list(self, consumer_id: str, *, timeout: float | None = None) -> PixKeyList:
        return self._runner.run(self._inner.list(consumer_id, timeout=timeout))

    def register(
        self,
        consumer_id: str,
        *,
        key_type: PixKeyType = "EVP",
        key: str | None = None,
        timeout: float | None = None,
    ) -> PixKeyRegistered:
        return self._runner.run(
            self._inner.register(consumer_id, key_type=key_type, key=key, timeout=timeout)
        )

    def delete(
        self,
        consumer_id: str,
        key: str,
        *,
        confirm: bool = False,
        timeout: float | None = None,
    ) -> PixKeyDeleted:
        # The guard runs here too, before the loop is asked for anything.
        if confirm is not True:
            raise PixKeyDeleteNotConfirmedError(key)
        return self._runner.run(self._inner.delete(consumer_id, key, confirm=True, timeout=timeout))


class Wallet:
    """``cs.wallet`` on the sync :class:`CodeSpar`."""

    def __init__(self, inner: AsyncWallet, runner: _LoopRunner) -> None:
        self.pix_keys = WalletPixKeys(inner.pix_keys, runner)
