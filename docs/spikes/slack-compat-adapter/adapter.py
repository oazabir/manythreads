"""manythreads outbound adapter (SPIKE P5-01, docs/spikes/slack-compat.md).

Delivers a Hermes reply into a manythreads channel thread through the
slack-compat door: ``POST {server}/api/slack-compat/chat.postMessage`` with
``{token, channel, thread_ts, text}``. ``chat_id`` is the manythreads channel
id, ``reply_to`` the thread root message id (absent for a channel message).
The pairing token in the body IS the credential (resolved server-side via
``app.bots_pairing_resolve``); the adapter holds no provider key, Hindsight
address or repo credential. Outbound-only: prompting the agent (inbound)
arrives via the generic ``webhook`` platform in the full P5-10 loop — the
spike drives ``send()`` directly (the model arrives with LiteLLM in P5-06).
"""

import logging
from typing import Any, Dict, List, Optional

try:
    import httpx
    HTTPX_AVAILABLE = True
except ImportError:
    HTTPX_AVAILABLE = False
    httpx = None  # type: ignore[assignment]

from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import BasePlatformAdapter, SendResult
from gateway.platforms._shared import get_scoped_secret as _get_scoped_secret, send_error
from gateway.platforms._shared import (
    extra_or_secret as _extra_or_secret, seed_extra_from_env as _seed_extra_from_env
)

logger = logging.getLogger(__name__)

MAX_MESSAGE_LENGTH = 40_000  # slack-compat door limit, same as any message


def _server_url(extra: Dict[str, Any]) -> str:
    return _extra_or_secret(extra, "server", "MANYTHREADS_SERVER_URL", "").rstrip("/")


def _pairing_token(extra: Dict[str, Any]) -> str:
    return _extra_or_secret(extra, "token", "MANYTHREADS_PAIRING_TOKEN", "").strip()


def check_requirements() -> bool:
    """Installable and minimally configured (env only — no full config load)."""
    return HTTPX_AVAILABLE and bool(
        _get_scoped_secret("MANYTHREADS_SERVER_URL", "").strip()
        and _get_scoped_secret("MANYTHREADS_PAIRING_TOKEN", "").strip())


def validate_config(config) -> bool:
    """True when a server URL and a pairing token are configured (extra or env)."""
    extra = getattr(config, "extra", {}) or {}
    return bool(_server_url(extra) and _pairing_token(extra))


def is_connected(config) -> bool:
    """Check whether the adapter is configured (env or config.yaml)."""
    return validate_config(config)


