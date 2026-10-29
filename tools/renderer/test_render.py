"""The renderer's request filter and network guard (render.py, guard_proxy.py).
Run: tools/renderer/.venv/Scripts/python.exe -m unittest tools/renderer/test_render.py"""

import asyncio
import http.server
import os
import sys
import threading
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import render  # noqa: E402
from guard_proxy import GuardProxy  # noqa: E402


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

    def test_launch_flags_that_hide_automation_or_skip_checks_are_dropped(self):
        from crawl4ai import BrowserConfig
        from crawl4ai.browser_manager import BrowserManager

        args = BrowserManager(browser_config=BrowserConfig(headless=True, extra_args=["--x"]))._build_browser_args()
        for flag in ["--disable-blink-features=AutomationControlled", "--ignore-certificate-errors", "--ignore-certificate-errors-spki-list", "--no-sandbox"]:
            self.assertNotIn(flag, args["args"])
        self.assertIs(args["chromium_sandbox"], True)
        self.assertIn("--x", args["args"])


async def ask(port: int, head: str) -> bytes:
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    writer.write(head.encode())
    await writer.drain()
    data = await asyncio.wait_for(reader.read(200), 30)
    writer.close()
    return data


class Guard(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.allowed = ["example.com", "localhost", "127.0.0.1"]
        self.guard = GuardProxy(lambda: self.allowed, log=lambda m: None)
        self.port = await self.guard.start()

    async def asyncTearDown(self):
        await self.guard.close()

    async def test_refuses_hosts_that_are_not_the_shop(self):
        self.assertIn(b"403", await ask(self.port, "CONNECT other.example.org:443 HTTP/1.1\r\nHost: other.example.org:443\r\n\r\n"))

    async def test_refuses_local_addresses_even_when_listed(self):
        self.assertIn(b"403", await ask(self.port, "CONNECT 127.0.0.1:443 HTTP/1.1\r\n\r\n"))
        self.assertIn(b"403", await ask(self.port, "CONNECT localhost:443 HTTP/1.1\r\n\r\n"))
        self.assertIn(b"403", await ask(self.port, "GET http://127.0.0.1/ HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"))

    async def test_refuses_other_ports_and_websocket_upgrades(self):
        self.assertIn(b"403", await ask(self.port, "CONNECT example.com:22 HTTP/1.1\r\n\r\n"))
        self.assertIn(b"403", await ask(self.port, "GET http://example.com:8080/ HTTP/1.1\r\n\r\n"))
        self.assertIn(b"403", await ask(self.port, "GET http://example.com/ws HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"))

    async def test_tunnels_the_shop(self):
        self.assertTrue((await ask(self.port, "CONNECT example.com:443 HTTP/1.1\r\n\r\n")).startswith(b"HTTP/1.1 200"))


class ChromiumThroughTheGuard(unittest.IsolatedAsyncioTestCase):
    """A real Chromium with the renderer's flags and no page routing: a local server must receive nothing."""

    async def test_a_page_cannot_reach_a_local_server(self):
        from playwright.async_api import async_playwright

        hits = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                hits.append(self.path)
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"local")

            def log_message(self, *a):
                pass

        local = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=local.serve_forever, daemon=True).start()
        guard = GuardProxy(lambda: ["127.0.0.1", "localhost"], log=lambda m: None)
        port = await guard.start()
        try:
            async with async_playwright() as p:
                browser = await p.chromium.launch(args=[f"--proxy-server=http://127.0.0.1:{port}", "--proxy-bypass-list=<-loopback>"])
                page = await browser.new_page()
                for url in [f"http://127.0.0.1:{local.server_port}/", f"http://localhost:{local.server_port}/"]:
                    try:
                        await page.goto(url, timeout=15000)
                    except Exception:
                        pass
                await browser.close()
        finally:
            local.shutdown()
            await guard.close()
        self.assertEqual(hits, [])
        self.assertGreaterEqual(guard.refused, 1)


if __name__ == "__main__":
    unittest.main()
