# Redesign prompt: move the public site to the VLTC Glass design

Paste everything below the line into Claude Code, opened at the root of the Black Friday Guide repo.

---

You are redesigning the public website in `web/` (React 19, Vite, Tailwind v4, shadcn/ui, react-router) to match an approved design called **VLTC Glass**. The design was built and reviewed as an HTML prototype. Its source lives in `docs/design/vltc-glass/reference/`. Treat that folder as the visual and behavioural source of truth. Treat the existing code as the source of truth for data, API calls, routing, verdict rules and the admin area.

## Ground rules

1. Do not change the data layer. That means `web/src/lib/api.ts`, `web/worker/`, `src/` (scraper, CLI, verdict and rating logic), `db/` and the admin pages (`web/src/pages/Admin.tsx`, `web/src/pages/admin/`). This is a front-end redesign only. If the design shows something the API does not provide, leave it out and list it in your final summary. Do not fake data.
2. Keep every existing route in `web/src/App.tsx` working. The design's Brands page has no route or API yet. Do not build it now; mention it in the summary.
3. Work on a new branch called `redesign/vltc-glass`. Commit after each phase below with a clear message.
4. Before you write code, read `docs/design/vltc-glass/reference/README.md`, `bfg.css` and every `.dc.html` file. Then write a short plan into `docs/superpowers/plans/` mapping each design file to the components and pages you will change. Show me the plan and wait for my go-ahead.
5. Keep using Tailwind v4 and the shadcn primitives in `web/src/components/ui/`. Port the design's CSS into theme tokens in `web/src/styles.css`, plus Tailwind utilities or small component classes. Do not drop `bfg.css` in wholesale. Where the design needs effects Tailwind cannot express (grain, icon pattern, glass refraction, keyframes, view transitions), put them in `styles.css` under clear section comments.
6. Accessibility is a hard requirement, not polish:
   - Keep `test/web/contrast.test.ts` passing. Update its token values to the new palette, and fix any colour that fails WCAG AA rather than lowering the bar.
   - Every interactive element is a real button or link, keyboard reachable, with visible focus and a 44px minimum touch target on phone.
   - All motion respects `prefers-reduced-motion`.
7. Copy rules:
   - Never use the em dash character in any UI text, comment or doc.
   - No round dot decorations anywhere. That includes the coloured dots next to "Good deals" and "Deals to avoid" in `Home.tsx` today, and dot legends in charts. Use line or bar swatches in chart keys instead.
   - Use honest, calm wording, following `src/site/verdict.ts`.
8. Regular users never get a "Download CSV" button. Remove any from the public pages; admin keeps its own.
9. After each phase, run `pnpm typecheck` and `pnpm test`, and fix what breaks. Update tests that assert old markup, but do not delete tests to get green.
10. Verify visually. Run `pnpm web:dev`, then use Playwright to screenshot every public page:
    - at 1440×900 and at 390×844;
    - in both light and dark theme;
    - in both Simple and Advanced mode where the page differs.

    Look at the screenshots yourself and compare them with the reference before calling a phase done. Save them to `out/redesign-screens/`, which `.gitignore` already covers.

## The design system

All values are in `reference/bfg.css` (the `:root, .bfg` block and the `.bfg[data-theme="dark"]` block) and in `reference/tokens.json`.

- **Theme.** Warm off-white light theme and a warm near-black dark theme. Royal blue `#1f4fb8` is the brand accent. Keep the repo's existing theme mechanism: `ModeProvider`, `data-theme` on `<html>`, and the `@custom-variant dark` in `styles.css`. Map the design tokens onto it.
- **Fonts.** DM Sans for everything, with tabular numbers for prices. Oswald for the large display numbers, as used in the design. Move `reference/fonts/*.woff2` to `web/public/fonts/` and declare them with `@font-face` using `font-display: swap`.
- **Page background.** `.bfg-bg` in the reference has two layers:
  - A fine film grain from `grain.svg`, blended with soft-light. Strength comes from `--bg-grain`, and it is a little stronger in dark mode.
  - A tiled pattern of product line icons from `product-icons.svg`: game pad, shirt, laptop, camera, racket, headphones, football, phone, TV, sneaker, watch, bag, dumbbell, toy brick and keyboard. It is used as a CSS mask, with `--icon-tint` a shade very close to the background, so it reads as texture rather than decoration.

  There are no coloured glows behind content. Move both SVGs into `web/public/` and replace `web/src/components/site/Background.tsx`.
- **Glass cards.** `.glass-card` and `.glass` in the reference:
  - a top-to-bottom translucent gradient;
  - `backdrop-filter: blur()` with saturation;
  - a subtle SVG refraction filter (`#bfg-refract`), applied only under `@supports`;
  - a faint grain sheen on `::after`;
  - a thin light top edge and a soft drop shadow.

  Rebuild `web/src/components/site/GlassCard.tsx` to match. Cards must never get a coloured glow.
