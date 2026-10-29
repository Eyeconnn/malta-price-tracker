"""The renderer's own request filter (render.py). Run: tools/renderer/.venv/Scripts/python.exe -m unittest tools/renderer/test_render.py"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import render  # noqa: E402


class AddressFilter(unittest.TestCase):
    def test_private_and_local_addresses_are_refused(self):
        for host in ["127.0.0.1", "10.1.2.3", "192.168.1.1", "172.16.0.5", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "[fe80::1]", "fc00::1", "localhost"]:
            self.assertTrue(render.is_private(host), host)

    def test_public_addresses_pass(self):
        for host in ["93.184.215.14", "8.8.8.8", "2606:4700::1111"]:
            self.assertFalse(render.is_private(host), host)

    def test_a_name_that_does_not_resolve_is_refused(self):
        self.assertTrue(render.is_private("does-not-exist.invalid"))

    def test_navigation_stays_on_the_shop_hosts(self):
        allowed = ["shop.example.mt"]
        self.assertTrue(render.host_allowed("shop.example.mt", allowed))
        self.assertTrue(render.host_allowed("www.shop.example.mt", allowed))
        self.assertTrue(render.host_allowed("SHOP.example.mt.", allowed))
        self.assertFalse(render.host_allowed("shop.example.mt.evil.com", allowed))
        self.assertFalse(render.host_allowed("evilshop.example.mt", allowed))


if __name__ == "__main__":
    unittest.main()
