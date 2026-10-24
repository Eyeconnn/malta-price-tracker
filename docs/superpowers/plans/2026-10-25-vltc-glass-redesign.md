# VLTC Glass redesign: plan

Brief: `docs/design/vltc-glass/REDESIGN_PROMPT.md`. Visual source of truth: `docs/design/vltc-glass/reference/`.
Branch `redesign/vltc-glass` (worktree `.worktrees/vltc-glass`). One commit per phase, each after `pnpm typecheck` and `pnpm test` pass.

Nothing in `web/src/lib/api.ts`, `web/worker/`, `src/`, `db/` or the admin pages changes.

## Design file to code map

| Reference | What it becomes |
| --- | --- |
| `bfg.css` tokens (`:root, .bfg` and `[data-theme="dark"]`) | New token values in `web/src/styles.css` `:root` and `@variant dark`, mapped into `@theme inline`. The `look-blend` rules are ignored. |
| `bfg.css` type, glass, controls, chips, collapse, deck, prc, chart, transitions | Small component classes in `styles.css` (`@layer components` / `@utility`), one section comment each. Not copied in wholesale. |
| `fonts/*.woff2` | `web/public/fonts/`, `@font-face` with `font-display: swap`. DM Sans body, Oswald for `t-lbl` labels and big numbers. |
| `grain.svg`, `product-icons.svg` | `web/public/bg/` (not `/img/`, which the Worker serves from R2). |
| `.bfg-bg` | `components/site/Background.tsx`: fixed layer, page gradient, icon mask (`--icon-tint`), grain `::after` (`--bg-grain`). No glows. |
| `.glass`, `.glass-card` + `#bfg-refract` | `components/site/GlassCard.tsx` (`variant="panel" | "card"`), `glass` utility rebuilt, one hidden SVG filter rendered once in `Layout`. |
| `.seg-group` + `installSegInd` | New `components/site/SegmentedControl.tsx` on the shadcn `toggle-group` (radio semantics), pill measured with a ref and `ResizeObserver`, tones `ink` / `good` / `bad`, bar tone `white` for the top bar. Replaces every Simple/Advanced, theme, variant, 7/30 days, Good/Avoid, sort and shop tab group. |
| `.switch` | shadcn `Switch`, restyled (50x30, accent when on). |
| `Header.dc.html` (top bar) | `TopNav.tsx`: 3-column grid, brand left, links centred (96px min, 42px tall, short accent underline), Simple/Advanced segmented + icon theme button right. |
| `Header.dc.html` (phone) | `Layout.tsx` phone header (brand + search icon), `BottomNav.tsx` (smoke glass, 4 equal items), `MoreSheet.tsx` (links, Advanced mode switch, System/Light/Dark segmented). |
| `setTheme` | `ModeProvider.setTheme(theme, origin?)`: sets or removes `data-theme` synchronously inside `document.startViewTransition`, React state via `flushSync`, 650ms circle clip from the pressed button; 0.5s colour cross-fade class without View Transitions; instant under reduced motion. |
| `pageEnter`, `bfg-page-in/out` | `Layout.tsx` + new `lib/usePageTransition.ts`: in-app link clicks add a leaving class (blocks slide down and fade, about 0.14s) then navigate; the new page's blocks drop in from 10px above, staggered, about 0.18s. Header and bottom bar stay still. Skipped under reduced motion. |
| `Main.dc.html` | `pages/Home.tsx`: full-screen hero (Headline, muted line, `LiveSearch`, Try pills from `searchExamples`), scroll cue, desktop deal rows, phone Good/Avoid list, How we check card. |
| deck rotation | New `components/site/DealDeck.tsx`: 3 cards per set, 8s rotation, slide out 0.36s / in 0.5s, pause/play icon button, prev/next, bar page markers, pauses on hover and focus-within, still under reduced motion. Phone uses the same deck with one list. |
| `DealCard.dc.html` | `components/site/DealCard.tsx` rebuilt as the reveal card (badge, product icon, BF chip, shop, name, price, overlay with why, "Shop's claim" / "Our check", two buttons). Hover / focus-within on desktop, middle-band IntersectionObserver and tap toggle on touch. New `lib/productIcon.ts` picks the icon from the title. |
| `Product.dc.html` | `pages/Product.tsx` restructured: header card with variant segmented control and sliding note, Our advice card, chart (collapsed in Simple, open in Advanced), price by day collapse with shop segmented control and numbers panel, Other shops quiet rows (expand in Advanced with details and `ReportButton`), Product details collapse. New `components/site/Collapse.tsx` for the grid-rows open/close. The variant, shown-price and verdict logic stays as it is. |
| `ChartLine.dc.html` | `components/ui/chart-line.tsx` (and `chart-line-utils/chart-kit.tsx`), committed on this branch, extended with: dashed series, one shared "Was prices" legend toggle, a token surface (`var(--…)` colours), a `step` curve for prices, `currency: 'EUR'`. `SellersChart.tsx` (Recharts) is deleted. `motion` is added. |
| `DayTable.tsx` | Restyled to `.table` (Oswald header labels, quiet rows). |
| `Deals.dc.html` | `pages/Deals.tsx`: Good/Avoid segmented, category select; Advanced adds shop and price range plus counts. New cards. |
| `Shops.dc.html` | `pages/Shops.tsx`: grade cards (Simple), table (Advanced), find a shop, Best/Worst sort segmented. |
| `Shop.dc.html` | `pages/Shop.tsx`: header card with search inside the shop (`api.search(q, slug)`) and the rating ruler; Advanced adds KPI tiles and the rises / drops tables; then the two deal sections. |
| `Rating.dc.html` | `components/site/RatingScale.tsx` restyled (Oswald letters, ruler, colour band). |
| `Tag.dc.html` | `components/site/PriceTag.tsx` restyled to the new tag tokens. The new deal card uses a badge instead, so the tag is no longer on cards. |
| (no board) | `Search.tsx`, `HowWeCheck.tsx`, `NotFound.tsx`, `SearchOverlay.tsx`, `SearchBox.tsx`, `ProductResult.tsx`, `ShopBadge.tsx`, `DealList.tsx` (Notice, skeleton), `ReportButton.tsx` restyled with the same tokens and glass. |

