# Public Site, Launch Core: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deploy the private-until-launch Black Friday Guide site with the launch must-haves: welcome, search, deals, shops, product pages (Simple and Advanced), verdicts, shop ratings, community flags, admin, and "How we check".

**Architecture:** A nightly Node job (`pnpm site-build`, in the existing scraper repo) turns raw prices into a small denormalised `site_products` table (one row per parent product per shop, with verdict, category and match) plus `shop_ratings`. A new React app in `web/` is served by one Cloudflare Worker that also exposes a JSON API reading Neon through the read-only role; the few writes (reports, admin settings) go through a limited write role. Verdict, rating, category and matching rules are pure TypeScript functions with unit tests, shared by the job.

**Tech Stack:** TypeScript, Node 22, `postgres` (job), Vitest; web: React 18 + Vite + Tailwind CSS + shadcn/ui + lucide-react + react-router + Recharts; Cloudflare Workers (static assets + API) with `@neondatabase/serverless`; Wrangler.

**Spec:** `docs/superpowers/specs/2026-10-22-public-site-design.md` (read sections 6, 7, 9a before any task).

**Later plans (not in this one):** hall of shame, evidence snapshots, share cards, shop logos, price watch emails, compare-4, CSV download, shop-level charts, basket check, browser button, wait-or-buy.

## Global Constraints

- Never use the em dash character in any file, comment, copy or commit message.
- Do not use VLTC-related connectors; use only local tools, `gh`, `wrangler`, and credentials in `.env`.
- Hosting is Cloudflare. The site must work on `*.workers.dev` and on a custom domain set by env (`SITE_ORIGIN`).
- Public read queries use the existing read-only role (`DASHBOARD_DATABASE_URL`, role `dashboard_ro`). Writes use the new role `site_writer` (Task 1), which may write only `reports` and `site_settings`.
- Neon Build plan: 250 CU-hours/month. API responses (except search and admin) carry `Cache-Control: public, max-age=600` and use the Workers Cache API.
- Light and dark mode (follow the device, manual toggle). WCAG AA contrast in both. `prefers-reduced-motion` disables all animation.
- Shop-supplied text is never rendered as HTML. No `dangerouslySetInnerHTML` anywhere; headline highlights use the `*word*` markup parsed into React elements.
- Security headers carried over from `dashboard/src/worker.ts`: CSP with per-request nonce, `x-frame-options: DENY`, `nosniff`, `referrer-policy: no-referrer`, generic `{ error: 'internal error' }` on 500.
- Wording on verdicts states facts ("€709 on 20 Oct, €799 on 22 Oct"), never adjectives such as "scam".
- Default thresholds (all editable in admin, stored in `site_settings`): `minHistoryDays: 14`, `baselineDays: 30`, `raiseWindowDays: 14`, `raisePct: 3`, `goodDropPct: 5`, `cheaperPct: 2`, `minJudgedForRating: 20`.
- Simple/Advanced mode and theme are remembered in `localStorage` (wrapped in try/catch) with defaults Simple and system theme.

## Review Focus

- Products with null or zero prices, or out of stock with hidden price: verdict `insufficient`, UI says "Price not shown by the shop", never crashes or shows €0.00 as a deal (Task 2, Task 11).
- Search input that is 1 character, only punctuation, contains `%`/`_`/quotes, or is over 120 characters: returns an empty list or trimmed results, never a 500 (Task 8).
- A shop with fewer than `minJudgedForRating` judged products: RATING shows "Not rated yet" with no letter lit, not an F (Task 5, Task 9).
- Headline time slot across the 26 Oct DST change and at slot boundaries (05:59 vs 06:00 Malta time): slot is computed in `Europe/Malta`, not UTC or the device zone (Task 9).
- Repeated report submissions from one client: the 6th within an hour returns 429; messages over 1000 characters are rejected with 400 (Task 15).

---

### Task 1: Migration 003, settings defaults and the write role

**Files:**
- Create: `db/migrations/003_site.sql`
- Create: `scripts/create-site-writer.ts`
- Create: `src/site/settings.ts`
- Test: `test/site/settings.test.ts`

