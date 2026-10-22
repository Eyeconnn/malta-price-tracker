# Black Friday Guide: public site design

Status: draft for approval, 22 Oct 2026
Owner: Sammy. Working name: **Black Friday Guide** (domain idea: blackfridayguide.mt).

## 1. Intent and why

Shoppers in Malta are sceptical of Black Friday deals: some shops raise a price (or the "was" price)
shortly before the sale so the discount looks bigger than it is. We already record every product's
price every night across 51 Maltese shops (since 20 Oct 2026). This site turns that history into a
plain answer for any product: **is this deal real, or was the price played with?** It also makes the
shops that play these games visible, and helps the buyer find the same product cheaper elsewhere.

Real example that sets the tone: AtoZ Electronics, Lenovo V15 G5: €709 (was €739) on 20 and 21 Oct,
then €799 (was €889) on 22 Oct, the same night it was marked Black Friday.

**The person:** a non-technical shopper, phone in hand, who wants a reasonable deal and suspects
price manipulation. A second, smaller audience is advanced users who want the numbers.

**Timeline:** private while the catalogue and history grow; goes public close to Black Friday
(27 Nov 2026). From the public launch, the site names real shops, so wording must be factual.

## 2. Goals

1. Any product: a clear verdict (Good Deal / Deal to Avoid / not enough history) with the reason in
   one sentence, and a big "cheaper at another shop" indicator when that is true.
2. A recent price rise must be impossible to miss, above all on products marked Black Friday.
3. Every shop gets a RATING A to F based on how honest its deals are.
4. One site for two kinds of user: a **Simple / Advanced** switch across the whole site.
5. All features in section 7, in the order of section 11.
6. Fast on a phone on mobile data.

## 3. Non-goals

- User accounts and passwords for shoppers (price watch uses an email address only).
- Native mobile apps.
- Changes to the scrapers, or new shops (separate work).
- Payments, affiliate links, ads.

## 4. Anti-goals (failure even if it works)