## Phases

1. **Foundation and navigation.** Tokens, fonts, background, glass, `SegmentedControl`, switch, select options, `TopNav`, phone header, `BottomNav`, `MoreSheet`, theme transition, page transitions. Contrast test moved to the new palette. Commit.
2. **Home and deal card.** Hero, scroll cue, `DealDeck`, phone list, How we check card, new `DealCard`. Commit.
3. **Product page.** Layout above, `ChartLine` swap (`pnpm add motion`), collapses, mode switch animation. Commit.
4. **Deals, Shops, Shop, Search, How we check, Not found.** Commit.
5. **Final pass.** Spacing (24px desktop / 20px phone), radii (999px pills, 20px cards), control heights, axe check, reduced motion check, screenshots, summary. Commit.

After each phase: `pnpm typecheck`, `pnpm test`, then screenshots of the touched pages at 1440x900 and 390x844, light and dark, Simple and Advanced, into `out/redesign-screens/`, compared by eye with the reference.

## Calls I made (say if you want any changed)

1. **Search overlay stays.** You asked earlier for search to open as an overlay from the nav. The design's "Search" nav link, the phone search icon and the bottom bar Search item all open that overlay, and the Search link is underlined on `/` and `/search`.
2. **Links with no page are left out**: Brands (nav and More sheet), and "Hall of shame" and "Price watches" (shown as "Soon" in the design).
3. **Deal card second button.** A deal card does not carry the shop's product address, so "View on {shop}" cannot open the shop's own page. The second button goes to our page for that shop and is labelled "{shop} rating". "View on {shop}" stays on the product page, where the address is known.
4. **Deal card picture** is the product line icon from the title, as in the design. Cards carry no photo. The product page keeps its real photo.
5. **Product "short description"** is the specs line (`product.specs`), the only description the API has.
6. **Some numbers on the boards are not in the API**, so they are left out:
   - Shops cards: the "N of M judged products were Deals to Avoid" sentence. Products tracked is shown instead.
   - Shops Advanced table: the judged, avoid, raised was, good, real deal and marked Black Friday columns. Only shop, rating and products tracked are shown.
   - The N/A line says "Fewer than {minJudgedForRating} Black Friday deals checked so far." The number comes from `/api/thresholds`.
7. **Shop chart of daily rises and drops is left out.** `/api/shops/:slug` returns only the biggest rises and drops, not counts per day, so a chart from them would be wrong. The tables stay.
8. **Deals "Claimed discount" filter is left out.** `/api/deals` has no such filter, and filtering one page of results in the browser would give wrong counts. Category, shop and price range stay.
9. **Price watching (the heart)** has no API, so it is left out.
10. **Shop rating "Something wrong?"** keeps the existing `ReportButton`; nothing new.
11. **Recharts** is removed from `package.json` if nothing else uses it once `SellersChart.tsx` is gone. This removes a dependency and adds none.
12. **Storage keys stay `mode` and `theme`**, which the first-paint script in `index.html` already reads. "System" still removes `data-theme` so the device decides.

## Needs your OK

- **Playwright for screenshots and the axe check.** It is not installed. I would add `playwright` and `@axe-core/playwright` as dev dependencies and download Chromium (about 150 MB, run once). Without them I can check pages in the app's built-in browser, but the screenshots are not saved to `out/redesign-screens/` and there is no automated axe run.

## Data for local screenshots

`pnpm web:dev` proxies `/api` to `pnpm web:worker`. I will run the Worker against the local dev database if it has enough data. If it does not, I will use the read-only `dashboard_ro` connection from `.env`, which only reads.