- **Segmented controls.** Simple/Advanced, variants, 7/30 days, Good/Avoid tabs, sort, and theme all share one pattern: a single selection pill that slides and resizes to the chosen option with `cubic-bezier(0.22, 1, 0.36, 1)` over about 0.45s, while the text colours cross-fade. In the reference this is done with the `.seg-group::before` pill plus a measuring script in `Header.dc.html` (`installSegInd`). In React, build one reusable `SegmentedControl` on top of the shadcn `toggle-group` or `tabs`. Measure the active item with a ref and `ResizeObserver`, and render the pill as an absolutely positioned element. When "Good deals" is selected the pill is green, for "Avoid" it is red, otherwise it is ink.
- **Switches.** Any on/off setting, such as Advanced mode in the phone More sheet, is the shadcn `Switch`, never a checkbox.
- **Dropdowns.** Native `<select>` options must be readable in dark mode. Give `option` a solid `--surface` background and `--ink` text (see the end of the `.input` rules in `bfg.css`). If you use the shadcn `Select`, style its content panel the same way.

## Layout and navigation (phase 1)

Reference: `Header.dc.html` and the top-bar, bottom-bar and sheet sections of `bfg.css`.

- **Desktop top bar.** A 3-column grid: brand on the left, page links centred, controls on the right.
  - Every control in the bar is exactly 42px tall, and the links share one minimum width (96px) and equal spacing.
  - The active link has a short accent underline.
  - The controls are the Simple/Advanced segmented control and an icon-only theme button.

  Update `TopNav.tsx`.
- **Phone.**
  - A slim top bar with the brand and a search icon.
  - A floating glass bottom bar with Search, Deals, Shops and More. The four items are the same size and evenly spaced.
  - More opens a bottom sheet with links, an Advanced mode switch, and a System/Light/Dark segmented control.

  Update `BottomNav.tsx` and `MoreSheet.tsx`.
- **Theme change animation.** Switching light and dark must never cut. Use the View Transitions API:
  - Inside `document.startViewTransition`, set `data-theme` synchronously, in the same callback. Do not wait for a React state update, because that update lands after the snapshot. That causes a delay followed by a hard cut, which was a real bug in the prototype.
  - Animate `clip-path` on `::view-transition-new(root)` as a circle growing from the pressed button, over 650ms.
  - Where View Transitions are not supported, cross-fade colours for 0.5s.
  - With reduced motion, switch instantly.

  See `setTheme` in `Header.dc.html`.
