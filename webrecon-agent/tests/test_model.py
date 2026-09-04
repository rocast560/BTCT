import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from btct_webrecon.model import Collector, node_key


class ModelTest(unittest.TestCase):
    def test_node_key_format(self):
        self.assertEqual(node_key("endpoint", "https://x/a", "post"), "endpoint|POST|https://x/a")
        self.assertEqual(node_key("page", "https://x/", ""), "page||https://x/")

    def test_dedupe_and_merge(self):
        col = Collector()
        col.add("page", "https://x/a", status=200, source="crawl", tags=["t1"])
        col.add("page", "https://x/a", title="Hi", source="probe", tags=["t2"])
        nodes = col.nodes()
        self.assertEqual(len(nodes), 1)
        n = nodes[0]
        self.assertEqual(n.status, 200)
        self.assertEqual(n.title, "Hi")
        self.assertEqual(sorted(n.sources), ["crawl", "probe"])
        self.assertEqual(sorted(n.tags), ["t1", "t2"])

    def test_edges_deduped(self):
        col = Collector()
        a = col.add("root", "https://x/")
        b = col.add("page", "https://x/a")
        col.edge(a.key, b.key, "link")
        col.edge(a.key, b.key, "link")  # dup
        col.edge(a.key, b.key, "hierarchy")  # different kind
        doc = col.to_doc("https://x/")
        self.assertEqual(len(doc["edges"]), 2)

    def test_doc_shape(self):
        col = Collector()
        col.add("root", "https://x/")
        doc = col.to_doc("https://x/", scanned_at=123)
        self.assertEqual(doc["version"], 1)
        self.assertEqual(doc["tool"], "btct-webrecon")
        self.assertEqual(doc["scannedAt"], 123)
        self.assertEqual(doc["nodes"][0]["key"], node_key("root", "https://x/"))

    def test_self_edge_and_empty_ignored(self):
        col = Collector()
        col.edge("a", "a", "link")
        col.edge("", "b", "link")
        self.assertEqual(len(col.to_doc("t")["edges"]), 0)


if __name__ == "__main__":
    unittest.main()
