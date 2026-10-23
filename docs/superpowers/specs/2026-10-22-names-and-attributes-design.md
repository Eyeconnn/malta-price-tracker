# Clean product names and product attributes: design

Date: 22 Oct 2026. Status: draft for the owner's approval.

## Why

Search results look untidy. Shops write the same product in different ways ("LENOVO THINKBOOK 16 G6 IRL 16" I5/8GB/512SSD/W11P" next to "Lenovo ThinkBook 16 G6 Laptop"), variants of one product show as near-duplicate rows, and we keep no structured facts about a product (size, colour, material, capacity, dimensions). The owner wants:

1. A cleaner, normalised name for every product group, especially where there are variants.
2. Features and attributes stored for every scraped product, so a later task can build normalised filters (size, dimensions, colour, material and so on).

## Decisions taken

- **Sources: what the shops publish, cleaned by Claude Code on the owner's PC (owner decision, 22 Oct).** We use only data from pages and feeds we already download. Clean names and attributes are produced by a local script that runs Claude Code in scripting mode (`claude -p`) on the owner's Windows PC, using the owner's Claude plan, not a pay-per-use API key. No outside catalogue for now; Open Icecat stays a possible later add-on.
- **Normalise once.** Each product group is normalised once and stored with the time it was done and a fingerprint of the shop's title. It is queued again only if it was never done or the shop's title changed. New products are picked up by a scheduled run.
- **Batches by category (owner decision).** Every batch holds products from one site category only, and each category has a fixed attribute list (keys and units) given to Claude in the instructions, so attributes come out the same across all batches of a category and can drive that category's filters later.
- **Pilot first, with different models.** Small pilot runs (about 500 groups, spread over categories and shops) are made with different models so the owner can compare quality and usage before the full run. The owner starts runs by hand until a schedule is agreed.
- **Shop text is data.** Titles go to Claude as data inside the batch; the instructions say to ignore any text in them addressed to an AI. Claude runs with all tools switched off, so a title cannot make it do anything.
- **No new sites are crawled and no robots or rate-limit rules change.** Almost all attribute data is already in the payloads we download today.
- **Raw facts are stored at scrape time; normalising happens at site-build time.** The scraper keeps what the shop said. The nightly site-build turns it into clean names and normalised attributes. Rules can then improve and be re-run over old data without re-scraping.
- **The shop's own title stays visible** (product page and Advanced views), so a cleaned name never hides what the shop actually wrote.

## What the scraper already has (survey, 22 Oct)

| Adapter | Shops | Attribute data already downloaded | Kept today |
|---|---|---|---|
| Shopify | 27 | `options[].name` + variant `option1-3`, `body_html`, weight | variant title only |
| WooCommerce | 20 | `attributes` (name + terms), variation `attributes`, `description`, `dimensions`, `weight` | brand, flattened variation string |
| Magento (Scan) | 1 | product page attribute table and JSON-LD, read once per product (400 a night budget) | gtin, mpn, brand only |
| Magento GraphQL (Intercomp) | 1 | can add `configurable_options`, custom attributes to the same query | none |
| HTML (Telecom, Eurosport) | 2 | listing tiles only; product pages only on hourly re-checks | none |

Database today: 936 MB of 5 GB, products table 410 MB for 392k rows.

## Part 1: attributes

### Storage

- `products.attrs jsonb` (new column, migration 007): the shop's own name/value pairs as published, for example `{"Size": "M", "Colour": "Navy", "Material": "Cotton"}`. Limits: at most 40 pairs, names up to 60 characters, values up to 200 characters, HTML stripped. Variant rows hold their own option values; the parent's shared attributes are stored once on each row of the group only when they are short (to keep size down, the body text extraction keeps only "Name: value" spec lines, never the full description).
- `site_products.attrs jsonb` (new column): the normalised attributes for the group, built nightly: `{ "colour": ["navy"], "size": ["s","m","l"], "material": ["cotton"], "capacity_l": 5.5, "screen_in": 15.6, "storage_gb": 512, "ram_gb": 16, "width_cm": 30, ... }`.
- Expected growth: about 150 to 300 bytes per product row, roughly 60 to 120 MB in total. The 80% size warning stays in place.

### Capture per adapter (in order of value)

1. **Shopify:** keep `options[].name` with each variant's `option1-3` as name/value pairs; extract "Name: value" spec lines and simple spec tables from `body_html`; keep weight.
2. **WooCommerce:** keep parent `attributes` (name plus all terms) and each variation's `attributes`; keep `dimensions` and `weight`; extract spec lines from `description` the same way.
3. **Magento (Scan):** keep every row of the attribute table that is already parsed and thrown away; add a one-off re-read of existing products in the existing 400 a night budget (flag `meta.attrs_v = 1`), so the backlog fills over the coming nights without raising the request rate.
4. **JSON-LD (Magento pages and HTML re-checks):** keep `color`, `material`, `size`, `model`, `weight`, `width`, `height`, `depth` and `additionalProperty`.
5. **Magento GraphQL:** add `configurable_options` and the store's custom attributes to the existing query if the server accepts it (checked first; if the query gets too large or is refused, skip).
6. **HTML shops:** nothing new for now (would need new per-product requests).

### Normalising (site-build)

- A dictionary maps shop attribute names to standard keys, in English and the Maltese and Italian spellings shops use (Colour, Color, Kulur, Colore -> `colour`; Size, Sizes, Taglia -> `size`; Capacity, Volume -> `capacity`; Memory, RAM -> `ram`; Storage, SSD, HDD -> `storage`; Dimensions, Size (cm) -> `dimensions` and so on).
- Values are cleaned: colour names mapped to a fixed colour list (navy, black, white, ...); sizes to a standard set (XS to XXL, EU and UK shoe sizes, kids' ages); numbers with units parsed and converted (cm, mm, inch; GB, TB; W; L, ml; kg, g).
- Unknown names are kept under `other` in site_products so nothing is lost, and the admin Categories page gains a list of the most common unmapped attribute names, like the existing unmapped categories list.
- The title matching rule in `src/site/matching.ts` uses the structured colour and size where present instead of its word lists.

## Part 2: clean names

### The normaliser script (Claude Code, local)

- `pnpm normalise-names` (TypeScript, in this repo, so it reuses the database code and the title-token code of `src/site/matching.ts`). Options: `--model` (for example haiku, sonnet, opus), `--category <slug>` or all, `--batch-size` (default 50), `--parallel` (default 2), `--max-batches` (the cap per run), `--pilot` (a spread sample across categories and shops), `--dry-run` (no database writes; writes the results file only).
- Each batch: products of one category, with shop title, variant titles, brand, shop category path, GTIN and MPN, and any stored raw attributes. Claude is called with `claude -p --model <m> --output-format json --json-schema <schema>`, tools off, no MCP servers, no hooks or user settings, no session saved, and the category's instructions and attribute list. It returns per product: clean name, variant label, attributes in the category's keys.
- Every answer is checked (Part 2 safety rule, schema, attribute keys and units). Failed items are stored as rejected with the reason and keep the shop title.
- Results go to a new table `product_names` (key: shop_id, group_key) with display name, attributes, model, title fingerprint, status, normalised_at and run id. A `name_runs` table records each run: model, categories, batches, items, accepted, rejected, input and output tokens and the usage figure Claude Code reports.
- Each run writes a report file (before and after names, attributes, rejects, usage per batch and per 100 products) for the owner to judge.
- The rules below (variant parts, shop noise, casing, units, agreement, safety) go into the instructions Claude follows, and the safety rule is also enforced in code.
- After the pilot, a Windows scheduled task runs it nightly for new or changed products with a cap.

Results are copied into a new `site_products.display_name` column at site-build (the existing `title` stays the shop's text). The rules:

1. **Remove variant parts.** Option values that belong to variants (colour, size, storage) are removed from the end or brackets of the title, so the variants of one product share one name; the variant values are shown as chips.
2. **Remove shop noise.** Shop names, "free delivery", "new", "sale", "Black Friday", stock notes, repeated brand, SKU codes in brackets, trailing separators.
3. **Fix casing.** All-capital titles become title case, keeping known brand casing (iPhone, LEGO, ThinkPad, AirPods) and unit spellings (GB, TB, Wi-Fi, 4K, mAh); a brand dictionary built from the brand column across all shops.
4. **Standard units.** 16GB, 512 GB SSD, 15.6", 55 inch -> one spelling each.
5. **Agreement across shops.** When several shops sell the same barcode or model number (trusted matches only), the group's name is the clean name most shops agree on, else the shortest clean name that keeps the brand and every model and number token.
6. **Safety.** A cleaned name is used only if it keeps the brand (when known) and every model and number token of the original; otherwise the original title is shown. Names are never invented.

## Part 3: search by product, one page per product (owner decision, 23 Oct)

The aim of the clean names: search works by general product, not by product per shop. When the same product is sold by several shops, a search result leads to one product page showing the product and every seller's price.

### Update 23 Oct: match by canonical normalised names (owner decision)

Review rounds showed that matching on free-form clean names with word rules both merges different products and misses real matches (shops word the same product differently). The owner chose to match "using normalised product names". So:

- The normaliser also returns a **canonical name** per listing, written in a fixed pattern per category from identity fields (for example phones: brand, model line, model number, storage, network edition; games: title, platform, edition; fragrance: brand, line, concentration, audience, volume; drinks: brand, product, age or vintage, volume, pack). Every distinguishing fact (condition, audience, pack size, edition, platform, format, refill, bundle) is part of the pattern, so different products get different canonical names. Colour and size are never part of it (they are variant options).
- Two listings are the same product when their canonical names are exactly equal within the same category and both are accepted by the checker. A listing without a canonical name never name-matches.
- Until canonical names exist, name matching is switched off and product pages use barcode, model-number and admin-confirmed matches only. Names saved before the change get canonical names in a catch-up run (owner accepted about $3 of usage).
- The checker keeps its safety rules for the display name; the canonical name must contain the brand, every model and number token and every distinguishing word of the source title in normalised form.

### What counts as the same product (owner decision: "name + specs", superseded by the update above)

Two shops' listings are the same product when either:
1. they share a barcode (GTIN) or maker's model number (MPN), as today, or the owner confirmed the match in admin; or
2. **name match:** both have an accepted clean name, the same reliable brand (or both none), the same clean name after case, spacing and unit spelling are made equal, and the same values for the category's key specs where both have them (for example storage_gb, ram_gb and screen_in for laptops and phones; size, volume or pack count for drinks and beauty; pieces and set number for toys). A spec present on one side and different on the other blocks the match. Colour and size are variant options, not part of the product's identity.

Name matches are stored as a new match method `name` in the canonical grouping at site-build. They count as trusted for listing sellers side by side and for "Cheaper at", because the clean name already passed the safety check (brand, model and number tokens kept) and the specs must agree. Title-only matches (`title`, the old word-overlap rule) stay "possibly the same" and are never shown as the same product.

### Search

- One result per product (canonical group), titled with the clean name, showing the lowest current price, how many shops sell it, and a Black Friday marker if any seller marks it.
- A product sold by one shop is still one result.
- Ranking uses the clean name first, then the shop titles.

### Product page

- Keyed by the product (canonical id), with a stable link; old `/p/:id` links for a shop listing redirect to their product.
- Shows the clean name, image, key attributes, and a sellers table: shop, current price, was price, stock, link to the shop, and that seller's verdict (Good Deal, Deal to Avoid or none). Verdicts stay per seller, because a "was" price is one shop's claim.
- Variant options (colour, size) are shown as choices; choosing one filters the sellers table.
- The price chart shows each seller's line (Advanced), and the day table works per seller.
- "Something wrong?" can report the whole product or one seller's listing.

### Filters

Filters by attribute (size, colour, material, dimensions) remain a later task; this design stores the data they need.

## Not in scope

- Pay-per-use API keys or paid catalogues; Open Icecat (possible later add-on); new crawls of product pages for the HTML shops; the attribute filter UI itself.

## Testing

- Unit tests per adapter with saved real-shaped payloads (Shopify options, Woo attributes, Magento table, JSON-LD) asserting the stored pairs and limits.
- Normaliser tests: name synonyms, colour and size lists, unit parsing, unknown names.
- Clean-name tests with real titles from the database (Lenovo, iPhone, LEGO, clothing with sizes), including the safety rule: brand and every model and number token kept.
- A read-only report on Neon after the first build: share of groups with a clean name different from the title, top unmapped attribute names, and database size before and after.

## Rollout

0. Tonight: the normaliser script with `--pilot` and `--dry-run`, run by hand, so the owner can try a small batch per model and judge names and usage.
1. Scraper capture (Shopify and Woo first, then Magento and JSON-LD) and migration 007; the next nightly run fills `products.attrs`.
2. Site-build normalising, `display_name` and `site_products.attrs`.
3. Search and list presentation.
4. Report to the owner with examples before switching the public site to the clean names.
