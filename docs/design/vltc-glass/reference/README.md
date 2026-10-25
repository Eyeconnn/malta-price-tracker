# VLTC Glass design reference

This is the approved prototype for the public site redesign, exported from the design canvas. It is reference material only. Nothing here is imported by the app.

## Files

| File | What it is |
| --- | --- |
| `bfg.css` | All tokens (light, dark), page background, glass cards, controls, header, bottom bar, deal card, collapses, chart styles, transitions. Font paths point at `fonts/`. |
| `tokens.json` | The VLTC Glass design-system tokens (`vg-*` names, royal blue `#1f4fb8`). |
| `grain.svg` | Film-grain noise tile for the page background. |
| `product-icons.svg` | 420×420 tile of product line icons, used as a CSS mask for the background texture. |
| `fonts/` | DM Sans and Oswald variable fonts. |
| `Header.dc.html` | Desktop top bar, phone bottom bar, More sheet, theme transition (`setTheme`), sliding segmented pill (`installSegInd`), page transitions (`pageEnter`). |
| `Main.dc.html` | Home: full-screen search hero, scroll cue, auto-rotating deal rows, phone list. |
| `DealCard.dc.html` | Product reveal deal card. |
| `Product.dc.html` | Product page, Simple and Advanced. |
| `ChartLine.dc.html` | Prototype of the line chart. The real component is `web/src/components/ui/chart-line.tsx`. |
| `Deals.dc.html`, `Shops.dc.html`, `Shop.dc.html`, `Brands.dc.html` | The other pages (Brands has no route yet). |
| `Rating.dc.html`, `Tag.dc.html` | Rating ruler and hanging price tag. |

## Reading a `.dc.html` file

- Markup sits inside `<x-dc>`. `{{name}}` is a value from the component's `renderVals()`.
- `<sc-for list="{{items}}" as="x">` is a loop and `<sc-if value="{{flag}}">` is a conditional. Attributes starting with `hint-` are canvas placeholders; ignore them.
- `<dc-import name="DealCard" card="{{c}}">` renders the sibling file `DealCard.dc.html`. Kebab-case attributes become camelCase props.
- The logic is the `<script type="text/x-dc">` block at the bottom: a class with `state`, `setState` and `renderVals()`, much like a React class component.
- Every page wraps its content in an element with class `bfg`, plus `look-glass` and `data-theme`. Ignore the `look-blend` rules in `bfg.css`; they belong to the other revision.