class ManythreadsAdapter(BasePlatformAdapter):
    """Outbound-only adapter: Hermes replies land in a manythreads thread."""

    MAX_MESSAGE_LENGTH = MAX_MESSAGE_LENGTH

    def __init__(self, config: PlatformConfig):
        super().__init__(config=config, platform=Platform("manythreads"))
        extra = config.extra or {}
        self._server: str = _server_url(extra)
        self._token: str = _pairing_token(extra)
        self._http_client: Optional["httpx.AsyncClient"] = None

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        if not HTTPX_AVAILABLE:
            logger.error("[manythreads] httpx is not installed")
            return False
        if not self._server or not self._token:
            logger.error("[manythreads] MANYTHREADS_SERVER_URL / MANYTHREADS_PAIRING_TOKEN not configured")
            return False
        self._http_client = httpx.AsyncClient(timeout=15.0)
        return True

    async def disconnect(self) -> None:
        client, self._http_client = self._http_client, None
        if client is not None:
            try:
                await client.aclose()
            except Exception:
                pass

    def _door_body(self, chat_id: str, content: str, reply_to: Optional[str]) -> Dict[str, Any]:
        """The exact slack-compat wire shape (mirrors ChatPostMessageRequest)."""
        body: Dict[str, Any] = {
            "token": self._token,
            "channel": chat_id,
            "text": content[:MAX_MESSAGE_LENGTH],
        }
        if reply_to:
            body["thread_ts"] = reply_to
        return body

    async def send(
        self, chat_id: str, content: str, reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        """POST the reply into the channel thread; the answer's `ts` is the delivery id."""
        if not self._http_client:
            return SendResult(success=False, error="HTTP client not initialized")
        if len(content) > MAX_MESSAGE_LENGTH:
            logger.warning(
                "[manythreads] Message truncated from %d to %d chars (door limit)",
                len(content), MAX_MESSAGE_LENGTH)
        try:
            resp = await self._http_client.post(
                f"{self._server}/api/slack-compat/chat.postMessage",
                json=self._door_body(chat_id, content, reply_to), timeout=15.0)
            if resp.status_code < 300:
                try:
                    ts = resp.json().get("ts", "")
                except Exception:
                    ts = ""
                return SendResult(success=True, message_id=ts)
            return SendResult(success=False, error=f"HTTP {resp.status_code}: {resp.text[:200]}")
        except Exception as e:
            logger.error("[manythreads] Send error: %s", e)
            return SendResult(success=False, error=str(e))

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        return {"name": chat_id, "type": "channel"}


def _env_enablement() -> dict | None:
    """``env_enablement_fn``: seed ``extra`` from env before adapter construction."""
    server = _get_scoped_secret("MANYTHREADS_SERVER_URL", "").strip().rstrip("/")
    token = _get_scoped_secret("MANYTHREADS_PAIRING_TOKEN", "").strip()
    if not server or not token:
        return None
    seed = _seed_extra_from_env((), home_env="MANYTHREADS_HOME_CHANNEL", home_default="")
    return {"server": server, "token": token, **seed}


async def _standalone_send(
    pconfig, chat_id: str, message: str, *,
    thread_id: Optional[str] = None, media_files: Optional[List[str]] = None, force_document: bool = False,
) -> Dict[str, Any]:
    """Out-of-process delivery when no gateway adapter is live (cron parity)."""
    if not HTTPX_AVAILABLE:
        return send_error("manythreads standalone send: httpx not installed")
    extra = getattr(pconfig, "extra", {}) or {}
    server = _server_url(extra)
    token = _pairing_token(extra)
    if not server or not token:
        return send_error("manythreads standalone send: MANYTHREADS_SERVER_URL / MANYTHREADS_PAIRING_TOKEN not set")
    body: Dict[str, Any] = {"token": token, "channel": chat_id, "text": message[:MAX_MESSAGE_LENGTH]}
    if thread_id:
        body["thread_ts"] = thread_id
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(f"{server}/api/slack-compat/chat.postMessage", json=body)
        if resp.status_code >= 300:
            return send_error(f"manythreads HTTP {resp.status_code}: {resp.text[:200]}")
        return {"success": True, "platform": "manythreads", "chat_id": chat_id,
                "message_id": resp.json().get("ts", "")}
    except Exception as e:
        return send_error(f"manythreads standalone send failed: {e}")


def register(ctx) -> None:
    """Plugin entry point — called by the Hermes plugin system at startup."""
    ctx.register_platform(
        name="manythreads", label="manythreads", adapter_factory=lambda cfg: ManythreadsAdapter(cfg),
        check_fn=check_requirements, validate_config=validate_config, is_connected=is_connected,
        required_env=["MANYTHREADS_SERVER_URL", "MANYTHREADS_PAIRING_TOKEN"],
        install_hint="pip install httpx   # already a Hermes dependency",
        env_enablement_fn=_env_enablement,
        cron_deliver_env_var="MANYTHREADS_HOME_CHANNEL",
        standalone_sender_fn=_standalone_send,
        max_message_length=MAX_MESSAGE_LENGTH, emoji="🧵",
        pii_safe=True,  # channel ids only — no phone numbers / emails to redact
        allow_update_command=True,
        platform_hint=(
            "You are communicating via manythreads channel threads. "
            "Replies land in the thread identified by the inbound route; "
            "keep them concise markdown, same as any channel message."
        ))
