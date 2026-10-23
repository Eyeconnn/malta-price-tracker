// Which products.brand values name the maker. Shops often fill the brand field with their own name or domain
// ("GameStore.mt", "OKFASHION.COM.MT", "Toysmalta"), a company ("Sterling Holdings", "ADDO PLAY LTD", "Tezenis Malta")
// or the distributor they buy from ("M&Z" for Childs Farm, "Atmosphera" for The Kitchen Store's own "TKS" range).
//
// The rule (used by check.ts and passed to the prompt):
// - none: empty, a placeholder (Generic, N/A, ...), no letters (Women'secret puts product numbers there) or one character.
//   No brand is required and the value is not shop data a name may use.
// - house: the shop's own name (rule 3 below, not a web address) at a shop where it is the brand of at least 80% of the
//   branded fresh groups, so the shop sells one brand of its own (Calzedonia Malta, Tezenis Malta, Samsonite,
//   TWINSET, Mvintage, The Body Shop). It is the maker but not required, because the shop titles never carry it; the
//   name may start with it without company and place words (Calzedonia), and the prompt sends it that way.
// - unreliable, when any of these holds:
//   1. it looks like a web address (.com, .mt, ...);
//   2. it has a company, place or label word (Ltd, Limited, Holdings, Malta, Co, Group, Inc, S.R.L., Ent, Trading,
//      Accessories, Products, Outlet, Boutique, ...);
//   3. it is the shop's own name, slug or web address, or contains one of them, or is contained in one (iCentre,
//      BodyShopMalta, The Body Shop at The Body Shop Malta), or it is the full name of another tracked shop with two or
//      more words (Swanky Boutique at Vanilla Mummy);
//   4. it is a distributor of that shop, from the shop's own fresh groups (distributorBrands; the CLI reads brand and
//      title of every fresh group of active, visible shops in one query, loadBrandContext): at least 5 groups carry
//      it, at most 10% of their titles contain it, and at least half of their titles start with another maker's name
//      (a brand of the brand column, of any shop) or with the shop's own label (the initials of the shop name, as TKS
//      for The Kitchen Store). Titles that start with a product line (Galaxy for Samsung) or a product noun (MANGO's
//      "Ribbed Knit Dress") do not count, so one-brand shops keep their real maker. A short code of at most 3 letters
//      and digits with a symbol or no vowel (M&Z, TT, BYS; not UGG or On) on 5+ groups of which no title contains it
//      counts as a distributor too.
//   An unreliable brand is not required in the name, and the name may contain it only when the title has it.
// - reliable otherwise. It must be kept: the name contains its words written together or apart, its first word when
//   it has more words (Adidas for Adidas Performance, VTech for VTECH KIDS), or its initials (M&S for Marks & Spencer).
import type postgres from 'postgres';
import { compact, inRun, prep, tokens } from './text.js';

export type BrandStatus = 'reliable' | 'house' | 'unreliable' | 'none';
/** name: for a house brand, the brand without company and place words (Calzedonia for Calzedonia Malta) */
export type BrandVerdict = { status: BrandStatus; why: string | null; name?: string };
export type ShopIdentity = { id: number; slug: string; name: string; baseUrl: string | null };
export type BrandRow = { shopId: number; brand: string | null; title: string };
/** All tracked shops; per shop the keys (compact brand values) found to be distributors; the shops of one house brand. */
export type BrandContext = {
  shops: ShopIdentity[];
  distributors: Map<number, Set<string>>;
  houseShops?: Set<number>;
  /** compact brand values that are makers: reliable by their text and carried by at least one of their own titles */
  makers?: Set<string>;
};

