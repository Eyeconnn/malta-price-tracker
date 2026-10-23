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

export type CategoryRule = {
  slug: CategorySlug;
  pattern: RegExp;
  on: CategorySource[];
  /** tried on the title before the category path (a kids' version of a device is a toy, whatever the path says) */
  first?: boolean;
};

/** After a device word: something to carry or stand the device in (a laptop bag, a tablet stand), so the device word decides nothing. */
const CARRY = String.raw`(?!\s*(?:&\s*\w+\s+)?(?:bags?|backpacks?|sleeves?|cases?|briefcases?|totes?|stands?|organi[sz]ers?|crossbody|pouch(?:es)?)\b)`;
/** As CARRY, but phone and tablet cases stay with phones. */
const PHONE_CARRY = String.raw`(?!\s*(?:&\s*\w+\s+)?(?:bags?|backpacks?|sleeves?|stands?|organi[sz]ers?|crossbody|pouch(?:es)?)\b)`;
const ci = (source: string) => new RegExp(source, 'i');

/**
 * Ordered: within a source, the first matching rule wins. Sources are tried category, tags, title; the title only for
 * shops without a specialist category (see TITLE_SHOP_CATEGORIES). Rules marked first are tried on the title before
 * everything else.
 */
export const CATEGORY_RULES: CategoryRule[] = [
  { slug: 'toys', pattern: /\b(kids?|children'?s?|my first)\b.{0,40}?\b(cameras?|laptops?|tablets?|smart ?watch(es)?|walkie[ -]talkies?|karaoke|microphones?)\b/i, on: ['title'], first: true },
  { slug: 'other', pattern: /\b(stationery|stationary|notepads?|note books?|journals?|diar(y|ies)|(computer|pc|laptop) peripherals|keycaps?|printers?|toners?|ink cartridges?)\b/i, on: ['category', 'tags'] },
  { slug: 'phones', pattern: /\b(smart ?watch(es)?|smart ?bands?|fitness trackers?|wearables?)\b/i, on: ['category', 'tags', 'title'] },
  { slug: 'laptops', pattern: ci(String.raw`\b(laptops?|macbooks?|chromebooks?|ultrabooks?)\b${CARRY}`), on: ['category', 'tags'] },
  { slug: 'laptops', pattern: ci(String.raw`(?<!\bmy\s(?:first\s)?)\b(laptops?|notebooks?|macbooks?|chromebooks?|ultrabooks?)\b${CARRY}`), on: ['title'] },
  { slug: 'phones', pattern: ci(String.raw`\b(smart ?phones?|mobile phones?|phones?|iphones?|tablets?|ipads?|galaxy (s|a|z)\d+)\b${PHONE_CARRY}`), on: ['category', 'tags', 'title'] },
  { slug: 'tv-audio', pattern: /\b(televisions?|tvs?(?!\s*(?:stands?|cabinets?|units?|tables?|benches?)\b)|soundbars?|headphones?|earbuds?|speakers?|audio|hi-?fi|home cinema|projectors?)\b/i, on: ['category', 'tags', 'title'] },
  { slug: 'gaming', pattern: /\b(gaming|consoles?|video games?|playstation|ps[45]|xbox|nintendo)\b/i, on: ['category', 'tags', 'title'] },
  { slug: 'appliances', pattern: /\b(appliances?|fridges?|refrigerators?|freezers?|washing machines?|washers?|(?<!hair\s)dryers?|dishwashers?|ovens?|microwaves?|cookers?|hobs?|vacuums?|air fryers?|coffee machines?|espresso machines?|kettles?|toasters?|air conditioners?|heaters?|heating|dehumidifiers?|wine coolers?)\b/i, on: ['category', 'tags', 'title'] },
  { slug: 'toys', pattern: /\b(toys?|lego|playsets?|dolls?|puzzles?|board games?|barbie|playmobil|hot wheels|plush(ies)?|soft toys?|action figures?|boardgames?|card games?|playing cards)\b/i, on: ['category', 'tags', 'title'] },
  { slug: 'baby', pattern: /\b(baby|babies|newborns?|infants?|toddlers?|prams?|strollers?|nappies|car seats?)\b/i, on: ['category', 'tags', 'title'] },
  { slug: 'fashion', pattern: /\b(fashion|clothing|clothes(?!\s*airers?\b)|apparel|(?<!\b(?:cold|hot)\s)shoes?|trainers|sneakers?|dress(es)?|jackets?|jeans|handbags?|jewell?ery|watches)\b/i, on: ['category', 'tags', 'title'] },
  { slug: 'fashion', pattern: /\b((?<!\b(?:gig|cooler|dry|sleeping|bean|gift|freezer|vacuum)\s?)bags?(?!\s+for\b)|backpacks?|briefcases?|luggage|suitcases?|wallets?|belts?|sunglasses|eyewear|socks|underwear|lingerie|bras?|swimwear|swimsuits?|bikinis?|footwear|flats|loafers|sandals|boots)\b/i, on: ['category', 'tags'] },
  { slug: 'beauty-health', pattern: /\b(beauty|make-?up|perfumes?|fragrances?|skin ?care|cosmetics|shavers?|epilators?|trimmers?|groom(ers?|ing)|hair ?dryers?|hair straighteners?|vitamins?|supplements?|personal care|health)\b/i, on: ['category', 'tags', 'title'] },
  { slug: 'home-kitchen', pattern: /\b(home|kitchen|furniture|garden|bedding|mattress(es)?|cookware|lighting|decor|drinkware|tableware|glassware|airers?|laundry|ironing)\b/i, on: ['category', 'tags'] },
  { slug: 'sports', pattern: /\b(sports?(?!\s+drinks?\b)|fitness|gym|bikes?|bicycles?|cycling|running|football|camping|outdoors?|treadmills?|yoga)\b/i, on: ['category', 'tags'] },
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

/**
 * Shop categories whose titles may decide the site category. These shops sell a bit of everything, so a title word
 * ("Laptop", "Kettle") is the best signal left. For a specialist shop (fashion, drinks, gaming, music ...) a title word
 * is more often a name or colour ("Million Dollar Baby", "Belt in Wine", "Rum Paradise Bay Bikini") than the
 * product, so its own category wins over the title. Shops with no category count as generalists.
 */
const TITLE_SHOP_CATEGORIES = new Set(['', 'electronics']);

/** Path segments that describe the promotion, not the product, and must never decide a category. */
const GENERIC_SEGMENT = /\b(black\W?friday|sale|offers?|deals?|clearance|new)\b/i;

const SLUGS = new Set<string>(SITE_CATEGORIES.map((c) => c.slug));

function segments(path: string | null): string[] {
  return (path ?? '')
    .split(/>|\||\/|»|›/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

/** Path text the rules read: underscores as spaces ("Type_Sunglasses" reads "Type Sunglasses"). Tags keep theirs (promo codes such as HW_BEAUTY_PROMO). */
const ruleText = (s: string) => s.replace(/_/g, ' ');

export function categorize(
  input: { categoryPath: string | null; tags: string[]; title: string | null; shopCategory: string | null },
  overrides: Record<string, string> = {},
): string {
  const segs = segments(input.categoryPath);

  for (const seg of segs) {
    const slug = overrides[seg];
    if (slug !== undefined && SLUGS.has(slug)) return slug;
  }

  const title = input.title ?? '';
  for (const rule of CATEGORY_RULES) {
    if (rule.first && rule.on.includes('title') && rule.pattern.test(title)) return rule.slug;
  }

  const shopCategory = (input.shopCategory ?? '').toLowerCase();
  const titleDecides = TITLE_SHOP_CATEGORIES.has(shopCategory) || !Object.hasOwn(SHOP_CATEGORY_MAP, shopCategory);
  const texts: [CategorySource, string][] = [
    ['category', ruleText(segs.filter((s) => !GENERIC_SEGMENT.test(s)).join(' | '))],
    ['tags', input.tags.filter((t) => !GENERIC_SEGMENT.test(t)).join(' | ')],
    ['title', titleDecides ? title : ''],
  ];
  for (const [source, text] of texts) {
    if (text === '') continue;
    for (const rule of CATEGORY_RULES) {
      if (!rule.first && rule.on.includes(source) && rule.pattern.test(text)) return rule.slug;
    }
  }

  return SHOP_CATEGORY_MAP[shopCategory] ?? 'other';
}
