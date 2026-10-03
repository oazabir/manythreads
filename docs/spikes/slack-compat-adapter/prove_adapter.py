"""P5-01 spike proof: the manythreads Hermes adapter loads and emits the exact door shape.

Runs anywhere with the Hermes source checked out (never vendored here)::

    HERMES_SRC=~/.hermes/hermes-agent PLUGIN_DIR=~/.hermes/plugins/manythreads \
        python3 prove_adapter.py

What it proves:
  1. ``register(ctx)`` fires ``ctx.register_platform`` with ``name="manythreads"``.
  2. The factory builds a ``ManythreadsAdapter`` (i.e. ``Platform("manythreads")``
     resolves — plugin platforms are first-class enum values).
  3. ``connect()`` succeeds with server URL + pairing token configured.
  4. ``send(channel, text, reply_to=root)`` POSTs exactly
     ``{token, channel, thread_ts, text}`` to
     ``/api/slack-compat/chat.postMessage`` (mirrors ``ChatPostMessageRequest``),
     and the door's ``{ok, channel, ts}`` answer surfaces as ``SendResult``.

The door itself (token resolve, SYSTEM delivery job, idempotency) is proven by
``packages/plugins/slack-compat/test/slack-compat.test.ts``; the live loop
(adapter -> real server -> reply readable in the thread) is ``prove_live.mts``.
"""

import asyncio
import json
import os
import sys
import threading
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer

HERMES_SRC = os.environ.get("HERMES_SRC", os.path.expanduser("~/.hermes/hermes-agent"))
PLUGIN_DIR = os.environ.get("PLUGIN_DIR", os.path.expanduser("~/.hermes/plugins/manythreads"))
STUB_PORT = int(os.environ.get("SPIKE_STUB_PORT", "18099"))

sys.path.insert(0, HERMES_SRC)
sys.path.insert(0, PLUGIN_DIR)

import adapter  # noqa: E402

captured = {}


class StubDoor(BaseHTTPRequestHandler):
    """Stands in for the manythreads server: captures the POST, answers like the door."""

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        captured["path"] = self.path
        captured["body"] = json.loads(self.rfile.read(n) or b"{}")
        out = json.dumps(
            {"ok": True, "channel": captured["body"].get("channel"), "ts": str(uuid.uuid4())}
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *args):
        pass


class FakeCtx:
    """Stands in for Hermes's PluginContext: builds a REAL PlatformEntry in the
    REAL platform_registry — the same two calls hermes_cli/plugins.py makes —
    so Platform("manythreads") resolves exactly as it does at gateway runtime."""

    def __init__(self):
        from gateway.platform_registry import PlatformEntry, platform_registry

        self._entry_cls = PlatformEntry
        self._registry = platform_registry
        self.entry = None

    def register_platform(self, **kwargs):
        entry = self._entry_cls(
            name=kwargs["name"],
            label=kwargs["label"],
            adapter_factory=kwargs["adapter_factory"],
            check_fn=kwargs["check_fn"],
            validate_config=kwargs.get("validate_config"),
            required_env=kwargs.get("required_env") or [],
            install_hint=kwargs.get("install_hint", ""),
            source="plugin",
            plugin_name="manythreads-platform",
        )
        self._registry.register(entry)
        self.entry = entry


async def main() -> None:
    from gateway.config import PlatformConfig

    ctx = FakeCtx()
    adapter.register(ctx)
    reg = ctx.entry
    assert reg is not None and reg.name == "manythreads", "register_platform never fired for manythreads"
    print("1. register_platform fired into the real platform_registry: name=manythreads")

    channel_id, root_id = str(uuid.uuid4()), str(uuid.uuid4())
    cfg = PlatformConfig(
        enabled=True, extra={"server": "http://127.0.0.1:%d" % STUB_PORT, "token": "PROBE-TOKEN"}
    )
    inst = reg.adapter_factory(cfg)
    print("2. adapter constructed: %s" % type(inst).__name__)

    assert await inst.connect() is True, "connect() refused stub config"
    print("3. connect() ok (server URL + pairing token configured)")

    srv = HTTPServer(("127.0.0.1", STUB_PORT), StubDoor)
    threading.Thread(target=srv.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()
    try:
        res = await inst.send(channel_id, "[spike P5-01] hello from the Hermes adapter", reply_to=root_id)
    finally:
        srv.shutdown()
    await inst.disconnect()

    assert captured.get("path") == "/api/slack-compat/chat.postMessage", captured
    assert captured.get("body") == {
        "token": "PROBE-TOKEN",
        "channel": channel_id,
        "thread_ts": root_id,
        "text": "[spike P5-01] hello from the Hermes adapter",
    }, captured.get("body")
    assert res.success, res
    print("4. send() POST shape exact; SendResult success message_id=%s" % res.message_id)
    print("ADAPTER SPIKE PROOF PASSED")


if __name__ == "__main__":
    asyncio.run(main())
