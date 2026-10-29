# Page renderer (Crawl4AI)

Some shops only show their products after JavaScript runs, or load more of them with a "Load more" button
(The Atrium). For those shops the scraper renders listing pages in a headless Chromium through
[Crawl4AI](https://github.com/unclecode/crawl4ai), pinned in `requirements.txt` (owner decision, 29 Oct 2026).

Crawl4AI is only the renderer. Every rule of the project stays with the TypeScript fetcher
(`src/http/fetcher.ts`), which calls `render.py` one page at a time:

- robots.txt is checked with our own `SCRAPER_USER_AGENT` before every page and again on the page the browser
  ends on. Crawl4AI's own robots.txt check stays off, because it fetches robots.txt with a different user agent.
- the 2 to 5 s gap (or a longer Crawl-delay) applies between pages and between "Load more" clicks, and every
  page and data request the browser sends to the shop counts against the run's request caps.
- backoff on 429 and 5xx, and the shop-only host list, are the fetcher's as for any request.
- no stealth mode, no random user agents, no simulated user, no navigator overrides, no anti-bot retries, no
  proxies. A bot check is returned as it is and the request fails; it is never worked around. Crawl4AI's built-in
  launch flags that hide automation (`AutomationControlled`), skip certificate checks or turn off the sandbox are
  removed, and HTTPS certificate errors are not ignored.
- the network guard (`guard_proxy.py`): every browser connection, loopback included, goes through a local proxy that
  allows only the shop's own hosts on ports 443 and 80, refuses private, loopback and link-local addresses, and
  connects to the exact address it checked, so DNS rebinding, redirects, WebSockets and service workers cannot reach
  this PC's network. The page's own routing also loads no images, media or fonts, nothing from other sites, and
  closes WebSockets.

## Install (once, on the PC that runs the local shops)

```powershell
py -3.13 -m venv tools/renderer/.venv
tools/renderer/.venv/Scripts/python.exe -m pip install -r tools/renderer/requirements.txt
tools/renderer/.venv/Scripts/python.exe -m playwright install chromium
```

`RENDERER_PYTHON` can point at another Python with Crawl4AI installed. A shop with `config.render = "browser"`
on a machine without the renderer (GitHub's runners) stops at once with a clear error, so such shops use
`config.runner = "local"`.

## Shop settings

| `config` key | Meaning |
|---|---|
| `render: "browser"` | HTML pages are rendered in the browser |
| `render_urls` | regex: only matching addresses are rendered (the rest stay plain HTTP) |
| `render_wait_for` | CSS selector to wait for before the page is read |
| `render_load_more` | `{ button, items, max_clicks }`: click `button` until it is gone or adds no `items` |

## Tests

- `pnpm vitest run test/renderer-fetcher.test.ts`: the fetcher's rules around a fake renderer.
- `tools/renderer/.venv/Scripts/python.exe -m unittest tools/renderer/test_render.py`: the address filter, the
  guard, and a real Chromium that must not reach a local server.