- **Page transitions.** Navigating between pages uses a quick transition and no loading screen. The header stays still.
  - On leaving, the content blocks (direct children of the page's main wrapper) slide down about 10px and fade, staggered, finishing in about 0.14s.
  - On the new page, the blocks slide down into place one by one from about 10px above, finishing in about 0.18s.
  - The total for each half must be under 0.2s.

  See `pageEnter` in `Header.dc.html` and the `bfg-page-in` / `bfg-page-out` keyframes. In react-router, the cleanest approach is a wrapper in `Layout.tsx` keyed on `location.pathname`, using the View Transitions API with `flushSync` or a short exit state.

## Home (phase 2)

Reference: `Main.dc.html`.

- **First screen.** The first screen is only the search: the headline, one muted line under it, the large glass search box with live results, and "Try" pills.
  - It fills the whole viewport (`min-height: calc(100svh - header)`), so the deals start completely below the fold.
  - Keep the existing `Headline` phrase logic, including the Black Friday countdown slot, the rotating search placeholder (`useTypingPlaceholder`) and `LiveSearch`.
- **Scroll cue.** An animated cue at the bottom of the hero ("Good deals and deals to avoid, scroll to see") with a gently bobbing chevron and a pulsing ring. It smooth-scrolls to the deals.
  - On phone, lift it about 100px plus `env(safe-area-inset-bottom)` so the floating bottom bar never covers it.
  - Re-centre the hero content in the space above it.
- **Desktop deal rows.** Two rows, "Good deals" and "Deals to avoid". Each row:
  - shows exactly 3 cards at a time;
  - every 8 seconds, slides its three cards out and three new ones in (about 0.5s);
  - has an icon-only pause/play button next to the previous/next arrows, plus page markers drawn as short bars, not dots.

  Rotation also pauses while the pointer or keyboard focus is inside the row, and stays still under reduced motion.
- **Clipping.** The deck must not clip the cards' hover scale. The reference uses `overflow-x: clip` with matching padding and negative margin on `.deck`.
- **Phone deals.** A Good/Avoid segmented control above one list, with its own icon pause button.
- **Below the deals.** A short "How we check" glass card.

## Deal card (phase 2)

Reference: `DealCard.dc.html` and the `.prc-*` rules in `bfg.css`. Rebuild `web/src/components/site/DealCard.tsx` as a product reveal card.

- **Media area.**
  - A product icon chosen from the title, using the same icon family as the background.
  - An honest badge, picked from the verdict: "X% off, real deal", "Price raised", "Was price raised" or "Discount not real".
  - A heart button labelled "Watch this price" with a small pop animation, if the API supports watching. Otherwise leave it out and note it.
  - A Black Friday chip when the deal is tagged.
- **Body.** Shop name, product name, and the current price with the was price struck through.
- **Reveal overlay** on activation:
  - a one-line why;
  - two small boxes, "Shop's claim" and "Our check";
  - two buttons, "See price history" (to the product page) and "View on shop".
- **Activation.**
  - Desktop: hover or focus-within.
  - Touch devices (`(hover: none)`): an IntersectionObserver with `rootMargin: '-42% 0px -42% 0px'` opens the card when it reaches the middle of the screen. A tap toggles it, unless the tap lands on a link or button.

## Product page (phase 3)

Reference: `Product.dc.html` and the `.collapse`, `.cl-*` and `.opt-note` rules in `bfg.css`. This is the most important page. Keep it calm. Do not mix red and green messages on one screen.

- **Header card.**
  - Brand, title and a short description.
  - A "Variant" label, indented 15px, above a variant segmented control.
  - When a specific variant is chosen, the note "Shops that do not name this variant are left out." slides down from behind the variant buttons. It slides back up when "All" is chosen. Its line is always reserved, so the card never changes height.
- **Our advice card** (Simple and Advanced):
  - "Buy it at {best shop} for {price}" with the shop logo;
  - one verdict chip;
  - stock;
  - one line of why;
  - a neutral note if the user arrived from a different shop's listing.
- **Price chart.**
  - In Simple mode it is hidden behind a "View price chart" button and expands with a smooth height animation (CSS grid `0fr` to `1fr`).
  - In Advanced mode it is open and is the main element of the page.
  - Use the `ChartLine` component already in the repo at `web/src/components/ui/chart-line.tsx`. Run `pnpm add motion` first if it is not installed.
  - Replace `SellersChart.tsx` (Recharts) with it. Show the best shop first and solid, other shops as quieter lines, and was prices as dashed lines behind a single "Was prices" legend toggle.
  - Add a 7/30 days segmented control.
  - Below the chart, a collapsed "Show price by day" section holds the day-by-day table (`DayTable.tsx`), with a shop segmented control and a numbers panel.
- **Other shops.** Quiet rows with price, stock and verdict text. In Advanced mode each row expands to show details and the report form (`ReportButton.tsx`).
- **Product details.** A collapse, shown in Advanced mode only.
- **Switching modes.** Moving between Simple and Advanced on this page animates. Sections open and close with the grid-rows collapse and fade. Nothing jumps.

## Deals, Shops and Shop pages (phase 4)

References: `Deals.dc.html`, `Shops.dc.html`, `Shop.dc.html` and `Rating.dc.html`.

- **Deals.**
  - A Good/Avoid segmented control and a category filter.
  - Advanced mode adds shop, price range and claimed discount filters, plus result counts.
  - The deals use the new card.
- **Shops.**
  - Grade cards using the existing rating formula and the `RatingScale` ruler restyled as in `Rating.dc.html`.
  - A shop with fewer than 20 judged deals shows "N/A" in a grey badge, with the line "Fewer than 20 Black Friday deals checked so far." It never shows a letter grade.
  - Sorting is by best or worst. Advanced mode adds a table view.
- **Shop.**
  - The rating ruler, and search inside the shop.
  - Advanced mode adds stats and a `ChartLine` of daily price rises and drops (`total="sum"`), plus tables of rises and drops.
  - Then "Deals to avoid here" and "Good deals here".
  - No CSV button.
- **Search and How we check.** Restyle `Search.tsx` and `HowWeCheck.tsx` with the same tokens, glass cards and type scale, even though the prototype has no board for them.
- **NotFound.** Restyle `NotFound.tsx` to match.

## Final pass (phase 5)

- Walk every public page in both themes, both modes, desktop and phone, and fix inconsistencies in:
  - spacing (desktop gap 24px, phone 20px);
  - radii (pills 999px, cards about 20px);
  - control heights.
- Check with Lighthouse or axe through Playwright: no contrast failures, labels on all form fields, and correct `aria-pressed` / `aria-checked` states on toggles.
- Confirm reduced motion stops the deal-row rotation, the scroll cue animation, the page and theme transitions and the pill slide.
- Write a short summary covering:
  - what changed, page by page;
  - anything from the design you could not build because the API lacks it (for example Brands, price watching);
  - the screenshot folder path.

Ask me before adding any new dependency other than `motion`.
