# Malta price tracker (data collection)

Logs daily prices from Maltese web shops so that every Black Friday "was" price on 27 November 2026
can be tested against the EU rule that a discount is measured from the lowest price of the previous 30 days.

This repo is only the collection side: scrapers, database, scheduling, alerts. The website, cross-shop
matching, promo discovery and the verdict engine come later.

## Stack

TypeScript on Node 22 (ESM, run with `tsx`), pnpm, Postgres on Neon (`postgres` package), native `fetch`,
`cheerio`, `zod`, `robots-parser`, Cloudflare R2 through `@aws-sdk/client-s3`, Gmail SMTP (`nodemailer`) for email,
GitHub Actions cron for scheduling. `sharp` decodes images for the perceptual hash.

## Setup

```bash
pnpm install
cp .env.example .env        # fill in the values
pnpm migrate                # applies db/migrations/*.sql once each
pnpm seed                   # upserts shops.seed.json into the shops table
pnpm scrape --shop klikk --limit 20 --dry-run
```

### Environment variables

| Name | What |
| --- | --- |
| `DATABASE_URL` | Neon Postgres connection string |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | Cloudflare R2 bucket for images and HTML snapshots. Without them, images are skipped. |
| `GMAIL_USER`, `GMAIL_APP_PASSWORD` | Alert and summary emails through Gmail SMTP. The password is a Google app password (needs 2-step verification), not the account password. |
| `ALERT_EMAIL` | Recipients, comma separated. Defaults to `GMAIL_USER`. Without mail settings, emails are printed to the console. |
| `RESEND_API_KEY`, `ALERT_FROM` | Optional fallback sender through Resend. |
| `SCRAPER_USER_AGENT` | Sent on every request, as `Token/version (short description)`. The token (before `/`, or after `compatible;`) is matched against robots.txt groups. Keep the real value in `.env` and the GitHub variable only. Tested 20 Oct: UAs starting `Mozilla/5.0 (compatible; ...)` or containing `example.com` get 403 from AtoZ, Digital Zone and Sound & Vision. |

In GitHub Actions the secrets are repository secrets with the same names; `SCRAPER_USER_AGENT`,
`ALERT_FROM` and `SCRAPE_DUE_ENABLED` are repository variables.

## Running by hand

```bash
pnpm scrape --shop atoz                 # one shop, writes to the database
pnpm scrape --adapter shopify           # every active Shopify shop, in parallel
pnpm scrape --tier P1                   # every active P1 shop
pnpm scrape --shop atoz --limit 50 --dry-run   # fetch and print, write nothing (no database needed)
pnpm scrape-due                         # re-read warm/hot products whose next_check_at has passed
pnpm summary                            # send the daily summary email now
pnpm snapshot https://www.decathlon.mt/ --shop decathlon   # save a page's HTML to R2
pnpm sql "select slug, active from shops"                  # ad-hoc query
pnpm tsx src/cli/verify.ts out/dry-run-....json            # compare a dry-run sample with live product pages
```

Other flags for `scrape`: `--concurrency N` (shops in parallel, default 12), `--no-images`, `--no-alerts`,
`--sample N` (records kept for printing in dry runs). A shop named with `--shop` runs even if inactive.

To test database writes without Neon, `pnpm dev-db` starts an in-memory Postgres (PGlite) on
`127.0.0.1:55439`; use `DATABASE_URL=postgres://postgres@127.0.0.1:55439/postgres?sslmode=disable`.

## How it behaves

- **robots.txt** is fetched for every origin on every run and checked for every URL, including redirects.
  The group for our product token applies, else `*`. A Crawl-delay is honoured if longer than our gap.
  4xx robots means allow all; repeated 5xx means disallow all (RFC 9309) and the shop run fails.
  Skipped URLs are counted and listed in `scrape_runs.notes`. Text in robots.txt or pages that is not a crawl
  directive is ignored.
- **Politeness:** one request at a time per shop, a random 2 to 5 s gap (more if the shop config or robots says so),
  backoff on 429/5xx/timeouts (Retry-After honoured, otherwise 15, 30, 60 s), and the shop run is abandoned
  after 6 consecutive failures (status `partial` or `failed`). Different shops run in parallel.
  The fetcher only fetches the shop's own host (apex and subdomains) plus `extra_hosts` from its config.
- **Prices** are integer euro cents. One `price_observations` row per product per run.
- **Review flags:** a price of 0, a missing price, or a change of more than 70% since the previous observation
  sets `price_observations.review_flag` (`zero_price`, `missing_price`, `jump_70pct`) and triggers an alert.
- **Alerts** (one email per scrape invocation): run failed or did not finish, products seen more than 30% below
  the shop's 7-day average, more than 5% of fetches failed, flagged rows. Runs left unfinished for 7 hours are
  marked failed.
- **Daily summary** at 05:30 UTC: shops ok / partial / failed / missing, product counts.
- **Images:** each new `image_url` is downloaded once, stored in R2 as `images/{sha256}.{ext}` with sha256,
  a 64-bit dHash and dimensions. Up to `images_per_run` (300) images per shop per night, so large catalogues
  fill in over several nights. Image fetches on the shop's own host use the shop's rate limit.

