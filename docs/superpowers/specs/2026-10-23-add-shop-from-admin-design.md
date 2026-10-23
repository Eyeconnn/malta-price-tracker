# Add a shop from the admin area: design

Date: 23 Oct 2026. Status: owner decisions taken; ready to plan.

## Why

The owner wants to type a shop's web address into the admin area and have the shop join the nightly scrape, without editing `shops.seed.json` or asking for a session.

## Owner decisions (23 Oct)

- **Automatic activation.** A shop that passes its check and test scrape joins the nightly scrape without a further click.
- **Checked within 15 minutes.** A new Windows task on the owner's PC looks for new addresses every 15 minutes.
- **Unsupported platforms are queued for setup.** A shop that is not Shopify, WooCommerce or Magento is marked "Needs setup" with what was found, for a later session to configure by hand (as Telecom and Eurosport were).

## How it works

The public site's Worker cannot scrape; scraping runs on the owner's PC (and GitHub). So the flow is:

1. **Admin, Add shop page** (`/admin/add-shop`): the owner enters an address and, optionally, a display name and shop category. The Worker validates it (https or http, a public host name, no IP address, no credentials, no port other than 80/443; stored as its origin, e.g. `https://example.com.mt`), refuses a host already in `shops` or already pending, and stores it in `shop_requests` with status `pending`. At most 20 requests may be pending at once. The page lists every request with its status and results and refreshes while any is pending.
2. **Check task on the PC** (`pnpm shop-requests`, Windows task "MTP Shop Requests", every 15 minutes, one run at a time): for each pending request, oldest first:
   - **robots.txt** with the scraper's own user agent (`SCRAPER_USER_AGENT`): if the home page or the product feed path is disallowed, status `blocked` with the rule that blocks it. Crawl-delay is recorded and obeyed.
   - **Platform detection**, at most about 10 requests, one at a time, 2 to 5 seconds apart, all through the existing `ShopFetcher` / `safeFetch` (private address blocking, retries, backoff): Shopify (`/products.json?limit=1` returns products), WooCommerce Store API (`/wp-json/wc/store/v1/products?per_page=1`), Magento GraphQL (`/graphql` with a tiny `storeConfig` query) or Magento HTML markers (`mage-init`, `Magento_`), else unsupported.
   - **Unsupported:** status `needs_setup`, storing what was found (server headers, generator meta tag, whether JSON-LD Product data is on product pages, a few category links).
   - **Supported:** create the `shops` row (slug from the host, name from the form or the site's `og:site_name` or title, `adapter` as detected, default config, `tier` P2, `config.runner = "local"` because many Maltese shops block GitHub's addresses, `active = false`), then run a **test scrape of 50 products** through the normal pipeline (the same rate limits as every other shop: one request at a time, 2 to 5 seconds apart, robots.txt and Crawl-delay obeyed, never faster than the defaults).
   - **Pass rule:** at least 10 products with a price above zero and a title, and no more than 20% of the requests failing. Pass: `active = true`, status `active`; the shop is scraped from the next nightly run. Fail: status `failed` with the reason, and the shop row stays inactive.
   - The request stores: detected platform, robots summary (allowed, crawl delay), products found, a sample of up to 10 products (title, price, link), the error if any, and timestamps.
   - Fetched content is treated as data. Text in pages addressed to AI agents is ignored (no AI is involved in this step).
3. **Admin actions on a request:** retry a `failed` or `blocked` request (back to `pending`), mark a request `rejected`, and deactivate a shop it created (the existing Shops admin page can already hide a shop from the public site).

## Data

- Migration `009_shop_requests.sql` (009 so it cannot clash with 007 and 008 on the names branch): `shop_requests (id bigserial, origin text not null, display_name text, shop_category text, status text not null check in (pending, checking, active, needs_setup, blocked, failed, rejected), requested_at, checked_at, platform text, robots jsonb, products_found int, sample jsonb, error text, shop_id int references shops, attempts int default 0)` with a unique index on `origin` for open statuses.
- Grants: `site_admin` gets select and insert on `shop_requests`, update of `status` only (for retry and reject) and usage on its sequence; `dashboard_ro` gets nothing on it. The PC task uses the owner role from `.env`.
- New shops live in the database. `pnpm seed` never deletes shops missing from `shops.seed.json`, so they are kept. A small `pnpm export-shops` writes database-only shops to `shops.added.json` so they can be committed if wanted.

## Safety

- Only the admin password can submit (existing second-layer admin check, same Origin and JSON rules as other admin writes).
- The Worker never fetches the submitted address. All fetching happens on the PC through `safeFetch`, which blocks private and local addresses at connection time, so the form cannot be used to reach internal machines.
- Rate limits are the project defaults and cannot be lowered from the form.
- A check takes at most about 60 requests per shop (detection plus the 50-product test).

## Not in scope

- Building custom configurations for unsupported shops (a later session per shop), email notifications (Gmail SMTP is not set up yet), and adding the shop to the public site's shop list before it has data (it appears after the next site-build, as "Not rated yet").

## Testing

- Worker: address validation (good addresses, IPs, credentials, ports, duplicates, the 20 pending cap), admin auth on every new route, CSRF rules.
- Detection: recorded responses for Shopify, WooCommerce, Magento GraphQL, Magento HTML and an unknown platform.
- Robots: disallowed home page, disallowed feed path, Crawl-delay recorded.
- Pass rule: 50 good products pass; 5 products fail; many failed requests fail.
- PGlite: the PC task moves a request through pending, checking and active, creates an inactive shop and activates it.
