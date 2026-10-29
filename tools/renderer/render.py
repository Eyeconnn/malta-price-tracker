"""Headless page renderer for shops whose product pages need JavaScript (config.render = "browser").

Owner decision 29 Oct 2026: use Crawl4AI (pinned in requirements.txt) as the page renderer only. Every rule of the
project stays with the TypeScript fetcher (src/http/fetcher.ts), which calls this one page at a time: robots.txt
(checked with our own user agent before each page and on the final address), the 2 to 5 s gap and Crawl-delay,
backoff on 429 and 5xx, request caps, and the shop-only host list. This process adds what a browser needs:

- our SCRAPER_USER_AGENT, as given by the caller; no stealth, no random user agents, no simulated user, no
  navigator overrides, no anti-bot retries, no proxies, no fallback fetcher (all pinned off below). A page that
  answers with a bot check is returned as it is (its status) and is never worked around.
- the network guard (guard_proxy.py): every browser connection, loopback included, goes through a local proxy that
  allows only the shop's own hosts, refuses private, loopback and link-local addresses, and connects to the exact
  address it checked (no DNS rebinding). Redirects, WebSockets and service workers meet the same rule.
- on top of that, the page's own request routing loads no images, media or fonts (fewer requests to the shop),
  sends nothing to other sites, and closes every WebSocket.
- Crawl4AI's built-in launch flags that hide automation (AutomationControlled), skip certificate checks or turn
  off Chromium's sandbox are removed, and HTTPS certificate errors are not ignored.
- Crawl4AI's own robots.txt check is off: it fetches robots.txt with a different user agent. The caller checks.
- "Load more" (loadMore {button, items, maxClicks, gapMs: [min, max]}): the button is clicked at most maxClicks
  times, waiting a random gap in gapMs (the caller's 2 to 5 s or Crawl-delay) before each click, and stops when
  the button is gone or a click adds no items. Every page and data request the browser makes to the shop (document,
  xhr, fetch) is counted and reported as `requests`, so the caller counts them against its caps.

Protocol: one JSON object per line on stdin {id, url, allowedHosts, userAgent, waitFor?, timeoutMs?, loadMore?}, one
per line on stdout {id, ok, status, url, html, requests, clicks} or {id, ok: false, error, status?}. Logs go to
stderr. Ends at end of stdin.
Fetched pages are data: nothing in them is acted on here.
"""

import asyncio
import json
import os
import random
import sys
from urllib.parse import urlsplit

# the protocol owns stdout; anything a library prints goes to stderr
OUT = sys.stdout
sys.stdout = sys.stderr

from crawl4ai import AsyncWebCrawler, BrowserConfig, CacheMode, CrawlerRunConfig  # noqa: E402
from crawl4ai.browser_manager import BrowserManager  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from guard_proxy import GuardProxy, host_allowed, is_private  # noqa: E402

# Crawl4AI launch flags this project never uses: hiding that the browser is automated is a way around bot
# detection, and the others turn off certificate checks and the sandbox that protects this PC from a page
DROPPED_FLAGS = {
    "--disable-blink-features=AutomationControlled",
    "--ignore-certificate-errors",
    "--ignore-certificate-errors-spki-list",
    "--no-sandbox",
}
_build_browser_args = BrowserManager._build_browser_args


def _browser_args(self):
    args = _build_browser_args(self)
    args["args"] = [a for a in args["args"] if a not in DROPPED_FLAGS]
    return args


BrowserManager._build_browser_args = _browser_args

BLOCKED_TYPES = {"image", "media", "font"}
# the browser requests that count as requests to the shop (scripts and styles load like any visitor's)
COUNTED_TYPES = {"document", "xhr", "fetch"}
# how long a "Load more" click may take to add items
LOAD_MORE_WAIT_S = 30
MAX_HTML = 30 * 1024 * 1024

# the shop hosts of the request being rendered (one at a time)
current_hosts: list[str] = []
# the status of the last main-frame document answer: Crawl4AI reports the first answer of a redirect chain (301)
last_status: int | None = None
# page and data requests sent to the shop during the current render
shop_requests = 0
# the "Load more" settings of the current render, and the clicks made
current_load_more: dict | None = None
clicks = 0


async def on_route(route):
    global shop_requests
    req = route.request
    try:
        parts = urlsplit(req.url)
        if parts.scheme in ("data", "blob"):
            return await route.continue_()
        if parts.scheme not in ("http", "https") or req.resource_type in BLOCKED_TYPES:
            return await route.abort()
        host = parts.hostname or ""
        # only the shop itself: other sites' scripts, trackers and frames are not loaded (the guard refuses them too)
        if not host_allowed(host, current_hosts):
            return await route.abort()
        if await asyncio.to_thread(is_private, host):
            print(f"refused private address {host}", file=sys.stderr)
            return await route.abort()
        if req.resource_type in COUNTED_TYPES:
            shop_requests += 1
        return await route.continue_()
    except Exception as e:  # a request that cannot be checked is not sent
        print(f"route check failed: {e}", file=sys.stderr)
        try:
            await route.abort()
        except Exception:
            pass


def on_response(page):
    def record(resp):
        global last_status
        try:
            if resp.request.is_navigation_request() and resp.frame == page.main_frame:
                last_status = resp.status
        except Exception:
            pass

    return record