## Adapters

All adapters return the same normalised record per variant (see `src/types.ts`) and implement
`crawl()` (whole catalogue) and `fetchOne()` (one product, cheaply).

| Adapter | Catalogue | One product |
| --- | --- | --- |
| `shopify` | `/products.json?limit=250&page=N` until empty, then product sitemap gaps read one by one | `/products/{handle}.js` (has availability), `.json` fallback |
| `woo` | Store API `/wp-json/wc/store/v1/products`, then `type=variation` for variable products (parents with their price range when variations cannot be listed) | `/wp-json/wc/store/v1/products/{id}` |
| `magento` | category pages, product pages (JSON-LD, `data-price-amount`) | product page |
| `html` | per-shop selectors, JSON-LD first | product page |
| `snapshot` | `snapshotUrl()` saves a page's HTML to R2 | |
| `headless` | not yet (The Atrium needs Playwright) | |

Helpers for later promo discovery: `shopifyCollections()` and `wooCategories()`.

## Adding a shop

1. Add an entry to `shops.seed.json`:
   ```json
   { "slug": "newshop", "name": "New Shop", "base_url": "https://newshop.com.mt", "category": "toys",
     "adapter": "shopify", "tier": "P2", "active": false, "config": {}, "notes": null }
   ```
2. Check its robots.txt by hand, then test: `pnpm scrape --shop newshop --limit 20 --dry-run` and
   `pnpm tsx src/cli/verify.ts out/<the file it wrote>`.
3. Set `"active": true` and commit. Every scrape workflow runs `pnpm seed` before scraping, so
   `shops.seed.json` is the source of truth for shops (edits made only in the database are overwritten).
4. If the shop refuses GitHub Actions IPs, add `"runner": "local"` to its config: GitHub then skips it
   and `pnpm scrape --runner local` (run on your own machine) covers it.

### Shop config keys

| Key | Meaning |
| --- | --- |
| `min_delay_ms`, `max_delay_ms` | gap between requests (default 2000 to 5000). Only raise these. |
| `timeout_ms` | per-request timeout (default 60000) |
| `page_size` | items per listing page (Woo max 100, Shopify max 250) |
| `adaptive_page_size` | Woo: shrink the page on timeouts, grow when fast (AtoZ) |
| `max_requests_per_hour` | budget for `scrape-due` (default 600) |
| `max_consecutive_failures` | give up on the shop after this many (default 6) |
| `extra_disallow` | regexes for URLs never fetched, on top of robots.txt |
| `extra_hosts` | other hosts this shop's fetcher may call |
| `sku_is_gtin` | copy numeric SKUs with a valid GTIN check digit into `gtin` |
| `mpn_from_sku` | regex with one capture group that extracts an MPN from the SKU |
| `images_per_run`, `images_minutes` | image download budget per night |
| `sitemap_fallback_max` | Shopify: max products read one by one when paging misses some |
| `runner` | `cloud` (default, GitHub Actions) or `local` (only `pnpm scrape --runner local` on your machine) |

## Schedule (GitHub Actions)

All cron times are UTC. Malta is UTC+2 until 25 October, then UTC+1, so 01:xx UTC is inside the
02:00 to 06:00 Malta window either way.

| Workflow | When | What |
| --- | --- | --- |
| `scrape-shopify` | 01:07 daily | `pnpm scrape --adapter shopify` |
| `scrape-woo` | 01:13 daily | `pnpm scrape --adapter woo` |
| `scrape-magento` | manual until tested | `pnpm scrape --adapter magento` |
| `scrape-html` | manual until tested | `pnpm scrape --adapter html` |
| `scrape-due` | hourly at :41, only when the repository variable `SCRAPE_DUE_ENABLED` is `true` | adaptive re-checks |
| `daily-summary` | 05:30 daily | summary email |
| `db-setup` | manual | migrations and seed |

Every workflow can also be run by hand from the Actions tab (scrape workflows accept a shop slug and a limit).

## Adaptive frequency (switch on 1 November)

`config/adaptive.json` holds the rules. After every observation `next_check_at` is set from the product's
tier: normal 24 h (covered by the nightly full run), warm 6 h, hot 2 h between 20 November and 1 December
(6 h outside that window). One price change in 7 days makes a product warm, two in 48 hours make it hot.
From 1 November products in electronics, appliances, gaming, toys and baby categories are at least warm.
`scrape-due` re-reads warm and hot products that are due, ordered by: in an active promotion, then price
changes in the last 7 days, then tier, within each shop's `max_requests_per_hour`. It never runs a shop that
has a full run in progress, and never goes below the robots.txt crawl delay.

To switch on: set the repository variable `SCRAPE_DUE_ENABLED` to `true`.

## Shops

`shops.seed.json` holds every shop: P1 (active), The Atrium (headless, inactive), P2 (inactive until P1 is stable).
Never scrape (robots-disallowed): Sports Direct Malta, Intersport, Lava.mt, Forestals, Celletronic.
