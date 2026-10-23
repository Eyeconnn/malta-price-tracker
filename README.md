# Malta price tracker (data collection)

Logs daily prices from Maltese web shops so that every Black Friday "was" price on 27 November 2026
can be tested against the EU rule that a discount is measured from the lowest price of the previous 30 days.

This repo holds the collection side (scrapers, database, scheduling, alerts) and the public website in `web/`
(see "Public site" below).

## Stack

TypeScript on Node 22 (ESM, run with `tsx`), pnpm, Postgres on Neon (`postgres` package), native `fetch`,
`cheerio`, `zod`, `robots-parser`, Cloudflare R2 through `@aws-sdk/client-s3`, Gmail SMTP (`nodemailer`) for email,
GitHub Actions cron for scheduling. `sharp` makes the small photo copies and the perceptual hash.

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
- **Daily summary** at 05:30 UTC: shops ok / partial / failed / missing, product counts, and database size against the Neon plan (5 GB on Build, set `DB_LIMIT_MB` to change). Over 80% it says it is time to shrink the data. It also gives what R2 holds: the photo copies and the HTML snapshots, their total against the 10 GB free tier, with a warning from 8 GB.
- **Images (photos):** off until the environment variable `IMAGES_ENABLED` is set to `on` for the scrape. Nothing
  sets it yet: once this pipeline is merged it goes in `scripts/run-local.ps1` (for the shops scraped on the PC)
  and in the `env:` of the scrape workflows in `.github/workflows/` (for the others).
  One photo per product group, not per variant: the site row's own picture first, another variant's only when
  that one fails; Black Friday marked groups first, then the most recently seen. Only a small copy is stored:
  WebP, at most 480 px on the long side, quality 75, no metadata, first frame only, as
  `img/{sha256 of the original}.webp` with its width, height and bytes. Originals are never stored; the same
  original is stored once. SVG, other non-images, files over 15 MB and images over 50 megapixels are refused and
  recorded as failures, which are retried after 7 days. Up to `images_per_run` (300) image requests per shop per
  night within `images_minutes` (20), so large catalogues fill in over several nights. Image fetches on the shop's
  own host go on with the scrape run's own fetcher (its robots.txt, gap and Crawl-delay); allowlisted CDN hosts get
  one fetcher each with its own delay. A fetcher that gives up (6 failures in a row, such as hotlink 403s on a
  CDN) stops its images for the rest of that run without marking the remaining URLs as failed.
  Hard storage cap: no photo is downloaded once photos plus HTML snapshots plus a 100 MB allowance reach 9 GB
  (`PHOTO_STORAGE_CAP_BYTES` in `src/pipeline/images.ts`); going past it needs the owner's approval.

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

### Adding a shop from the admin area

The admin page **Add shop** (`/admin/add-shop`) takes a shop's web address, and optionally a display name and
a shop category. The Worker only checks the address (http or https, a public host name that is more than a
public suffix such as `com.mt`, no IP address in any spelling, no user name or password, no port) and stores
its origin, for example `https://shop.com.mt`, in `shop_requests`. It refuses a host that is already a shop or
already requested (`www.` and the apex count as one host), and more than 20 requests waiting or being checked
at once. The Worker never fetches the address.

The Windows task **MTP Shop Requests** (`scripts/run-shop-requests.ps1`, every 15 minutes, hidden window, one run
at a time) runs `pnpm shop-requests` on the PC, which checks due requests oldest first. It checks the stored
address again before fetching anything, and one check never makes more than 65 requests:

1. robots.txt with `SCRAPER_USER_AGENT`: if the home page or the product feed is disallowed, the request is
   **Blocked** with the rule that blocks it. Crawl-delay is recorded and obeyed; above 30 s the shop
   **Needs setup** (the check would take too long).