/** Brand values shops use when there is no brand. */
const PLACEHOLDER_BRANDS = new Set(['generic', 'unbranded', 'nobrand', 'none', 'na', 'other', 'others', 'unknown', 'default', 'oem', 'various', 'model']);
/** Company and place words: such a brand names the importer or seller, not the maker. */
const COMPANY_WORDS = new Set([
  'ltd', 'limited', 'holdings', 'holding', 'malta', 'co', 'group', 'inc', 'gmbh', 'srl', 'spa', 'llc', 'plc', 'sa', 'ag', 'bv',
  'ent', 'enterprises', 'trading', 'distributors', 'distribution', 'imports', 'accessories', 'products', 'outlet', 'boutique',
]);
const WEB_TLD = /\.(?:com|mt|net|org|eu|uk|shop|store|online|info|biz|io|co|de|it)\b/i;
/** Host labels that are no shop name. */
const HOST_NOISE = new Set(['www', 'online', 'shop', 'store', 'com', 'mt', 'net', 'org', 'co', 'uk', 'eu']);
/** Title-leading words that are never another maker, even when some shop uses them as a brand. */
const NOT_A_MAKER = new Set(['kids', 'kid', 'baby', 'mini', 'classic', 'basic', 'new', 'the', 'set', 'pack', 'home', 'kitchen', 'sport', 'sports', 'style', 'love', 'little', 'big', 'one', 'pro', 'max', 'plus', 'gift', 'women', 'men', 'girls', 'boys']);

/** Distributor statistic: groups a brand needs at a shop, share of titles that may name it, share of titles that must name another maker. */
const MIN_GROUPS = 5;
const MAX_IN_TITLE = 0.1;
const MIN_OTHER_MAKER = 0.5;
/** With two or more different makers among the title starts, this share is enough. */
const MIN_OTHER_MAKERS = 0.4;
/** A brand whose own titles carry it this often across the catalogue is a maker everywhere (Apple, Samsung). */
const CONFIRMED_IN_TITLE = 0.2;
/** A title-start word is a maker name when it starts this many titles, stands first in this share of the titles that
 *  have it, and starts titles under two or more brand values (Avent, Lansinoh, Woomax). */
const MAKER_WORD_MIN = 3;
const MAKER_WORD_LEAD = 0.8;
/** Share of a shop's branded groups whose brand is the shop's own name for the shop to sell one house brand. */
const MIN_HOUSE_SHARE = 0.8;
/** ... and fewer than this share of those groups' titles may start with another catalogue maker (review I1). */
const MAX_HOUSE_OTHER_MAKERS = 0.3;

/** Words of a brand, letters and digits only: "Carnival S.R.L." gives carnival, srl; "Marks & Spencer" gives marks, spencer. */
export function brandWords(brand: string): string[] {
  return prep(brand)
    .split(/[\s&+,/\u2013-]+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]+/gu, ''))
    .filter((w) => w !== '');
}

/**
 * The spellings that count as the brand in a list of name or title tokens: its tokens written together or apart
 * (without company words), its first word when it has more (3+ letters), and its initials when it has more words.
 */
export function brandForms(brand: string): string[] {
  const words = tokens(prep(brand)).filter((w) => !COMPANY_WORDS.has(w));
  const forms = new Set<string>();
  const full = words.join('');
  if (full !== '') forms.add(full);
  if (words.length >= 2) {
    if (/^\p{L}{3,}/u.test(words[0])) forms.add(words[0]);
    if (words.every((w) => /^\p{L}/u.test(w))) forms.add(words.map((w) => w[0]).join(''));
  }
  return [...forms];
}

/** Whether the tokens contain the brand's full form (its words, together or apart). */
export function fullBrandIn(list: string[], brand: string): boolean {
  const full = brandForms(brand)[0];
  return full !== undefined && inRun(list, full);
}

/**
 * Whether a name keeps the brand: its full form when the title has the full brand (Black & Decker, Red Bull,
 * Fisher-Price), else any form (Adidas for Adidas Performance, M&S for Marks & Spencer).
 */
export function keepsBrand(nameToks: string[], brand: string, titleToks: string[]): boolean {
  return fullBrandIn(titleToks, brand) ? fullBrandIn(nameToks, brand) : hasBrand(nameToks, brand);
}

/** Whether a brand value looks like a web address (GameStore.mt). */
export const isWebBrand = (brand: string) => WEB_TLD.test(brand);

/** Whether the tokens contain the brand in one of its forms. */
export function hasBrand(list: string[], brand: string): boolean {
  return brandForms(brand).some((f) => inRun(list, f));
}

