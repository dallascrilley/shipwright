"""Test-only launcher for Symphony's real signed webhook application."""

from __future__ import annotations

import asyncio
import json
import signal
import sys
from pathlib import Path
from types import MethodType, SimpleNamespace

from aiohttp import web

from symphony.pr_review_runtime import PullRequestReviewRuntime
from symphony.pr_review_server import build_review_webhook_app
from symphony.pr_review_store import PullRequestReviewStore


async def run() -> None:
    if len(sys.argv) != 6:
        raise SystemExit(
            "usage: symphony-webhook-harness.py WORKFLOW PORT SECRET REPOSITORY INSTALLATION_ID"
        )
    workflow_path = Path(sys.argv[1]).resolve()
    port = int(sys.argv[2])
    secret = sys.argv[3]
    repository = sys.argv[4]
    installation_id = int(sys.argv[5])

    store = PullRequestReviewStore(workflow_path)
    runtime = PullRequestReviewRuntime.__new__(PullRequestReviewRuntime)
    runtime._store = store
    runtime._installation_id = installation_id
    runtime._task = None
    runtime._require_config = MethodType(
        lambda _self: SimpleNamespace(
            github_app=SimpleNamespace(webhook_secret=secret),
            tracker=SimpleNamespace(repository=repository),
        ),
        runtime,
    )

    app = build_review_webhook_app(runtime)

    async def state(_request: web.Request) -> web.Response:
        delivery_count = store._connect().execute(
            "SELECT COUNT(*) FROM github_webhook_deliveries"
        ).fetchone()[0]
        return web.json_response(
            {"delivery_count": delivery_count, **runtime.snapshot()}
        )

    app.router.add_get("/__test__/state", state)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", port)
    await site.start()

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for signal_name in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(signal_name, stop.set)

    print(
        json.dumps(
            {
                "port": port,
                "state_db": str(store.path),
            }
        ),
        flush=True,
    )
    await stop.wait()
    await runner.cleanup()
    store.close()


if __name__ == "__main__":
    asyncio.run(run())
