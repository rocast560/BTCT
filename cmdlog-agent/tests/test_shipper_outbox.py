import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from btct_agent.shipper import Outbox, Shipper


class TestOutbox(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "outbox.ndjson"

    def tearDown(self):
        self.tmp.cleanup()

    def test_append_persist_reload(self):
        ob = Outbox(self.path)
        ob.append([{"id": "a"}, {"id": "b"}])
        self.assertEqual(len(ob), 2)
        # New instance reloads from disk.
        ob2 = Outbox(self.path)
        self.assertEqual(len(ob2), 2)
        self.assertEqual(ob2.drain(1), [{"id": "a"}])

    def test_overflow_drops_oldest(self):
        ob = Outbox(self.path, max_events=3)
        ob.append([{"id": str(i)} for i in range(5)])
        self.assertEqual(len(ob), 3)
        self.assertEqual(ob.dropped, 2)
        # Oldest two dropped → newest three remain, in order.
        self.assertEqual([e["id"] for e in ob.drain(3)], ["2", "3", "4"])

    def test_commit_removes_from_front(self):
        ob = Outbox(self.path)
        ob.append([{"id": "a"}, {"id": "b"}, {"id": "c"}])
        ob.commit(2)
        self.assertEqual([e["id"] for e in ob.drain(9)], ["c"])


class TestShipperDrain(unittest.TestCase):
    """Exercise the flush/outbox logic directly (no threads)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "outbox.ndjson"

    def tearDown(self):
        self.tmp.cleanup()

    def _shipper(self, poster):
        return Shipper("http://x/api", "tok", "ws", Outbox(self.path), batch_size=25, poster=poster)

    def test_failed_flush_spools_then_recovers(self):
        calls = {"n": 0}

        def failing(url, token, workspace, events, timeout=5.0):
            raise ConnectionRefusedError("down")

        s = self._shipper(failing)
        s._flush([{"id": "a"}, {"id": "b"}])
        self.assertEqual(len(s.outbox), 2)
        self.assertFalse(s.online)
        self.assertGreater(s.backoff, 1.0)

        # Server recovers: a working poster drains the outbox oldest-first.
        sent = []

        def ok(url, token, workspace, events, timeout=5.0):
            sent.extend(events)
            calls["n"] += 1

        s._poster = ok
        s._drain_outbox()
        self.assertEqual(len(s.outbox), 0)
        self.assertEqual([e["id"] for e in sent], ["a", "b"])
        self.assertTrue(s.online)

    def test_successful_flush_counts_sent(self):
        def ok(url, token, workspace, events, timeout=5.0):
            pass
        s = self._shipper(ok)
        s._flush([{"id": "a"}])
        self.assertEqual(s.sent, 1)
        self.assertEqual(len(s.outbox), 0)


if __name__ == "__main__":
    unittest.main()