**Interfaces:**
- Produces tables:
  - `site_settings(key text primary key, value jsonb not null, updated_at timestamptz default now())`
  - `site_products(id bigserial pk, shop_id int, group_key text, title text, brand text, url text, image_url text, category text, variant_count int, rep_product_id bigint, gtin text, mpn text, price_cents int, was_price_cents int, in_stock bool, bf_status text, verdict text check in ('good','avoid','none','insufficient'), reason text, facts jsonb, canonical_id bigint, match_method text, match_confirmed bool default false, updated_at timestamptz, unique(shop_id, group_key))` with indexes on `(verdict, category)`, `canonical_id`, `gin(title gin_trgm_ops)`.
  - `shop_ratings(shop_id int pk, grade text check in ('A','B','C','D','E','F') null, judged int, good int, avoid int, was_raised int, sentence text, computed_at timestamptz)`
  - `reports(id bigserial pk, target_type text check in ('product','shop','match'), target_id bigint, reason text, message text, email text, ip_hash text, status text default 'open' check in ('open','fixed','kept','hidden'), created_at timestamptz default now(), resolved_at timestamptz, admin_note text)`
  - `shops.site_hidden boolean not null default false`
- Produces `type SiteSettings = { public: boolean; thresholds: Thresholds; phrases: Record<PhraseSlot, string[]>; categoryOverrides: Record<string, string> }` (shop category text, lowercased, to site category slug), `type PhraseSlot = 'morning'|'afternoon'|'evening'|'late'|'bfweek'`, `type Thresholds` with the Global Constraints keys, `DEFAULT_SETTINGS: SiteSettings`, `loadSettings(sql): Promise<SiteSettings>` (missing keys fall back to defaults) in `src/site/settings.ts`.
- Produces role `site_writer` with `select` on all tables and `insert, update` on `reports` and `site_settings` only; its URL is written to `.env` as `SITE_WRITER_DATABASE_URL`.

- [ ] **Step 1:** Write `test/site/settings.test.ts`: `loadSettings` with an empty table returns `DEFAULT_SETTINGS`; with `{ thresholds: { raisePct: 4 } }` stored returns `raisePct 4` and every other threshold at its default; `DEFAULT_SETTINGS.phrases` has at least 3 lines in each of the 5 slots (use the draft lines from the approved mockup: e.g. "Coffee first, *receipts* second.", "2am shopping is how they get you. *Check first.*").
- [ ] **Step 2:** Run `pnpm test test/site/settings.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3:** Write `003_site.sql` (tables above; insert one `site_settings` row per top-level key from defaults is done by code, not SQL) and `src/site/settings.ts`. `scripts/create-site-writer.ts` follows the pattern of the earlier `dashboard_ro` script: random password, create or alter role, grants, append URL to `.env`.
- [ ] **Step 4:** Run `pnpm test test/site/settings.test.ts` (PASS), then `pnpm migrate` against the dev PGlite (`pnpm dev-db`) and Neon, then `pnpm exec tsx scripts/create-site-writer.ts`; verify `site_writer` cannot `update shops` (permission denied) but can `insert into reports`.
- [ ] **Step 5:** Commit `feat(site): migration 003, settings defaults, site_writer role`.

### Task 2: Verdict engine

**Files:**
- Create: `src/site/verdict.ts`
- Test: `test/site/verdict.test.ts`

**Interfaces:**
- Consumes: `Thresholds` (Task 1).
- Produces: `type Obs = { at: Date; price: number | null; was: number | null; inStock: boolean | null; bf: boolean | null }`; `type Verdict = { label: 'good'|'avoid'|'none'|'insufficient'; reason: string; facts: VerdictFacts }`; `type VerdictFacts = { low30: number | null; usual: number | null; claimedPct: number | null; realPct: number | null; raisedFrom?: { price: number; at: string }; raisedTo?: { price: number; at: string }; wasRaisedFrom?: number; historyDays: number; priceChanges: number; wasChanges: number; daysWorthBuying: number }`; `computeVerdict(obs: Obs[], t: Thresholds, now: Date): Verdict` (obs in any order; one product variant).
- Rule (spec 9a): judged only if the latest obs has `bf === true` or `was > price`. Baseline window = up to `baselineDays` of history before the latest price-or-was change. `avoid` if price or was rose by more than `raisePct`% within the last `raiseWindowDays` while judged; `good` if latest price is at least `goodDropPct`% below the baseline low and was not raised in the window; else `none`. History under `minHistoryDays` or latest price null/0: `insufficient`. `reason` is one factual sentence in the format of the examples below.

- [ ] **Step 1:** Write tests with real dates:
  - Lenovo: 20 Oct €709 was €739 bf false; 21 Oct €709 was €739 bf true; 22 Oct €799 was €889 bf true; plus 14 earlier days at €709 to satisfy history. Expect `label 'avoid'`, `facts.raisedFrom = { price: 70900, at: '2026-10-21' }`, `facts.raisedTo.price 79900`, `reason` equals `"Price went from €709.00 on 21 Oct to €799.00 on 22 Oct while marked Black Friday."`
  - Steady 30 days at €139.99, then €129.99 with bf true and was €139.99: `good`, `realPct` about -7.1, reason starts `"€10.00 below its lowest price"`.
  - Only 5 days of history: `insufficient`.
  - Latest price null (out of stock, hidden): `insufficient`.
  - Was price raised from €299 to €399 eight days ago, price unchanged: `avoid`, `wasRaisedFrom 29900`.
  - Not marked and no was price: `none`.
  - `daysWorthBuying` counts days whose price was at or below the 30-day low.
- [ ] **Step 2:** Run `pnpm test test/site/verdict.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `computeVerdict`. Prices are integer cents; format euros with two decimals and "€"; dates as "22 Oct" in `Europe/Malta`.
- [ ] **Step 4:** Run the test. Expected: PASS.
- [ ] **Step 5:** Commit `feat(site): verdict engine`.

