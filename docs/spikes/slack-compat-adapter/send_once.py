"""P5-01 spike: drive one Hermes adapter delivery from the shell (used by prove_live.mts).

Env: MANYTHREADS_SERVER_URL, MANYTHREADS_PAIRING_TOKEN, CHANNEL_ID, THREAD_TS
(optional), TEXT. Prints the door's delivery id (ts) on success. The token is
never printed. HERMES_SRC / PLUGIN_DIR override the import roots like
prove_adapter.py.
"""

import asyncio
import os
import sys

HERMES_SRC = os.environ.get("HERMES_SRC", os.path.expanduser("~/.hermes/hermes-agent"))
PLUGIN_DIR = os.environ.get("PLUGIN_DIR", os.path.expanduser("~/.hermes/plugins/manythreads"))

sys.path.insert(0, HERMES_SRC)
sys.path.insert(0, PLUGIN_DIR)

import adapter  # noqa: E402
from gateway.config import PlatformConfig  # noqa: E402
from gateway.platform_registry import PlatformEntry, platform_registry  # noqa: E402


class Ctx:
    def register_platform(self, **kwargs):
        entry = PlatformEntry(
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
        platform_registry.register(entry)
        return entry


async def main() -> None:
    server = os.environ["MANYTHREADS_SERVER_URL"]
    channel = os.environ["CHANNEL_ID"]
    text = os.environ["TEXT"]
    thread_ts = os.environ.get("THREAD_TS") or None
    ctx = Ctx()
    adapter.register(ctx)
    assert ctx_entry(ctx) is not None
    inst = ctx_entry(ctx).adapter_factory(
        PlatformConfig(enabled=True, extra={"server": server, "token": os.environ["MANYTHREADS_PAIRING_TOKEN"]})
    )
    assert await inst.connect() is True, "adapter connect() refused the config"
    try:
        res = await inst.send(channel, text, reply_to=thread_ts)
    finally:
        await inst.disconnect()
    if not res.success:
        raise SystemExit("adapter send failed: %s" % res.error)
    print("delivered ts=%s" % res.message_id)


def ctx_entry(ctx: Ctx):
    return platform_registry.get("manythreads")


if __name__ == "__main__":
    asyncio.run(main())