- Accusing a shop in words the data does not support. Verdicts state facts ("€709 on 20 Oct, €799 on
  22 Oct") and link to evidence; no insults, no adjectives like "scam".
- Showing a verdict with confidence when history is too short.
- A Simple view that buries the shopper in numbers.
- Pages that feel generated or generic (the owner explicitly asked for a hand-made feel).
- Exposing database write access to the public site.

## 5. Constraints

- Hosting: **Cloudflare** (owner's call, free tier, account already used). Keep the app standard so a
  later move to Vercel stays easy.
- Data: Neon Postgres, **Build plan** (250 compute-hours/month, 5 GB). The public site reads through
  the existing read-only role `dashboard_ro`. Anything the site writes (community flags, price
  watches, admin settings) goes through a separate role that can write only those new tables.
- Data changes nightly (plus hourly re-checks of some products from 1 Nov), so API responses can be
  cached for minutes to hours; this protects Neon compute-hours.
- Email: Gmail SMTP with an app password (owner's choice, replaces Resend). Gmail allows roughly 500
  messages a day.
- Images: Cloudflare R2 (needs a read/write key; the current key is read-only).
- Do not use any VLTC-related connectors. Do not use the em dash character in any file or message
  (owner's rule from the original brief).
- Accessibility: WCAG AA contrast in both themes, keyboard use, `prefers-reduced-motion` respected.
- Privacy: EU/Malta GDPR for email addresses (double opt-in, one-click unsubscribe, delete on request).

## 6. Decided design (owner's choices unless marked "builder's call")

### 6.1 Look and feel
- **Light and dark mode**, following the device by default, with a manual toggle.
- **Background:** the "dotted desk" texture (fine dot grid) with soft colour glows; frosted-glass
  cards float above it with clear borders and shadows so elements separate.
- **Verdict tags: hanging price tag on a string** (chosen option A):
  - Good Deal: gold tag, gently swinging, with twinkling sparkles; text "REAL DEAL".
  - Deal to Avoid: red tag hanging crooked, the old price crossed out and the new price written in,
    word "RAISED" (or the specific reason, e.g. "WAS RAISED").
  - Must look hand-made, not like a generic badge.
- **Shop logo** in a small circle next to the shop name. Logos are fetched once from each shop's site
  (site icon or published share image), stored in R2. Never used on share images.
- **Shop RATING:** the word RATING above an A to F measuring scale (ruler with ticks and a green-to-red
  band). The shop's letter is the largest, with a pointer under it; the other letters shrink with
  distance from it, never reaching the size of the actual rating. One plain sentence under it.
- Visual references the owner supplied: a dark hero with a glowing ray background and a large rounded
  input (Bolt-style chat), and the glass morphism of the "glass folder cards" component. Use their
  spirit, not their code verbatim.

### 6.2 Navigation
- **Phone:** floating glass bar at the bottom: Search, Deals, Shops, More. "More" opens a sheet with the
  extras (hall of shame, price watches, basket check, how we check, Advanced switch, theme).
- **Desktop:** normal top navigation bar with the same items.
- **Simple / Advanced** switch: site-wide, remembered on the device, default Simple.

### 6.3 Welcome screen
- Big search box (fuzzy, live, across all shops) under a rotating headline.
- **Headline:** a playful line, different on each visit, chosen from sets by Malta time of day
  (morning, afternoon, evening, late night) plus a **Black Friday week** countdown set for the last
  7 days. It arrives with a "price tag flipping over" animation and a sparkle on the highlighted word.
  All lines are editable in the admin settings (6.9).
- Below: **Good Deals** and **Deals to Avoid** previews. Desktop: two rows of cards side by side.
  Phone: one list with a Good / Avoid switch.

### 6.4 Deals page (expected to be the most used page after search)
- Switch: Good Deals / Deals to Avoid. Category filter.
- Simple: plain list (tag, product, shop, price). Advanced: counts, the reason on each row
  (e.g. "was €709 on 20 Oct"), more filters (shop, price range, size of discount).

### 6.5 Shop pages
- Logo, RATING scale, one-sentence summary, **search inside this shop only**.
- Simple: "Deals to avoid here" and "Good deals here" (a few each).
- Advanced: stats (real-deal %, products raised before the sale, was-price raises, products marked
  Black Friday), top price rises and real drops, shop-level charts (7).
- Selecting a product opens the product page with the cross-shop comparison and the "cheaper
  elsewhere" indicator.

### 6.6 Product pages
- **Simple:** tag + verdict in one plain sentence; a big green "Cheaper at <shop>, €X" box when the same
  product is cheaper elsewhere; three numbers: lowest in 30 days, usual price, real change (%).
  Short list of other shops' prices.
- **Advanced:** chart of price paid vs was price with **7 days / 30 days** switch, days shaded
  "worth buying" / "avoid"; price-by-day table (price, was, change in € and %, marked Black Friday,
  worth buying yes/no); numbers panel (EU 30-day low, claimed vs real discount, 60-day high, number of
  price changes and was-price changes, days worth buying); shop-by-shop comparison with each shop's
  verdict.
- "Something wrong?" flag button (6.8). Link to the evidence snapshot when one exists.

### 6.7 Verdict rules (starting point; owner will tune them as data grows)
All thresholds live in admin settings, not in code. Starting values are the **builder's call**,
suggested below.
- **History needed:** at least 14 days of observations, else "Not enough history yet" (neutral).
- **Baseline:** lowest price in the 30 days before the product was marked Black Friday (or before the
  current claimed discount began), and the usual price (median of those 30 days).
- **Good Deal** (owner's rule): steady baseline, and once marked Black Friday the price is below the
  baseline by at least 5%, and the was price has not been raised in the previous 30 days.
- **Deal to Avoid** (owner's rule, builder's thresholds): price or was price raised by more than 3% in
  the 14 days before the Black Friday marker or the claimed discount; or the claimed discount is
  measured from a was price higher than any price actually charged in the previous 30 days.
- **Cheaper elsewhere:** a separate badge (not a verdict on its own) when a matched product at another
  shop is cheaper by at least 2% today.
- Verdicts are recomputed after every nightly scrape and stored (the `verdicts` table exists).
- Products not marked Black Friday and not claiming a discount get no verdict, but still show history.

### 6.8 Community flags (owner's choice)
- Every verdict, rating and match has a "Something wrong?" button, open to anyone including shops.
- Form: what is wrong (choice + free text), optional email for a reply. Anti-spam: Cloudflare
  Turnstile and rate limits.
- Reports go to a private review list in admin. The verdict stays visible while under review
  (builder's call); the owner can correct, hide or keep it, and reply.

### 6.9 Admin area (owner only)
- Separate login (builder's call: Cloudflare Access with the owner's email, which needs no password code).
- Edit headline phrases (per time slot, add/remove/reorder).
- Verdict and rating thresholds.
- Review queue for community flags.
- Shop list: show/hide on the public site, logo override.
- Category mapping (shop categories to site categories) and product match confirmation (7).
- The **public switch**: until the owner turns it on, the whole site requires a login.

### 6.10 Categories
Shops' own categories differ, so map them onto about 12 site categories (Laptops, Phones & tablets,
TVs & audio, Gaming, Appliances, Toys, Baby, Fashion, Beauty & health, Home & kitchen, Sports,
Drinks, Other) using keyword rules on category paths, tags and titles, adjustable in admin.
Rules are the builder's call.

## 7. Feature list (owner: "let's try to hit all features")

Exposing retailers:
1. **Shop RATING** A to F (6.1, 6.5). Builder's call on the formula; suggested: share of the shop's
   judged Black Friday deals that are Deals to Avoid, plus was-price raises; "Not rated yet" below a
   minimum number of judged deals (e.g. 20).
2. **Hall of shame:** newest first, products whose price or was price rose in the 30 days before a
   Black Friday marker. Factual wording only.
3. **Evidence snapshots:** for flagged products, save the shop's product page HTML to R2 (the
   `snapshots` table and `snapshotUrl()` exist) and link "see the shop's page on 22 Oct".
4. **Share card:** an image of a bad deal (tag, before/after price, dates, our site name), no shop
   logo, for Facebook/WhatsApp.

Helping buyers:
5. **Price watch:** "email me when it drops below €X / reaches its 30-day low". Email only,
   double opt-in, unsubscribe link.
6. **"Wait or buy?" hint** on product pages, from the product's recent movement and Black Friday
   timing. Builder's call on the rule; keep it modest and explain it.
7. **Basket check:** paste several product names or shop links, see the cheapest shop per item and
   for the whole basket.
8. **Browser button:** a bookmark ("bookmarklet") that, on a shop's product page, opens our verdict for
   that URL.

Advanced mode extras:
9. **CSV download** of a product's or shop's price history.
10. **Compare up to 4 products** on one chart.
11. **Shop-level charts:** price rises vs drops per day, to spot a shop "preparing" Black Friday.

Also required by the above: **cross-shop product matching** (same product at different shops):
exact barcode (GTIN) and part number (MPN) first, then careful title matching (numbers and model words
such as Pro/Max/Mini must agree), confirmable in admin. Tables `canonical_products` and
`product_matches` exist and are empty.

## 8. Technical shape (builder's calls unless stated)

- New app in this repo (e.g. `web/`): React + TypeScript + Vite + Tailwind + shadcn/ui, lucide icons.
  Components go in `web/src/components/ui` (shadcn convention).
- Served by a Cloudflare Worker with static assets; the same Worker exposes the JSON API. The current
  `dashboard/` Worker is replaced when the new site is ready (owner: "replace once the new one is
  ready").
- Read queries use `dashboard_ro`; writes use a new limited role.
- Nightly jobs (after scraping, on the owner's PC task and GitHub Actions): compute matches, verdicts,
  shop ratings, category mapping, hall of shame, snapshots of flagged pages, price-watch emails.
- Cache API responses at the edge; search stays live.
- Existing security practices carry over: no inline event handlers, CSP with nonces, escaped
  shop-supplied text, generic error messages.

## 9. What exists today

- Nightly scraping of 51 shops into Neon (products, price_observations with review flags and the
  Black Friday marker: status, marker text, first marked date, "already tagged" flag).
- Private dashboard Worker (search, shop view, product history) at mtp-dashboard.sammy1426.workers.dev.
- Tables ready but unused: canonical_products, product_matches, promotions, promotion_products,
  promotion_evidence, verdicts, snapshots.

## 9a. Decisions from the design review

Owner's answers:
- **All shops launch with a rating**, visible from day one. Ratings are dynamic: recomputed every night
  from the latest data, so a shop's letter can move day by day. No per-shop "hidden until reviewed"
  default (the admin show/hide toggle still exists for exceptions).

Builder's calls (the designer's, recorded so they can be checked):
- **One verdict rule set, based on our own history**, not on the marker date. Our data starts 20 Oct and
  many Black Friday markers were already there (`bf_preexisting`), so "30 days before the marker" is
  read as "the up to 30 days of our history before the latest price or was-price change". A product is
  judged when it is marked Black Friday (status `marked`) **or** shows a was price (claims a discount).
  `excluded` and `stale` markers count as not marked, so those products are judged only if they claim
  a discount. Deal to Avoid fires on a rise of price or was price (more than 3%) in the last 14 days
  while marked or claiming a discount; this catches the AtoZ Lenovo even though its tag predates our
  tracking. Fewer than 14 days of history means "Not enough history yet".
- **The product page unit is the parent product.** Variants (sizes, colours) are listed inside it. The
  product's verdict is the worst verdict among its variants that are in stock (a raised price on any
  sold variant is shown); counts in lists and shop ratings are per parent product.
- **Hall of shame = exactly the Deal to Avoid set**, newest first. Shop ratings are computed from the
  same verdicts. One definition, one query, so facts match everywhere.
- **Public "Cheaper at <shop>" only for exact matches** (same GTIN or same MPN) or matches the owner
  confirmed in admin. Looser title matches appear only in Advanced, labelled "possibly the same
  product", never as a headline claim.
- **Emails from the Worker:** queue them in a table; a Cloudflare Worker cron trigger (every 10 minutes,
  reliable, unlike GitHub cron) sends them through Gmail SMTP over a TCP socket (e.g. the
  `worker-mailer` library), batching to stay under Gmail's daily cap. Double opt-in confirmation
  emails therefore arrive within about 10 minutes.
- **Private mode** keeps today's shared password (HTTP Basic) for the whole site until the public
  switch is on; admin is protected separately (Cloudflare Access on the Worker, owner's email only).
  Everything sends `noindex` while private.
- **The site must work on both** a `*.workers.dev` address and a custom domain, configured by
  environment, since the domain is undecided.
- The limited write database role is created by the builder with the owner-level connection already
  in `.env`. The R2 read/write key is still owed by the owner; until it exists, logos, share cards
  and snapshots use a Worker R2 binding where possible and skip otherwise.

## 9b. Open items the owner will decide later

1. **Public launch date and the cut line.** Until decided, build in the order of section 11, which puts
   the suggested launch must-haves first (welcome, search, deals, shops, product pages, verdicts,
   ratings, community flags, admin, "How we check").
2. **Domain** (e.g. blackfridayguide.mt, a yearly fee). Not needed to build.
3. **Site operator identity and contact address** for the privacy page and email footers. Price
   watch emails stay switched off until this is set.
4. **Legal read of the wording before launch** (asked, not yet answered).

## 10. Left to the builder

Exact thresholds (6.7), rating formula, category rules, matching heuristics, wait-or-buy rule,
caching durations, component structure, chart library, animation details within the described
look, and the exact wording of headline phrases (owner edits them later).

## 11. Order of work (builder's call, informed by the deadline)

1. Foundations: new app, design system (themes, texture, glass cards, tags, rating scale), navigation,
   Simple/Advanced switch, private mode.
2. Data: matching, categories, verdicts, ratings (nightly jobs).
3. Pages: welcome, search, deals, shops, products (Simple then Advanced).
4. Community flags + admin (phrases, thresholds, review queue, public switch).
5. Hall of shame, evidence snapshots, share cards, logos.
6. Price watch, compare, CSV, shop-level charts.
7. Basket check, browser button, wait-or-buy.
8. Public launch checklist: "How we check" page, wording review, flags tested, public switch.