### Task 3: Site categories

**Files:**
- Create: `src/site/categories.ts`
- Test: `test/site/categories.test.ts`

**Interfaces:**
- Produces: `SITE_CATEGORIES` (ordered list: `laptops, phones, tv-audio, gaming, appliances, toys, baby, fashion, beauty-health, home-kitchen, sports, drinks, other`, each with a display name such as "Phones & tablets"); `categorize(input: { categoryPath: string | null; tags: string[]; title: string | null; shopCategory: string | null }, overrides: Record<string, string> = {}): string` returning a slug (an override matching any segment of `categoryPath`, lowercased, wins over the rules); rules are an ordered array of `{ slug, pattern: RegExp, on: ('category'|'tags'|'title')[] }` exported as `CATEGORY_RULES` so admin can show them later.

- [ ] **Step 1:** Tests: "Laptops > Gaming Laptops" gives `laptops`; title "Apple iPhone 17 256GB" with path "Smart Phones" gives `phones`; "LEGO Technic" in a toys shop gives `toys`; "Corona - Case of 24" in shop category `drinks` gives `drinks`; "Black Friday Deals" alone gives the shop category fallback; unknown gives `other`; with overrides `{ 'small appliances': 'appliances' }` the path "Home | Small Appliances" gives `appliances`. Category paths are checked before titles.
- [ ] **Step 2:** Run, expect FAIL. **Step 3:** Implement. **Step 4:** Run, expect PASS.
- [ ] **Step 5:** Commit `feat(site): category rules`.

### Task 4: Product matching

**Files:**
- Create: `src/site/matching.ts`
- Test: `test/site/matching.test.ts`