2. Platform detection, about 7 requests and never more than 10, one at a time, 2 to 5 s apart, through the
   normal `ShopFetcher`, with no retries: Shopify (`/products.json`), WooCommerce Store API, Magento GraphQL
   (`storeConfig`, then the adapter's own products query for one product), or Magento page markers. When
   Magento GraphQL answers but its product list errors, the shop is read as Magento pages if the markers are
   there, else it **Needs setup** with the GraphQL error.
3. Another platform: **Needs setup**, with what was found (server headers, generator tag, JSON-LD Product
   data on product pages, category links) for a later session to configure by hand.
4. A supported platform: the shop row is created inactive (slug from the host, name from the form or the
   site's `og:site_name` or title, tier P2, `config.runner = "local"`), then a test scrape runs through the
   normal pipeline at the usual pace: up to 200 product records, at most 55 requests (Magento pages: 5
   categories, for the test only). It passes with at least 10 distinct products (variants count once) that
   have a title and a price above zero and no more than 20% of requests failing: the shop becomes **Active**
   and joins the next nightly local scrape (and shows on the site after the next site-build). Otherwise it is
   **Failed** with the reason and the shop stays inactive.

**Rate limiting.** A 429 or a server error (5xx) at any step stops the check at once; no other path is tried.
The request goes back to **Waiting** and is not checked again before the longer of the shop's Retry-After and
2 hours, then 8 hours, then 24 hours; the page shows "Retrying after" with the time. After a fourth rate limit it
is **Failed** ("rate-limited repeatedly"). A 401, 403 or 202 (a bot check) makes it **Failed** at once; that is
never worked around. New shops are forced to `runner = "local"`, so every request comes from this PC: a shop
that rate-limits or blocks this PC's address cannot pass, even if it would answer GitHub's.

Statuses: Waiting (`pending`), Checking (`checking`), Active, Needs setup (`needs_setup`), Blocked, Failed,
Rejected. On the page, **Retry** sends a failed or blocked request back to waiting (it reuses the shop it
created, starts the automatic rate-limit retries afresh, and counts towards the 20) and **Reject** drops a
request, also while it is being checked (the check then leaves it rejected and its shop inactive). A check that
crashes is marked failed with the error; one left in checking by a killed run is set to failed after an hour.
The page refreshes every 30 seconds while a request is waiting or being checked, and not while the tab is
hidden.

To check one address by hand without touching the database:
`pnpm shop-requests --dry-run --url https://shop.com.mt`. Shops added this way live in the database (`pnpm seed`
never deletes shops missing from `shops.seed.json`); `pnpm export-shops` writes them to `shops.added.json` so
they can be committed if wanted.

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
| `scrape-shopify` | started by the PC task at 02:30 Malta; cron 01:07 UTC as a backup | `pnpm scrape --adapter shopify` |
| `scrape-woo` | started by the PC task at 02:30 Malta; cron 01:13 UTC as a backup | `pnpm scrape --adapter woo` |
| `scrape-magento` | started by the PC task at 02:30 Malta; cron 01:19 UTC as a backup | `pnpm scrape --adapter magento` |
| `scrape-html` | started by the PC task at 02:30 Malta; cron 01:25 UTC as a backup | `pnpm scrape --adapter html` |
| `scrape-due` | hourly at :41, only when the repository variable `SCRAPE_DUE_ENABLED` is `true` | adaptive re-checks |
| `daily-summary` | 05:30 daily | summary email |
| `db-setup` | manual | migrations and seed |

GitHub cron is best-effort and has run up to 5 hours late, so the Windows task `MTP Nightly Local Scrape` (02:30 Malta, `scripts/run-local.ps1`) starts the four scrape workflows with `gh workflow run` and then scrapes the local shops. Scheduled (cron) runs pass `--skip-done-hours 18`, so a late backup does nothing for shops already scraped. Windows tasks are installed with `scripts/install-tasks.ps1` (also `MTP Hourly Local Rechecks` and `MTP Shop Requests`, every 15 minutes, for shops added in admin).

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

## Clean product names (pilot)

`pnpm normalise-names` sends batches of one site category's product groups to Claude Code (`claude -p`, on the
owner's own Claude login, never an API key and never `--bare`) and gets back a clean name, a variant label and the
category's attributes (`config/attribute-schemas.json`). Every answer is checked in code (`src/names/check.ts`: the
brand, every number with its unit and every model code must survive, and no word or number may be invented; brand
values that are the shop's own name, a domain, a company or a distributor are not required and may not be added, see
`src/names/brand.ts`); a failed check is stored as rejected and the site keeps the
shop's title. Claude runs with tools off, no MCP servers, no user or project settings (so no hooks or plugins), no
session saved, in an empty temp folder with an allowlisted environment (no API keys, tokens or database URLs); shop
text is passed as data. A run that writes to the database needs `--pilot` or `--max-batches`.

```bash
pnpm normalise-names --model haiku --pilot --dry-run             # 500 groups spread over categories and shops, no writes
pnpm normalise-names --model sonnet --pilot --limit 200 --dry-run
pnpm normalise-names --model haiku --category toys --max-batches 5
pnpm normalise-names --model haiku --effort low --sample-from out/names/<run>-haiku.csv --dry-run   # the same groups again
```

Options: `--model` (required), `--effort` (low, medium, high, xhigh or max, passed to `claude --effort`; left out it is the CLI default), `--pilot` with `--limit` (default 500) and `--seed`, `--sample-from <csv>` (exactly the groups of an earlier report, by shop_id and group_key or, for older CSVs, by shop and title), `--category <slug>` (repeatable; filters on the category of today's rules, which every run recomputes),
`--batch-size` (default 40), `--parallel` (default 2, max 6), `--max-batches`, `--timeout` (seconds per call,
default 300), `--dry-run`, `--save-raw` (keeps each batch's raw JSON). Each run writes `out/names/<run>-<model>.html`
and `.csv` (names before and after, attributes, rejects, tokens and the cost Claude Code reports, which on a plan is
what the run would have cost at API prices). Reads use `DASHBOARD_DATABASE_URL`; without `--dry-run` the results go
to `product_names` and `name_runs` (migration 007) through `DATABASE_URL`. A group is only sent again when its title
or variant titles change. Ctrl+C stops after the running batches. `--max-cost <usd>` starts no new batch once the
summed reported cost reaches it (running batches finish). Batches take turns across categories, so a capped run covers
every category. A run stops after 5 failed batches in a row, and at once on a login or usage-limit error; the report and
`name_runs.finished_at` are written on every stop. `--retry-rejected` also resends groups stored as rejected;
`--recheck-stored` makes no model call and marks stored names rejected that today's checks would reject (with
`--dry-run` it only lists them).

### Nightly run

The Windows task `MTP Name Normaliser` (daily 05:00, after the 02:30 scrape, hidden, at most 4 hours, no second copy
while one runs; installed by `scripts/install-tasks.ps1`) runs `scripts/run-names-nightly.ps1` from the main checkout:

```bash
pnpm normalise-names --model haiku --effort low --max-batches 400 --max-cost 5 --parallel 3
```

It names the new or changed groups of the whole catalogue, at most 400 batches (about 16,000 groups) and about 5
dollars of reported cost per night (on the owner's plan this is usage, not a bill), and writes `product_names` and
`name_runs`; the next night continues with what is left. To change the caps, edit that line in
`scripts/run-names-nightly.ps1` (no reinstall needed); to stop it, disable or unregister the task. The log is
`out/names/nightly-YYYY-MM-DD.log`, the report `out/names/<run id>-haiku.html`. Progress:

```sql
select status, count(*) from product_names group by 1;
select id, started_at, finished_at, batches, items, accepted, rejected, failed_batches, reported_cost_usd
from name_runs order by id desc limit 10;
```

## Product matching by Claude (pilot)

`pnpm judge-matches` decides which listings of different shops (and the colours one shop lists on their own) are
exactly the same product, so a product page can show every seller's price (design "Update 23 Oct, afternoon" in
`docs/superpowers/specs/2026-10-22-names-and-attributes-design.md`).

1. **Candidates** (`src/match/candidates.ts`): fresh listings of visible shops that are likely one product: the
   title-similarity groups, plus listings sharing a model code (4 or more characters, or a 5 to 8 digit set number) in
   the same or a neighbouring category, never across two brands. At most 12 listings per group (larger ones are split
   by brand, model code and title); groups already matched by one barcode or part number are left out.
2. **Judging** (`src/match/judge.ts`): one `claude -p` call holds up to 15 groups (120 listings), with each listing's
   shop, title, variant titles, brand, shop category, codes, clean name, attributes and price. Claude answers which
   listings are exactly the same product and lists every difference between the others. Same runner and safety as
   the name normaliser: the owner's own login, never an API key or `--bare`, tools off, no MCP servers, no settings,
   allowlisted environment, shop text passed as data.
3. **Veto** (`src/match/veto.ts`): a "same" is overruled in code when the listings disagree on a number with a unit,
   a model code, model words (Pro, Plus, Ultra), condition, money, pack or piece count (variant titles included),
   audience or gender (also from the shop's category path), platform, edition, format, bundle words, OS or Windows
   version and edition, storage type, SIM, region (plug, version, import, NTSC, voltage), material, size words, the
   variety of a drink, food or toiletry, accessory or part words (case, refill, replacement heads), barcodes (two
   shops) and part numbers, a price more than 3 times another, the brand or the category. Every fact is read from the
   title and every variant title; the shop's category path adds gender, children's audience, accessory and model words.
4. **Storage**: `match_judgements` (one row per candidate group: members, fingerprint of their titles and variant
   titles, verdict, model, time) and `judge_runs` (migration 013). A group is judged again only when a member's title
   or variant titles change or another listing joins it.
5. **Site build**: with `pnpm site-build --judged-matching` (or `JUDGED_MATCHING=on`) the listings of a current,
   not vetoed judgement form a product with match method `judged`, trusted on the site like barcode matches. Barcode
   and part-number groups keep priority and are never merged with each other. Off by default.

Pilot first (a dry run writes only the report, `out/judge/<run>-<model>.html` and `.csv`: each group's listings with
shop, title and price, Claude's clusters and differences, the vetoes, tokens and cost per batch and per 100 groups):

```bash
pnpm judge-matches --model sonnet --effort low --pilot --limit 300 --dry-run --max-cost 10   # 300 groups spread over categories
pnpm judge-matches --model haiku --effort low --pilot --limit 300 --dry-run --max-cost 5     # the same groups (same seed), cheaper model
```

Full run, after the owner approves the pilot and `pnpm migrate` has added migration 013 (writes need it and
`DATABASE_URL`; reads use `DASHBOARD_DATABASE_URL` and work before it). A run that writes needs `--pilot` or
`--max-batches`, so cap it and repeat until nothing is left:

```bash
pnpm judge-matches --model sonnet --effort low --max-batches 200 --max-cost 20 --parallel 3
pnpm site-build --judged-matching      # or JUDGED_MATCHING=on in the site-build workflow once the owner switches it on
```

Options: `--model` (required), `--effort`, `--pilot` with `--limit` (default 300) and `--seed`, `--category <slug>`
(repeatable), `--batch-size` (groups per call, default 15), `--max-listings` (listings per call, default 120),
`--parallel` (default 2, max 6), `--max-batches`, `--max-cost <usd>` (no new batch once the reported cost reaches it),
`--timeout` (seconds per call, default 600), `--dry-run`, `--save-raw` (keeps each batch's raw JSON). A run stops
after 5 failed batches in a row and at once on a login or usage-limit error; Ctrl+C stops after the running batches.
Progress:

```sql
select count(*), count(*) filter (where jsonb_array_length(verdict -> 'final') > 0) as with_match from match_judgements;
select id, started_at, finished_at, groups, judged, rejected, matched, vetoes, failed_batches, reported_cost_usd
from judge_runs order by id desc limit 10;
```

## Public site (web/)

The public Black Friday Guide: a React app plus a Cloudflare Worker (`web/worker`, Worker name `bf-guide`) that serves the app and a JSON API. Shoppers check whether a Black Friday "was" price is real against the EU rule (lowest price of the previous 30 days). Verdicts, shop ratings and cross-shop matches are built from this repo's price history by the nightly `site-build` job; the Worker only reads them. The "How we check" page explains the rules to visitors and shows the live thresholds from `GET /api/thresholds`.

### Develop

```bash
pnpm web:worker     # the Worker and API on http://127.0.0.1:8788 (wrangler dev, reads web/.dev.vars)
pnpm web:dev        # the Vite dev server on http://127.0.0.1:5173; it proxies /api to port 8788
pnpm web:build      # builds the app into dist/web (the Worker serves it as static assets)
pnpm test test/web  # web and Worker tests
pnpm typecheck      # checks the repo and web/
```

`web/.dev.vars` is git-ignored and holds one line per Worker secret (names below): `DATABASE_URL`, `REPORTER_DATABASE_URL`, `ADMIN_DATABASE_URL`, `SITE_PASSWORD`, `ADMIN_PASSWORD`, `SITE_ORIGIN`, `IP_SALT`. Never commit it or paste its values anywhere.

### Deploy

```bash
pnpm web:deploy     # vite build, then wrangler deploy --cwd web
```

The site works on the `*.workers.dev` address and on a custom domain; `SITE_ORIGIN` says which.

### Worker secrets

Set each one with `pnpm exec wrangler secret put NAME --cwd web` (wrangler asks for the value), and again whenever it changes. Deploying does not change secrets.

| Secret | What it is for |
| --- | --- |
| `DATABASE_URL` | The read-only database URL (role `dashboard_ro`, the value of `DASHBOARD_DATABASE_URL` in `.env`). Every public read and the access settings use it. |
| `REPORTER_DATABASE_URL` | Role `site_reporter`: inserts "Something wrong?" reports and reads (ip_hash, created_at) for the rate limit. Nothing else. |
| `ADMIN_DATABASE_URL` | Role `site_admin`: used only by `/api/admin/*` (settings, report triage, shop hiding, match confirmation). |
| `SITE_PASSWORD` | The shared password (HTTP Basic, any user name) that protects the whole site while it is private. |
| `ADMIN_PASSWORD` | The separate password for `/admin` and `/api/admin/*`. It stays in force when the site is public. |
| `IP_SALT` | Required. Random text used to hash client IPs for the report rate limit. Without it, report submissions fail closed (generic 500). |
| `SITE_ORIGIN` | The site's address, such as the `workers.dev` URL or the custom domain. Used to accept same-site report posts. |
| `TURNSTILE_SECRET` | Optional. Set it only together with a Turnstile widget in the client; when set, reports must carry a valid token. |

### Database

`pnpm migrate` applies `db/migrations/*.sql` once each (it includes `006_reports_ip_index.sql`). The two write roles are created, or given new passwords, with `pnpm exec tsx scripts/create-site-roles.ts`, which writes `REPORTER_DATABASE_URL` and `ADMIN_DATABASE_URL` to `.env` (it needs the owner connection in `DATABASE_URL`).

### Photos

Product photos come from our own small copies in R2 (bucket in `R2_BUCKET`, binding `BUCKET` in `web/wrangler.toml`), never from the shops, so a shop never sees a visitor. The site build copies the stored key of each group's photo into `site_products.image_key` (shown variant, else the representative, else any variant). The API gives `imageUrl: "/img/<sha256>.webp"` or null and no shop image address anywhere; the Worker serves `GET /img/<sha256>.webp` (64 lowercase hex only, else 404) as `image/webp` with `nosniff` and a year of immutable caching, behind the same access check as every page (`private` caching while the site is private). The CSP stays `img-src 'self' data:`. Downloads stay off until `IMAGES_ENABLED=on` is set for the scrape (see Images above). Run `pnpm migrate` (014 adds `image_key`) before deploying the Worker, since the API reads that column. Storage must stay inside the R2 free tier (10 GB) unless the owner approves more (downloads stop at the 9 GB cap): about 190,000 product groups at roughly 20 KB per copy is about 4 GB.

### Nightly site-build

`pnpm site-build` turns the scraped prices into `site_products`, verdicts and `shop_ratings`. The `site-build` workflow runs it after `pnpm migrate`. `scripts/run-local.ps1` starts the workflow with `gh workflow run site-build` after the scrapes, and the workflow's own cron at 04:55 UTC is a backup that skips when a build ran in the last 20 hours (`--skip-if-built-hours 20`). Threshold and category changes made in admin reach verdicts and ratings at the next build.

### Admin

Open `/admin` and sign in with `ADMIN_PASSWORD` (any user name). Admin pages are never indexed.

| Page | What it does |
| --- | --- |
| Settings | The public switch, and the category overrides (shop category text to site category; applied at the next site-build). |
| Phrases | The home page headlines for each time slot (morning, afternoon, evening, late, Black Friday week). |
| Thresholds | The verdict and rating thresholds: history days, baseline days, raise window, raise %, good drop %, cheaper %, and judged products needed for a rating. |
| Reports | The "Something wrong?" reports: read them, set a status, add a note. |
| Shops | Show or hide a shop on the public site. |
| Add shop | Add a shop by its web address; the PC checks it within 15 minutes (see "Adding a shop from the admin area"). |
| Matches | Confirm products linked across shops by title only; "Cheaper at" uses them only once confirmed. |

### The public switch

The site is private until the switch on the admin Settings page is turned on. While it is private, every request needs `SITE_PASSWORD` and every response carries `noindex`. After a change, the Worker that saved it follows at once and other Cloudflare servers within 60 seconds. Cached API responses (everything except search and admin) refresh within 10 minutes.

## Shops

`shops.seed.json` holds every shop: P1 (active), The Atrium (headless, inactive), P2 (inactive until P1 is stable).
Never scrape (robots-disallowed): Sports Direct Malta, Intersport, Lava.mt, Forestals, Celletronic.