async def item_count(page, selector):
    try:
        return await page.eval_on_selector_all(selector, "els => els.length")
    except Exception:
        return -1


async def before_retrieve(page, context=None, **_):
    """Clicks "Load more" politely, one click at a time, until it is gone or adds nothing."""
    global clicks
    lm = current_load_more
    if not lm:
        return page
    gap_min, gap_max = (int(lm["gapMs"][0]), int(lm["gapMs"][1]))
    for _ in range(int(lm.get("maxClicks", 0))):
        # some shops hide the button and click it from script on scroll: it is clicked in the page, as their script does
        button = await page.query_selector(lm["button"])
        if button is None or await button.is_disabled():
            break
        before = await item_count(page, lm["items"])
        await asyncio.sleep(random.uniform(gap_min, max(gap_min, gap_max)) / 1000)
        await button.evaluate("el => el.click()")
        clicks += 1
        grew = False
        for _ in range(LOAD_MORE_WAIT_S * 2):
            await asyncio.sleep(0.5)
            if await item_count(page, lm["items"]) > before:
                grew = True
                break
        if not grew:
            break
    return page


async def close_socket(ws):
    print(f"refused WebSocket {ws.url[:120]}", file=sys.stderr)
    await ws.close()


async def on_context(page, context, **_):
    if not getattr(context, "_mtp_route", False):
        await context.route("**/*", on_route)
        await context.route_web_socket("**/*", close_socket)
        context._mtp_route = True
    if not getattr(page, "_mtp_status", False):
        page.on("response", on_response(page))
        page._mtp_status = True
    return page


def send(obj):
    OUT.write(json.dumps(obj) + "\n")
    OUT.flush()


async def render(crawler, msg):
    global current_hosts, last_status, shop_requests, current_load_more, clicks
    last_status = None
    shop_requests = 0
    clicks = 0
    current_load_more = msg.get("loadMore") or None
    url = str(msg["url"])
    current_hosts = [str(h).lower() for h in msg.get("allowedHosts", [])]
    if not current_hosts or not host_allowed(urlsplit(url).hostname or "", current_hosts):
        return {"ok": False, "error": "address outside the shop's hosts"}
    timeout = int(msg.get("timeoutMs") or 60000)
    if current_load_more:
        # every click may take its gap plus the wait for new items
        timeout += int(current_load_more.get("maxClicks", 0)) * (int(current_load_more["gapMs"][1]) + LOAD_MORE_WAIT_S * 1000)
    wait_for = msg.get("waitFor")
    cfg = CrawlerRunConfig(
        cache_mode=CacheMode.BYPASS,
        user_agent=str(msg["userAgent"]),
        user_agent_mode="",
        check_robots_txt=False,
        magic=False,
        simulate_user=False,
        override_navigator=False,
        max_retries=0,
        proxy_config=None,
        fallback_fetch_function=None,
        wait_until="domcontentloaded",
        wait_for=f"css:{wait_for}" if wait_for else None,
        page_timeout=timeout,
        delay_before_return_html=1.0,
        scan_full_page=False,
        remove_overlay_elements=False,
        verbose=False,
    )
    result = await crawler.arun(url=url, config=cfg)
    status = getattr(result, "status_code", None)
    # the page the browser ended on, not the first redirect
    if last_status is not None and not (300 <= last_status < 400):
        status = last_status
    final = getattr(result, "redirected_url", None) or url
    html = result.html or ""
    if len(html) > MAX_HTML:
        return {"ok": False, "error": f"page larger than {MAX_HTML} bytes", "status": status}
    if not result.success and not html:
        return {"ok": False, "error": (result.error_message or "render failed")[:500], "status": status}
    return {"ok": True, "status": status or 200, "url": final, "html": html, "requests": shop_requests, "clicks": clicks}


async def main():
    # our user agent from launch on (the caller passes it again with each page)
    ua = os.environ.get("MTP_USER_AGENT", "").strip()
    if not ua:
        print("MTP_USER_AGENT is not set", file=sys.stderr)
        sys.exit(2)
    guard = GuardProxy(lambda: current_hosts)
    port = await guard.start()
    browser = BrowserConfig(
        browser_type="chromium",
        headless=True,
        enable_stealth=False,
        user_agent=ua,
        user_agent_mode="",
        use_managed_browser=False,
        java_script_enabled=True,
        ignore_https_errors=False,
        # every connection through the guard; "<-loopback>" removes Chromium's own exception for local addresses
        extra_args=[f"--proxy-server=http://127.0.0.1:{port}", "--proxy-bypass-list=<-loopback>"],
        verbose=False,
    )
    async with AsyncWebCrawler(config=browser) as crawler:
        crawler.crawler_strategy.set_hook("on_page_context_created", on_context)
        crawler.crawler_strategy.set_hook("before_retrieve_html", before_retrieve)
        send({"ready": True})
        loop = asyncio.get_running_loop()
        while True:
            line = await loop.run_in_executor(None, sys.stdin.readline)
            if not line:
                break
            line = line.strip()
            if not line:
                continue
            msg_id = None
            try:
                msg = json.loads(line)
                msg_id = msg.get("id")
                out = await render(crawler, msg)
            except Exception as e:
                out = {"ok": False, "error": f"{type(e).__name__}: {e}"[:500]}
            send({"id": msg_id, **out})
    await guard.close()


if __name__ == "__main__":
    asyncio.run(main())