/** The status a brand value has without knowing the shop: none, unreliable (web address or company word) or reliable. */
export function basicBrandStatus(brand: string | null | undefined): BrandStatus {
  return basicVerdict(brand).status;
}

function basicVerdict(brand: string | null | undefined): BrandVerdict {
  const key = brand ? compact(brand) : '';
  if (key.length < 2 || !/\p{L}/u.test(key) || PLACEHOLDER_BRANDS.has(key)) return { status: 'none', why: 'no brand' };
  if (WEB_TLD.test(brand!)) return { status: 'unreliable', why: 'web address' };
  if (brandWords(brand!).some((w) => COMPANY_WORDS.has(w))) return { status: 'unreliable', why: 'company or place name' };
  return { status: 'reliable', why: null };
}

/** Compact names of a shop: slug, name and the labels of its web address ("tks-onlinestore.com" gives tksonlinestore). */
export function shopKeys(shop: ShopIdentity): string[] {
  const keys = new Set<string>([compact(shop.slug), compact(shop.name)]);
  if (shop.baseUrl) {
    try {
      for (const label of new URL(shop.baseUrl).hostname.split('.')) if (!HOST_NOISE.has(label)) keys.add(compact(label));
    } catch {
      // not a URL, no keys from it
    }
  }
  return [...keys].filter((k) => k.length >= 3);
}

/** Initials of a shop name of two or more words: The Kitchen Store gives tks. */
function shopInitials(shop: ShopIdentity): string | null {
  const words = brandWords(shop.name).filter((w) => /^\p{L}/u.test(w));
  return words.length >= 2 ? words.map((w) => w[0]).join('') : null;
}

/** Whether the brand key is the shop's own name, slug or web address, contains one or is contained in one. */
function isOwnShopName(key: string, shop: ShopIdentity | undefined): boolean {
  if (!shop) return false;
  return shopKeys(shop).some((k) => key === k || (k.length >= 5 && key.includes(k)) || (key.length >= 5 && k.includes(key)));
}

/** Whether the brand key is the full name (two or more words) of another tracked shop. */
function isOtherShopName(key: string, shopId: number, shops: ShopIdentity[]): boolean {
  return shops.some((s) => s.id !== shopId && brandWords(s.name).length >= 2 && key === compact(s.name));
}

/** The brand without company and place words: Calzedonia Malta gives Calzedonia, Carnival S.R.L. gives Carnival. */
export function brandName(brand: string): string {
  const kept = brand.trim().split(/\s+/).filter((w) => !COMPANY_WORDS.has(compact(w)));
  return kept.length > 0 ? kept.join(' ') : brand.trim();
}

/** The status of a group's brand at its shop (see the top of this file). */
export function brandStatus(brand: string | null | undefined, shopId: number, ctx: BrandContext): BrandVerdict {
  const basic = basicVerdict(brand);
  if (basic.status === 'none' || basic.why === 'web address') return basic;
  const key = compact(brand!);
  const own = isOwnShopName(key, ctx.shops.find((s) => s.id === shopId));
  if (own && ctx.houseShops?.has(shopId)) return { status: 'house', why: "the shop's own brand", name: brandName(brand!) };
  if (basic.status !== 'reliable') return basic;
  if (own || isOtherShopName(key, shopId, ctx.shops)) return { status: 'unreliable', why: 'shop name' };
  if (ctx.distributors.get(shopId)?.has(key)) return { status: 'unreliable', why: 'distributor (its titles name other makers)' };
  return basic;
}

