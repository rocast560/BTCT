import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from btct_webrecon.crawler import _PageParser, _clean, _classify, _params
from btct_webrecon.httputil import in_scope, registrable_domain, host_of


HTML = """
<html><head><title>  Home Page </title>
<script src="/static/app.js"></script></head>
<body>
  <a href="/about">About</a>
  <a href="https://external.example/x">Ext</a>
  <a href="mailto:a@b.c">mail</a>
  <form action="/login" method="post">
    <input name="user"><input name="pass">
  </form>
</body></html>
"""


class ParserTest(unittest.TestCase):
    def test_extracts(self):
        p = _PageParser()
        p.feed(HTML)
        self.assertEqual(p.title, "Home Page")
        self.assertIn("/about", p.links)
        self.assertIn("https://external.example/x", p.links)
        self.assertIn("/static/app.js", p.scripts)
        self.assertEqual(len(p.forms), 1)
        action, method, inputs = p.forms[0]
        self.assertEqual(action, "/login")
        self.assertEqual(method, "POST")
        self.assertEqual(inputs, ["user", "pass"])


class HelpersTest(unittest.TestCase):
    def test_clean(self):
        self.assertEqual(_clean("https://x/a/", "b"), "https://x/a/b")
        self.assertIsNone(_clean("https://x/", "mailto:a@b"))
        self.assertIsNone(_clean("https://x/", "javascript:void(0)"))
        self.assertEqual(_clean("https://x/", "/p?q=1#frag"), "https://x/p?q=1")

    def test_classify(self):
        self.assertEqual(_classify("https://x/app.js", ""), "js")
        self.assertEqual(_classify("https://x/api/v1/users", ""), "api")
        self.assertEqual(_classify("https://x/graphql", ""), "api")
        self.assertEqual(_classify("https://x/about", "text/html"), "page")

    def test_params(self):
        self.assertEqual(sorted(_params("https://x/s?a=1&b=2")), ["a", "b"])

    def test_scope(self):
        self.assertEqual(registrable_domain("a.b.example.com"), "example.com")
        self.assertTrue(in_scope("https://api.example.com/x", "example.com", True))
        self.assertFalse(in_scope("https://evil.com/x", "example.com", True))
        self.assertFalse(in_scope("https://api.example.com/x", "example.com", False))
        self.assertEqual(host_of("https://a.example.com:8443/x"), "a.example.com")


if __name__ == "__main__":
    unittest.main()