**Interfaces:**
- Produces: `titleTokens(title: string): string[]`, `sameTitle(a: string[], b: string[]): boolean` (port the dashboard's rule from `dashboard/src/page.ts`: colour and filler words ignored, numbers and model words `pro max plus mini ultra air lite se fe neo slim xl xs` must agree, token Jaccard at least 0.5); `assignMatches(items: MatchInput[]): Map<number, { key: string; method: 'gtin'|'mpn'|'title' }>` where `MatchInput = { id: number; shopId: number; gtin: string | null; mpn: string | null; title: string }`. GTIN groups first, then MPN (normalised to lowercase alphanumerics, at least 5 chars), then title. Items from the same shop never match each other.

- [ ] **Step 1:** Tests: "Apple iPhone 17 256GB – White" matches "APPLE iPhone 17 256GB-Storage 8GB Smartphone, Black" (`title`); "iPhone 17 Pro 256GB" does not match "iPhone 17 256GB"; same GTIN across shops gives method `gtin`; MPN "RZ03-05930100" matches "rz0305930100"; two items from one shop with identical titles are not grouped together.
- [ ] **Step 2:** Run, expect FAIL. **Step 3:** Implement. **Step 4:** Run, expect PASS.
- [ ] **Step 5:** Commit `feat(site): product matching`.

### Task 5: Shop rating

**Files:**
- Create: `src/site/rating.ts`
- Test: `test/site/rating.test.ts`

**Interfaces:**
- Produces: `computeRating(c: { judged: number; good: number; avoid: number; wasRaised: number }, t: Thresholds): { grade: 'A'|'B'|'C'|'D'|'E'|'F' | null; sentence: string }`. Score = avoid share plus `wasRaised / judged * 0.5`; grade bands: under 5% A, 10% B, 20% C, 30% D, 45% E, else F. Below `minJudgedForRating` judged: `grade null`, sentence "Not rated yet: not enough Black Friday deals checked."
- Sentences (exact copy): A "Honest pricing. Its deals are real discounts.", B "Mostly honest. A few deals need a closer look.", C "Mixed. Check each deal before you buy.", D "Be careful here. Some Black Friday prices were raised before the sale.", E "Many deals here were raised before the sale.", F "Avoid its deals. Most were raised before the sale."

- [ ] **Step 1:** Tests with `judged 100, wasRaised 0`: `avoid 4` gives A, `avoid 29` gives D, `avoid 30` gives E (bands are "under"). `judged 19` gives `grade null`. `judged 100, avoid 15, wasRaised 20` gives D (score 0.25).
- [ ] **Step 2:** Run, expect FAIL. **Step 3:** Implement. **Step 4:** Run, expect PASS.
- [ ] **Step 5:** Commit `feat(site): shop rating`.

### Task 6: Nightly `site-build` job

**Files:**
- Create: `src/site/build.ts`, `src/cli/site-build.ts`
- Modify: `package.json` (script `site-build`), `scripts/run-local.ps1` (run after `pnpm scrape --runner local`, then `gh workflow run site-build`), create `.github/workflows/site-build.yml` (dispatch plus backup cron `55 4 * * *`, uses `DATABASE_URL`)
- Test: `test/site/build.test.ts` (against `pnpm dev-db` PGlite, skipped when `DATABASE_URL` is not the dev DB)

**Interfaces:**
- Consumes: Tasks 1 to 5.
- Produces: `buildSiteProducts(sql, settings, now): Promise<{ products: number; judged: number }>` and `buildShopRatings(sql, settings, now): Promise<number>`; CLI `pnpm site-build [--shop slug]`.
- Group key: `coalesce(parent_external_id, external_id)`. Representative variant: cheapest in-stock variant, else cheapest. Group verdict: worst of in-stock variants (`avoid` over `good` over `none` over `insufficient`). Only products seen in the last 3 days and shops not `site_hidden`. Upsert by `(shop_id, group_key)`; delete groups not seen in 7 days. Canonical ids via `assignMatches`, written to `canonical_products` and `site_products.canonical_id`; `match_confirmed` is preserved across runs. Also writes the representative's row into `verdicts`.

- [ ] **Step 1:** Integration test on PGlite: seed one shop with the Lenovo history (two variants: 16GB and 8GB, the 8GB unchanged) and a second shop with the same GTIN at €699; after `buildSiteProducts`, the Lenovo group has `verdict 'avoid'`, `variant_count 2`, and shares `canonical_id` with the other shop's row, `match_method 'gtin'`.
- [ ] **Step 2:** Run, expect FAIL. **Step 3:** Implement, processing one shop at a time in batches of 2000 groups.
- [ ] **Step 4:** Run the test (PASS), then `pnpm site-build` against Neon; expect it under 10 minutes and print counts per verdict.
- [ ] **Step 5:** Commit `feat(site): nightly site-build job`.

### Task 7: Web app scaffold, Worker, private mode, design tokens

**Files:**
- Create: `vite.config.ts` at the repo root with `root: 'web'` (one repo, no workspaces: web dependencies go in the root `package.json`).
- Create: `web/index.html`, `web/src/main.tsx`, `web/src/App.tsx`, `web/src/styles.css` (Tailwind + tokens), `web/components.json` (shadcn, alias `@/components/ui`), `web/worker/index.ts`, `web/worker/auth.ts`, `web/worker/security.ts`, `web/wrangler.toml` (assets dir `dist/web`, SPA fallback, name `bf-guide`)
- Test: `test/web/auth.test.ts`, `test/web/security.test.ts`

**Interfaces:**
- Produces: `checkAccess(req: Request, env: Env, settings: { public: boolean }): Promise<Response | null>` (null means allowed; private mode uses Basic auth with `SITE_PASSWORD`, SHA-256 digest compare, 750 ms delay on failure; `/admin` and `/api/admin/*` always require `ADMIN_PASSWORD`); `withSecurityHeaders(res: Response, nonce?: string): Response`; Worker `Env = { DATABASE_URL: string; WRITER_DATABASE_URL: string; SITE_PASSWORD: string; ADMIN_PASSWORD: string; SITE_ORIGIN: string; IP_SALT: string }`.
- Design tokens in `styles.css` as CSS variables for light and dark (values from the approved mockups: light `--bg #f3f2ee`, dark `--bg #0e1015`, good `#13804f`/`#3ecf8e`, bad `#c2321f`/`#ff6b5e`, accent `#1475e6`/`#4da5fc`, gold tag `#f4e6b8`/`#efd98f`, red tag `#f6d2cb`/`#ef9d92`), dotted desk background `radial-gradient(var(--tex) 1.1px, transparent 1.4px) 18px 18px`, glass card class.
- Scripts: `web:dev` (Vite with `/api` proxied to `wrangler dev`), `web:build`, `web:deploy`.

- [ ] **Step 1:** Tests: private mode without credentials returns 401 with `www-authenticate`; correct password returns null; public mode returns null without credentials; `/api/admin/x` with the site password (not admin) returns 401; security headers include a CSP containing `nonce-`.
- [ ] **Step 2:** Run, expect FAIL. **Step 3:** Scaffold with the shadcn CLI (`button input dialog sheet select tabs switch toggle-group tooltip`), implement auth and headers (reuse `dashboard/src/worker.ts` logic).
- [ ] **Step 4:** Tests PASS; `pnpm web:build` succeeds; `pnpm web:dev` shows an empty themed page with the dotted background in both themes.
- [ ] **Step 5:** Commit `feat(web): scaffold, worker, private mode, tokens`.

### Task 8: Read API

**Files:**
- Create: `web/worker/api.ts` (router), `web/worker/data.ts` (all SQL), `web/worker/cache.ts`
- Test: `test/web/api.test.ts` (handlers with a fake `Data` implementation), `scripts/web-smoke.ts` (runs every query in `data.ts` against Neon once)

**Interfaces:**
- Consumes: tables from Tasks 1 and 6.
- Produces `interface Data` in `data.ts` and these routes (JSON):
  - `GET /api/home` → `{ phrases: Record<PhraseSlot,string[]>, good: Card[], avoid: Card[] }` (6 each)
  - `GET /api/search?q=&shop=` → `{ results: GroupResult[] }` (groups by `canonical_id`, cheapest first, max 40 groups; `q` trimmed, under 2 chars gives empty, cut to 120 chars, `%`/`_` escaped)
  - `GET /api/deals?type=good|avoid&category=&shop=&page=` → `{ items: Card[], total: number }` (24 per page)
  - `GET /api/shops` → `{ shops: ShopSummary[] }`; `GET /api/shops/:slug` → `{ shop, rating, avoid: Card[], good: Card[], rises: Change[], drops: Change[], stats }`
  - `GET /api/products/:id` → `{ product, variants, history: Obs[] (60 days, all variants), verdict, others: OtherShop[], cheaper: OtherShop | null }` where `cheaper` only uses `match_method in ('gtin','mpn') or match_confirmed`, and `others` marks title matches `possible: true`
  - `GET /api/categories` → `{ categories: { slug, name, count }[] }`
- `Card = { id, title, shop, shopSlug, priceCents, wasCents, verdict, reason, bf, category }`.

- [ ] **Step 1:** Tests with a fake `Data`: search `q='a'` returns `[]` without calling data; `q='%%%'` calls data with an escaped pattern; deals `type=other` returns 400; product 404 for unknown id; `cheaper` is null when the only cheaper match is `title`-only; responses carry `cache-control: public, max-age=600` except search.
- [ ] **Step 2:** Run, expect FAIL. **Step 3:** Implement. Search uses `word_similarity` like the dashboard, on `site_products`.
- [ ] **Step 4:** Tests PASS; `pnpm exec tsx scripts/web-smoke.ts` returns rows for every query in under 1.5 s each.
- [ ] **Step 5:** Commit `feat(web): read API`.

### Task 9: Design-system components

**Files:**
- Create in `web/src/components/site/`: `Background.tsx`, `GlassCard.tsx`, `PriceTag.tsx`, `RatingScale.tsx`, `Headline.tsx`, `ShopBadge.tsx` (logo circle with initials fallback), `ModeProvider.tsx` (Simple/Advanced + theme context)
- Create: `web/src/lib/format.ts`, `web/src/lib/time.ts`
- Test: `test/web/components.test.tsx` (Vitest + @testing-library/react + jsdom)

**Interfaces:**
- `PriceTag({ kind: 'good'|'avoid', from?: number, to?: number, label?: string, size?: 'sm'|'md' })`: the approved hanging tag (SVG tag shape on a string; good is gold, swings gently, 3 twinkling sparkles; avoid is red, hangs at -9deg, shows `from` crossed out above `to` and the word "RAISED" unless `label` is given).
- `RatingScale({ grade: 'A'..'F' | null, sentence: string })`: the word RATING, a ruler with ticks and a green-to-red band, letters sized by distance from the grade using `[54, 30, 24, 19, 15, 12]` px, the grade with a pointer; `grade null` shows all letters at 15 px and the text "Not rated yet".
- `Headline({ phrases, now })`: picks the slot with `slotFor(now: Date): PhraseSlot` in `time.ts` using `Europe/Malta` (late 00:00 to 05:59, morning 06:00 to 11:59, afternoon 12:00 to 17:59, evening 18:00 to 23:59; `bfweek` when Malta date is within the 7 days before 27 Nov 2026), a random line per visit, `*word*` rendered as `<em>` with sparkle; flip-in animation.
- `useMode(): { mode: 'simple'|'advanced'; setMode; theme: 'system'|'light'|'dark'; setTheme }`.
- `formatEuro(cents: number): string` gives "€1,219.00"; `formatDay(iso: string): string` gives "22 Oct".

- [ ] **Step 1:** Tests: RatingScale with `D` renders D at 54px, C and E at 30px, B and F at 24px, A at 19px; with `F`, E is 30px and A is 12px; `null` renders "Not rated yet". `slotFor` at 2026-10-25T03:59:00Z (Malta 05:59 CEST) is `late`, at 2026-10-26T05:00:00Z (Malta 06:00 CET) is `morning`, at 2026-11-24T12:00:00Z is `bfweek`. Headline with `"Is that deal *real*?"` renders an `em` containing "real" and no raw asterisks. PriceTag avoid with from 70900 to 79900 shows "€709.00" and "€799.00".
- [ ] **Step 2:** Run, expect FAIL. **Step 3:** Implement (animations in CSS, disabled under `prefers-reduced-motion`). **Step 4:** Run, expect PASS.
- [ ] **Step 5:** Commit `feat(web): design-system components`.

### Task 10: Navigation and layout

**Files:**
- Create: `web/src/components/site/TopNav.tsx`, `BottomNav.tsx`, `MoreSheet.tsx`, `Layout.tsx`; Modify: `web/src/App.tsx` (routes `/`, `/search`, `/deals`, `/shops`, `/shops/:slug`, `/p/:id`, `/how-we-check`, `/admin/*`)
- Test: `test/web/nav.test.tsx`

**Interfaces:** `Layout` renders TopNav at 768px and wider, BottomNav (floating glass bar: Search, Deals, Shops, More) below. `MoreSheet` contains: How we check, Advanced mode switch, theme switch (later plans add hall of shame, price watches, basket check).

- [ ] **Step 1:** Tests: at 375px width BottomNav is present and TopNav absent; tapping More opens the sheet; toggling Advanced in the sheet updates `useMode`; mode survives a remount (localStorage); localStorage throwing does not crash.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(web): navigation`.

### Task 11: Home and search pages

**Files:** Create `web/src/pages/Home.tsx`, `web/src/pages/Search.tsx`, `web/src/components/site/SearchBox.tsx`, `DealCard.tsx`, `DealList.tsx`; Test: `test/web/home.test.tsx`

**Interfaces:** Home: `Headline` + `SearchBox` (live results under the box after 250 ms debounce, Enter goes to `/search?q=`) + Good/Avoid previews (desktop: two rows of 3 cards; phone: one list with a Good/Avoid switch). `DealCard` shows tag, title, shop, price, was; Advanced adds the reason line; null price shows "Price not shown by the shop". Search page groups results by product across shops, cheapest first, with a "cheaper elsewhere" chip.

- [ ] **Step 1:** Tests with a mocked API: home renders 6 good and 6 avoid cards; typing "ip" waits for the debounce then shows results; a card with `priceCents null` shows "Price not shown by the shop"; Simple mode hides `reason`, Advanced shows it.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS, and check by eye in `pnpm web:dev` on phone and desktop widths in both themes.
- [ ] **Step 5:** Commit `feat(web): home and search`.

### Task 12: Deals page

**Files:** Create `web/src/pages/Deals.tsx`; Test: `test/web/deals.test.tsx`

**Interfaces:** Good/Avoid switch (URL param `type`), category select from `/api/categories` (Simple), plus shop and price-range filters and counts (Advanced); paging with "Load more". State lives in the URL so links can be shared.

- [ ] **Step 1:** Tests: switching to Avoid requests `type=avoid`; choosing "Laptops" adds `category=laptops`; Advanced shows counts and shop filter, Simple does not.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `feat(web): deals page`.

### Task 13: Shops list and shop page

**Files:** Create `web/src/pages/Shops.tsx`, `web/src/pages/Shop.tsx`; Test: `test/web/shop.test.tsx`

**Interfaces:** Shops list: badge, name, RATING letter (small), product count. Shop page: ShopBadge + name, `RatingScale`, search inside this shop (`/api/search?shop=`), Simple: "Deals to avoid here" and "Good deals here" (up to 5 each); Advanced adds the four stats (real-deal %, raised before sale, was-price raised, marked Black Friday) and top rises / real drops tables.

- [ ] **Step 1:** Tests: shop with rating `null` shows "Not rated yet"; search box on a shop page calls the API with `shop=<slug>`; Advanced shows the stats block.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `feat(web): shop pages`.

### Task 14: Product page

**Files:** Create `web/src/pages/Product.tsx`, `web/src/components/site/PriceChart.tsx`, `DayTable.tsx`, `CheaperBox.tsx`; Test: `test/web/product.test.tsx`

**Interfaces:** Simple: PriceTag + `verdict.reason` as one sentence, `CheaperBox` ("Cheaper at <shop>, €X", only when `cheaper` is not null), three numbers (lowest 30 days, usual price, real change %), other shops list (title matches labelled "possibly the same product" and only in Advanced). Advanced: `PriceChart` (Recharts; price line and dashed was line; 7 / 30 days switch; background bands for days worth buying vs avoid), `DayTable` (day, price, was, change € and %, marked BF, worth buying), numbers panel from `facts`, comparison table, variants list. Every page shows a "Something wrong?" button (Task 15).

- [ ] **Step 1:** Tests with the Lenovo fixture: Simple shows "€709.00" crossed out on the tag and the reason sentence; CheaperBox shows "Cheaper at Scan" when `cheaper` is set and is absent when null; Advanced DayTable row for 22 Oct shows "+€90.00" and "+12.7%"; switching to 7 days keeps only the last 7 observations in the chart data.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS, then check the real Lenovo page in `pnpm web:dev`.
- [ ] **Step 5:** Commit `feat(web): product page`.

### Task 15: Community flags

**Files:** Create `web/src/components/site/ReportButton.tsx`, `web/worker/reports.ts`; Modify `web/worker/api.ts`; Test: `test/web/reports.test.ts`

**Interfaces:** `POST /api/reports` body `{ targetType: 'product'|'shop'|'match', targetId: number, reason: 'wrong-price'|'wrong-match'|'not-black-friday'|'other', message?: string, email?: string }` → 201 `{ ok: true }`. Validation: `message` up to 1000 chars, `email` must look like an email if present, unknown reason 400. Rate limit: 5 per hour per `sha256(IP_SALT + cf-connecting-ip)` counted in `reports`; 6th gives 429. Writes with `WRITER_DATABASE_URL`. Button sits on product cards' detail, product pages and shop rating; dialog with reason choices, text, optional email; thank-you state. Turnstile is added when a site key exists (env `TURNSTILE_SECRET` optional: if set, the token is verified).

- [ ] **Step 1:** Tests: valid body inserts and returns 201; 1001-char message gives 400; 6th report in an hour from the same IP gives 429; email "x" gives 400.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `feat(web): community flags`.

### Task 16: Admin

**Files:** Create `web/src/pages/admin/*.tsx` (Settings, Phrases, Thresholds, Reports, Shops, Matches), `web/worker/admin.ts`; Test: `test/web/admin.test.ts`

**Interfaces:** `GET/PUT /api/admin/settings` (whole `SiteSettings`, validated with zod: thresholds numeric in sane ranges, each phrase 3 to 120 chars, `*` pairs balanced); `GET /api/admin/reports?status=open`, `PATCH /api/admin/reports/:id` `{ status, adminNote }`; `PATCH /api/admin/shops/:slug` `{ hidden: boolean }`; `GET /api/admin/matches?pending=1` (title matches), `PATCH /api/admin/matches/:siteProductId` `{ confirmed: boolean }`. All behind `ADMIN_PASSWORD` (Task 7). The Settings page holds the **public switch** with a confirm dialog and a Categories section editing `categoryOverrides` (shows `CATEGORY_RULES` read-only, and the 50 most common unmapped shop categories from `site_products` where `category = 'other'`; overrides apply at the next `site-build`). Admin writes use `WRITER_DATABASE_URL`; grant `site_writer` `update(site_hidden)` on `shops` and `update(match_confirmed)` on `site_products` in this task's migration `db/migrations/004_admin_grants.sql`.

- [ ] **Step 1:** Tests: settings PUT with `raisePct: -1` gives 400; a phrase with an unbalanced `*` gives 400; without admin auth every admin route gives 401; PATCH report sets `resolved_at`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS, then edit a phrase in admin and see it on the home page after cache expiry.
- [ ] **Step 5:** Commit `feat(web): admin`.

### Task 17: How we check, deploy, replace the dashboard

**Files:** Create `web/src/pages/HowWeCheck.tsx`; Modify `README.md` (web section: dev, build, deploy, secrets, admin, public switch); Modify `scripts/run-local.ps1` only if Task 6 did not already chain `site-build`.

**Interfaces:** How we check explains in plain words: what we record nightly and since when (20 Oct 2026), the EU 30-day lowest price rule, what makes Good Deal / Deal to Avoid (reading the live thresholds), how ratings are computed and that they change daily, how matching works, and how to report a mistake.

- [ ] **Step 1:** Set Worker secrets with `wrangler secret put` from `.env` (`DATABASE_URL`=`DASHBOARD_DATABASE_URL`, `WRITER_DATABASE_URL`, `SITE_PASSWORD`=`DASHBOARD_PASSWORD`, `ADMIN_PASSWORD` new random value written to `.env`, `IP_SALT` random, `SITE_ORIGIN`).
- [ ] **Step 2:** `pnpm web:build && pnpm web:deploy`; verify on the live URL: 401 without password, home loads with the real Lenovo in Deals to Avoid, admin requires the admin password, Lighthouse mobile performance at least 85 on Home.
- [ ] **Step 3:** Remove the old `dashboard/` Worker only after the owner confirms the new site works (`wrangler delete mtp-dashboard` needs the owner's yes: it deletes a deployment).
- [ ] **Step 4:** Commit `feat(web): how we check page, deploy docs`.