/** The distributor statistic (rule 4 at the top of this file) and the shops that sell one house brand. */
export function brandStats(rows: BrandRow[], shops: ShopIdentity[]): { distributors: Map<number, Set<string>>; houseShops: Set<number>; makers: Set<string> } {
  const byId = new Map(shops.map((s) => [s.id, s]));
  const branded = new Map<number, { all: number; own: number }>();
  for (const r of rows) {
    if (basicVerdict(r.brand).status === 'none') continue;
    const e = branded.get(r.shopId) ?? { all: 0, own: 0 };
    e.all++;
    if (!WEB_TLD.test(r.brand!) && isOwnShopName(compact(r.brand!), byId.get(r.shopId))) e.own++;
    branded.set(r.shopId, e);
  }
  const makers = new Set<string>();
  for (const r of rows) {
    if (basicVerdict(r.brand).status !== 'reliable') continue;
    const key = compact(r.brand!);
    if (key.length >= 3 && !NOT_A_MAKER.has(key) && !makers.has(key) && hasBrand(tokens(prep(r.title)), r.brand!)) makers.add(key);
  }
  // a shop whose own-name groups mostly start with other makers (LEGO, Barbie at a toy shop) is a retailer using its
  // name as a fallback, not a one-brand shop
  const otherMakerLead = new Map<number, number>();
  for (const r of rows) {
    if (basicVerdict(r.brand).status === 'none' || WEB_TLD.test(r.brand!) || !isOwnShopName(compact(r.brand!), byId.get(r.shopId))) continue;
    const t = tokens(prep(r.title)).filter((x) => /\p{L}/u.test(x));
    const own = compact(r.brand!);
    const lead = [t[0] ?? '', (t[0] ?? '') + (t[1] ?? '')].filter((k) => k !== '' && k !== own);
    if (lead.some((k) => makers.has(k))) otherMakerLead.set(r.shopId, (otherMakerLead.get(r.shopId) ?? 0) + 1);
  }
  const houseShops = new Set(
    [...branded]
      .filter(([id, e]) => e.own >= MIN_HOUSE_SHARE * e.all && (otherMakerLead.get(id) ?? 0) < MAX_HOUSE_OTHER_MAKERS * e.own)
      .map(([id]) => id),
  );
  return { distributors: distributorBrands(rows, shops), houseShops, makers };
}

/**
 * A maker among the first three words of a title (one word, or two written together), when that is a brand of the
 * catalogue that its own titles carry (Therabody in "Therabody TheraCup"). The clean name must keep it, so a model
 * cannot swap it for the brand field's value (Theragun). Returns the words as the title writes them, or null.
 */
