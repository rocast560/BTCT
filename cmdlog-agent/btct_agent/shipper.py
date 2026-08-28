"""Batching, offline outbox, and the HTTP shipping loop.

Events are batched (25 events OR every 2s) and POSTed to /api/cmdlog/events. If
the server is unreachable the batch is spooled to a bounded on-disk outbox and
retried with exponential backoff; on recovery the outbox drains oldest-first so
nothing typed during a network blip is lost. Every event carries its id, and the
server dedups on it, so a retry whose success response was lost can't double-
insert.

Outbox is a bounded ring: on overflow the OLDEST events are dropped (so the live
tail stays current during a long outage) and a counter is bumped, surfaced via
status. urllib only: no third-party deps.
"""
from __future__ import annotations

import json
import queue
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from pathlib import Path
from typing import Callable, Deque, List, Optional


def post_events(url: str, token: str, workspace: Optional[str], events: List[dict], timeout: float = 5.0) -> None:
    """POST a batch. Raises urllib/OSError on any failure (network or non-2xx)."""
    body = json.dumps({"workspace": workspace, "events": events}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        code = getattr(resp, "status", resp.getcode())
        if code // 100 != 2:
            raise urllib.error.HTTPError(url, code, "non-2xx", resp.headers, None)


class Outbox:
    """Bounded, disk-backed FIFO of events awaiting delivery."""

    def __init__(self, path: Path, max_events: int = 70000) -> None:
        self.path = Path(path)
        self.max_events = max_events
        self.dropped = 0
        self._events: Deque[dict] = deque()
        self._load()

    def _load(self) -> None:
        try:
            for line in self.path.read_text().splitlines():
                if line.strip():
                    self._events.append(json.loads(line))
        except (OSError, ValueError):
            pass

    def _persist(self) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text("".join(json.dumps(e) + "\n" for e in self._events))
        except OSError:
            pass

    def __len__(self) -> int:
        return len(self._events)

    def append(self, events: List[dict]) -> None:
        self._events.extend(events)
        while len(self._events) > self.max_events:
            self._events.popleft()
            self.dropped += 1
        self._persist()

    def drain(self, n: int) -> List[dict]:
        """Peek the oldest up-to-n events WITHOUT removing them (removal is via
        `commit` after a successful send, so a failed send keeps them)."""
        return list(self._events)[:n]

    def commit(self, n: int) -> None:
        for _ in range(min(n, len(self._events))):
            self._events.popleft()
        self._persist()


class Shipper:
    """Owns the ship queue + a worker thread that batches and delivers."""

    def __init__(
        self,
        url: str,
        token: str,
        workspace: Optional[str],
        outbox: Outbox,
        batch_size: int = 25,
        flush_interval: float = 2.0,
        poster: Callable[..., None] = post_events,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.url = url
        self.token = token
        self.workspace = workspace
        self.outbox = outbox
        self.batch_size = batch_size
        self.flush_interval = flush_interval
        self._poster = poster
        self._clock = clock
        self.q: "queue.Queue[dict]" = queue.Queue()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self.sent = 0
        self.backoff = 1.0
        self.online = True

    def submit(self, event: dict) -> None:
        self.q.put(event)

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, name="cmdlog-shipper", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _run(self) -> None:
        pending: List[dict] = []
        last_flush = self._clock()
        while not self._stop.is_set():
            timeout = max(0.05, self.flush_interval - (self._clock() - last_flush))
            try:
                pending.append(self.q.get(timeout=timeout))
            except queue.Empty:
                pass
            due = (self._clock() - last_flush) >= self.flush_interval
            if pending and (len(pending) >= self.batch_size or due):
                self._flush(pending)
                pending = []
                last_flush = self._clock()
            elif due:
                last_flush = self._clock()
                self._drain_outbox()

    def _flush(self, batch: List[dict]) -> None:
        # Try the outbox first so ordering stays roughly FIFO after an outage.
        self._drain_outbox()
        try:
            self._poster(self.url, self.token, self.workspace, batch)
            self.sent += len(batch)
            self.online = True
            self.backoff = 1.0
        except Exception:
            self.online = False
            self.outbox.append(batch)
            self.backoff = min(self.backoff * 2, 30.0)

    def _drain_outbox(self) -> None:
        while len(self.outbox):
            batch = self.outbox.drain(self.batch_size)
            try:
                self._poster(self.url, self.token, self.workspace, batch)
                self.outbox.commit(len(batch))
                self.sent += len(batch)
                self.online = True
                self.backoff = 1.0
            except Exception:
                self.online = False
                self.backoff = min(self.backoff * 2, 30.0)
                return  # stop draining; retry next tick
