// Maps a product (shop category path, tags, title, shop category) onto one of the site's categories.

export const SITE_CATEGORIES = [
  { slug: 'laptops', name: 'Laptops' },
  { slug: 'phones', name: 'Phones & tablets' },
  { slug: 'tv-audio', name: 'TV & audio' },
  { slug: 'gaming', name: 'Gaming' },
  { slug: 'appliances', name: 'Appliances' },
  { slug: 'toys', name: 'Toys' },
  { slug: 'baby', name: 'Baby' },
  { slug: 'fashion', name: 'Fashion' },
  { slug: 'beauty-health', name: 'Beauty & health' },
  { slug: 'home-kitchen', name: 'Home & kitchen' },
  { slug: 'sports', name: 'Sports & outdoors' },
  { slug: 'drinks', name: 'Drinks' },
  { slug: 'other', name: 'Other' },
] as const;

export type CategorySlug = (typeof SITE_CATEGORIES)[number]['slug'];

export type CategorySource = 'category' | 'tags' | 'title';

export type CategoryRule = { slug: CategorySlug; pattern: RegExp; on: CategorySource[] };

/** Ordered: within a source, the first matching rule wins. Sources are tried category, tags, title. */
export const CATEGORY_RULES: CategoryRule[] = [
  { slug: 'laptops', pattern: /\b(laptops?|notebooks?|macbooks?|chromebooks?|ultrabooks?)\b/i, on: ['category', 'tags', 'title'] },
  { slug: 'phones', pattern: /\b(smart ?phones?|mobile phones?|phones?|iphones?|tablets?|ipads?|galaxy (s|a|z)\d+)\b/i, on: ['category', 'tags', 'title'] },
  { slug: 'tv-audio', pattern: /\b(televisions?|tvs?|soundbars?|headphones?|earbuds?|speakers?|audio|hi-?fi|home cinema|projectors?)\b/i, on: ['category', 'tags', 'title'] },
  { slug: 'gaming', pattern: /\b(gaming|consoles?|video games?|playstation|ps[45]|xbox|nintendo)\b/i, on: ['category', 'tags', 'title'] },
  { slug: 'appliances', pattern: /\b(appliances?|fridges?|refrigerators?|freezers?|washing machines?|washers?|dryers?|dishwashers?|ovens?|microwaves?|cookers?|hobs?|vacuums?|air fryers?|coffee machines?|kettles?)\b/i, on: ['category', 'tags', 'title'] },
  { slug: 'toys', pattern: /\b(toys?|lego|playsets?|dolls?|puzzles?|board games?|barbie|playmobil|hot wheels)\b/i, on: ['category', 'tags', 'title'] },
  { slug: 'baby', pattern: /\b(baby|babies|newborns?|infants?|toddlers?|prams?|strollers?|nappies|car seats?)\b/i, on: ['category', 'tags', 'title'] },
  { slug: 'fashion', pattern: /\b(fashion|clothing|clothes|apparel|shoes?|trainers|sneakers|dress(es)?|jackets?|jeans|handbags?|jewell?ery|watches)\b/i, on: ['category', 'tags', 'title'] },
  { slug: 'beauty-health', pattern: /\b(beauty|make-?up|perfumes?|fragrances?|skin ?care|cosmetics|shavers?|vitamins?|supplements?|personal care|health)\b/i, on: ['category', 'tags', 'title'] },
  { slug: 'home-kitchen', pattern: /\b(home|kitchen|furniture|garden|bedding|mattress(es)?|cookware|lighting|decor)\b/i, on: ['category', 'tags'] },
  { slug: 'sports', pattern: /\b(sports?|fitness|gym|bikes?|bicycles?|cycling|running|football|camping|outdoors?|treadmills?|yoga)\b/i, on: ['category', 'tags'] },
  { slug: 'drinks', pattern: /\b(drinks?|beers?|lager|wines?|spirits|whisk(e)?y|vodka|gin|rum|liqueurs?|beverages?|champagne|prosecco)\b/i, on: ['category', 'tags', 'title'] },
];

/** Shop-level category (from the shops table) to site slug, used when no rule matches. */
const SHOP_CATEGORY_MAP: Record<string, CategorySlug> = {
  sports: 'sports',
  bikes: 'sports',
  fashion: 'fashion',
  jewellery: 'fashion',
  travel: 'fashion',
  beauty: 'beauty-health',
  health: 'beauty-health',
  drinks: 'drinks',
  toys: 'toys',
  gaming: 'gaming',
  home: 'home-kitchen',
  baby: 'baby',
  books: 'other',
  music: 'other',
  electronics: 'other',
};

/** Path segments that describe the promotion, not the product, and must never decide a category. */
const GENERIC_SEGMENT = /\b(black\W?friday|sale|offers?|deals?|clearance|new)\b/i;

const SLUGS = new Set<string>(SITE_CATEGORIES.map((c) => c.slug));

function segments(path: string | null): string[] {
  return (path ?? '')
    .split(/>|\||\/|»|›/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

export function categorize(
  input: { categoryPath: string | null; tags: string[]; title: string | null; shopCategory: string | null },
  overrides: Record<string, string> = {},
): string {
  const segs = segments(input.categoryPath);

  for (const seg of segs) {
    const slug = overrides[seg];
    if (slug !== undefined && SLUGS.has(slug)) return slug;
  }

  const texts: [CategorySource, string][] = [
    ['category', segs.filter((s) => !GENERIC_SEGMENT.test(s)).join(' | ')],
    ['tags', input.tags.filter((t) => !GENERIC_SEGMENT.test(t)).join(' | ')],
    ['title', input.title ?? ''],
  ];
  for (const [source, text] of texts) {
    if (text === '') continue;
    for (const rule of CATEGORY_RULES) {
      if (rule.on.includes(source) && rule.pattern.test(text)) return rule.slug;
    }
  }

  return SHOP_CATEGORY_MAP[(input.shopCategory ?? '').toLowerCase()] ?? 'other';
}