export function titleMaker(title: string, ctx: BrandContext): string | null {
  if (!ctx.makers || ctx.makers.size === 0) return null;
  const words = title.trim().split(/\s+/).filter((w) => /\p{L}/u.test(w));
  // the maker may follow a product word or two ("Natural Response Avent Bottle"): the first three words are scanned
  for (let start = 0; start < Math.min(3, words.length); start++) {
    for (const n of [2, 1]) {
      if (start + n > words.length) continue;
      const key = compact(words.slice(start, start + n).join(' '));
      if (key.length >= 3 && ctx.makers.has(key)) return words.slice(start, start + n).join(' ').replace(/[^\p{L}\p{N}'&.\s-]+$/u, '');
    }
  }
  return null;
}

/** Per shop, the compact brand values that are distributors (rule 4 at the top of this file). */
export function distributorBrands(rows: BrandRow[], shops: ShopIdentity[]): Map<number, Set<string>> {
  const known = new Set<string>();
  const byShopBrand = new Map<string, { shopId: number; key: string; brand: string; titles: string[] }>();
  for (const r of rows) {
    if (basicVerdict(r.brand).status === 'none') continue;
    const key = compact(r.brand!);
    if (key.length >= 3 && !NOT_A_MAKER.has(key)) known.add(key);
    const id = `${r.shopId}|${key}`;
    const e = byShopBrand.get(id);
    if (e) e.titles.push(r.title);
    else byShopBrand.set(id, { shopId: r.shopId, key, brand: r.brand!, titles: [r.title] });
  }
  const initials = new Map(shops.map((s) => [s.id, shopInitials(s)]));
  const ownKeys = new Map(shops.map((s) => [s.id, new Set(shopKeys(s))]));

  // catalogue-wide: how often each brand's own titles carry it, and how each word stands in titles
  const confirmed = new Map<string, { n: number; inTitle: number }>();
  const leadCount = new Map<string, number>();
  const anyCount = new Map<string, number>();
  const leadBrands = new Map<string, Set<string>>();
  for (const r of rows) {
    if (basicVerdict(r.brand).status === 'none') continue;
    const key = compact(r.brand!);
    const toks = tokens(prep(r.title)).filter((x) => /\p{L}/u.test(x));
    const c = confirmed.get(key) ?? { n: 0, inTitle: 0 };
    c.n++;
    if (hasBrand(toks, r.brand!)) c.inTitle++;
    confirmed.set(key, c);
    for (const w of new Set(toks)) anyCount.set(w, (anyCount.get(w) ?? 0) + 1);
    if (toks.length > 0) {
      leadCount.set(toks[0], (leadCount.get(toks[0]) ?? 0) + 1);
      const b = leadBrands.get(toks[0]) ?? new Set<string>();
      b.add(key);
      leadBrands.set(toks[0], b);
    }
  }
  const makerWord = (w: string) =>
    /^\p{L}{3,}$/u.test(w) && !NOT_A_MAKER.has(w) && (leadCount.get(w) ?? 0) >= MAKER_WORD_MIN &&
    (leadCount.get(w) ?? 0) >= MAKER_WORD_LEAD * (anyCount.get(w) ?? 0) && (leadBrands.get(w)?.size ?? 0) >= 2;

  const out = new Map<number, Set<string>>();
  for (const { shopId, key, brand, titles } of byShopBrand.values()) {
    if (titles.length < MIN_GROUPS) continue;
    const toks = titles.map((t) => tokens(prep(t)).filter((x) => /\p{L}/u.test(x)));
    const inTitle = toks.filter((l) => hasBrand(l, brand)).length;
    if (inTitle > MAX_IN_TITLE * titles.length) continue;
    // a short code (M&Z, TT, BYS) that no title of the shop contains is a supplier or stock code, not a maker; short
    // names with a vowel (UGG, On) are left alone
    const code = inTitle === 0 && key.length <= 3 && (/[^\p{L}\s]/u.test(brand.trim()) || !/[aeiou]/.test(key));
    if (code) {
      let set = out.get(shopId);
      if (!set) out.set(shopId, (set = new Set()));
      set.add(key);
      continue;
    }
    // a brand its own titles carry often across the catalogue is a maker, whatever this shop does
    const conf = confirmed.get(key);
    if (conf && conf.inTitle >= CONFIRMED_IN_TITLE * conf.n) continue;
    const label = initials.get(shopId) ?? null;
    const own = ownKeys.get(shopId) ?? new Set<string>();
    let other = 0;
    const makersSeen = new Set<string>();
    for (const l of toks) {
      if (l.length === 0) continue;
      const lead1 = l[0];
      const lead2 = l.length > 1 ? l[0] + l[1] : '';
      const maker = (lead1 !== key && (known.has(lead1) || makerWord(lead1))) || (lead2 !== '' && lead2 !== key && known.has(lead2));
      const shopLabel = lead1 === label || own.has(lead1);
      if (maker) makersSeen.add(lead1);
      if (maker || shopLabel) other++;
    }
    if (other >= MIN_OTHER_MAKER * titles.length || (makersSeen.size >= 2 && other >= MIN_OTHER_MAKERS * titles.length)) {
      let set = out.get(shopId);
      if (!set) out.set(shopId, (set = new Set()));
      set.add(key);
    }
  }
  return out;
}

/** Shops and the distributor statistic over every fresh group of active, visible shops (Ruling R21, as select.ts). */
export async function loadBrandContext(sql: postgres.Sql): Promise<BrandContext> {
  const shops = (await sql<{ id: number; slug: string; name: string; base_url: string | null }[]>`
    select id, slug, name, base_url from shops`).map((s) => ({ id: s.id, slug: s.slug, name: s.name, baseUrl: s.base_url }));
  const rows = await sql<{ shop_id: number; brand: string; title: string }[]>`
    select sp.shop_id, sp.brand, sp.title
    from site_products sp join shops s on s.id = sp.shop_id
    where s.active and not s.site_hidden and sp.updated_at > now() - interval '2 days'
      and sp.brand is not null and sp.brand <> ''`;
  return { shops, ...brandStats(rows.map((r) => ({ shopId: r.shop_id, brand: r.brand, title: r.title })), shops) };
}
