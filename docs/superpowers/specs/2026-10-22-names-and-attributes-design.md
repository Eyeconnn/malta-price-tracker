# Clean product names and product attributes: design

Date: 22 Oct 2026. Status: draft for the owner's approval.

## Why

Search results look untidy. Shops write the same product in different ways ("LENOVO THINKBOOK 16 G6 IRL 16" I5/8GB/512SSD/W11P" next to "Lenovo ThinkBook 16 G6 Laptop"), variants of one product show as near-duplicate rows, and we keep no structured facts about a product (size, colour, material, capacity, dimensions). The owner wants:

1. A cleaner, normalised name for every product group, especially where there are variants.
2. Features and attributes stored for every scraped product, so a later task can build normalised filters (size, dimensions, colour, material and so on).

## Decisions taken

- **Sources: free data only.** We use what the shops already publish in the pages and feeds we already download, plus agreement between shops that sell the same barcode. No AI rewriting (it costs money; the owner was asked and stated no preference, so the free option is the default). No outside catalogue for now; Open Icecat (free account, barcode lookup, strong for electronics) is a possible later add-on and needs the owner to sign up.
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

Built nightly per site_products group into a new `site_products.display_name` column (the existing `title` stays the shop's text):

1. **Remove variant parts.** Option values that belong to variants (colour, size, storage) are removed from the end or brackets of the title, so the variants of one product share one name; the variant values are shown as chips.
2. **Remove shop noise.** Shop names, "free delivery", "new", "sale", "Black Friday", stock notes, repeated brand, SKU codes in brackets, trailing separators.
3. **Fix casing.** All-capital titles become title case, keeping known brand casing (iPhone, LEGO, ThinkPad, AirPods) and unit spellings (GB, TB, Wi-Fi, 4K, mAh); a brand dictionary built from the brand column across all shops.
4. **Standard units.** 16GB, 512 GB SSD, 15.6", 55 inch -> one spelling each.
5. **Agreement across shops.** When several shops sell the same barcode or model number (trusted matches only), the group's name is the clean name most shops agree on, else the shortest clean name that keeps the brand and every model and number token.
6. **Safety.** A cleaned name is used only if it keeps the brand (when known) and every model and number token of the original; otherwise the original title is shown. Names are never invented.

## Part 3: search presentation

- Search and deal lists show `display_name`; the shop's title is shown in Advanced mode and on the product page.
- Within one shop, groups whose clean names match are shown once with variant chips instead of several rows.
- Search ranking uses both the clean name and the shop title.
- Filters by attribute (size, colour, material, dimensions) are a later task; this design only stores the data they need.

## Not in scope

- AI rewriting or paid catalogues; Open Icecat (possible later add-on); new crawls of product pages for the HTML shops; the attribute filter UI itself.

## Testing

- Unit tests per adapter with saved real-shaped payloads (Shopify options, Woo attributes, Magento table, JSON-LD) asserting the stored pairs and limits.
- Normaliser tests: name synonyms, colour and size lists, unit parsing, unknown names.
- Clean-name tests with real titles from the database (Lenovo, iPhone, LEGO, clothing with sizes), including the safety rule: brand and every model and number token kept.
- A read-only report on Neon after the first build: share of groups with a clean name different from the title, top unmapped attribute names, and database size before and after.

## Rollout

1. Scraper capture (Shopify and Woo first, then Magento and JSON-LD) and migration 007; the next nightly run fills `products.attrs`.
2. Site-build normalising, `display_name` and `site_products.attrs`.
3. Search and list presentation.
4. Report to the owner with examples before switching the public site to the clean names.
