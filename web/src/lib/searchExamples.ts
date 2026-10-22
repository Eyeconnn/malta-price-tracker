// Example searches the main search box types as its placeholder (useTypingPlaceholder.ts).
import { type CategorySlug, SITE_CATEGORIES } from '../../../src/site/categories.js';

/** Curated, keyed by the site's category slugs: things a Maltese shopper would type. */
export const SEARCH_EXAMPLES: Readonly<Record<CategorySlug, readonly string[]>> = {
  laptops: ['MacBook Air M3', 'Lenovo IdeaPad', 'Gaming laptop', 'HP 15 laptop', 'Chromebook'],
  phones: ['iPhone 17', 'Samsung Galaxy S25', 'iPad 11', 'Xiaomi Redmi Note', 'Pixel 10'],
  'tv-audio': ['55 inch TV', 'Soundbar', 'AirPods Pro', 'Sony headphones', 'JBL speaker', 'Samsung OLED'],
  gaming: ['PS5 controller', 'Nintendo Switch 2', 'Xbox Series X', 'Gaming headset', 'FC 26'],
  appliances: ['Air fryer', 'Dyson V15', 'Nespresso machine', 'Washing machine', 'Robot vacuum', 'Microwave'],
  toys: ['LEGO Technic', 'Barbie dreamhouse', 'Hot Wheels', 'Playmobil', 'Board game'],
  baby: ['Baby car seat', 'Pram', 'Baby monitor', 'Nappies size 4', 'High chair'],
  fashion: ['Nike Air Max', 'Adidas Samba', "Levi's 501", 'Casio watch', 'Ray-Ban sunglasses'],
  'beauty-health': ['Philips shaver', 'Perfume', 'Vitamin D', 'Hair dryer', 'Electric toothbrush'],
  'home-kitchen': ['Memory foam mattress', 'Pressure cooker', 'Standing fan', 'Dinner set', 'Sofa bed'],
  sports: ['Treadmill', 'Road bike', 'Yoga mat', 'Camping tent', 'Dumbbell set', 'Football'],
  drinks: ['Prosecco', 'Cisk lager', 'Single malt whisky', 'Gin', 'Red wine'],
  other: ['Suitcase', 'Backpack', 'Gift card', 'Printer', 'Power bank'],
};

export type Example = { category: CategorySlug; text: string };

const SLUGS = SITE_CATEGORIES.map((c) => c.slug);

const pick = <T>(list: readonly T[], random: () => number): T => list[Math.min(list.length - 1, Math.floor(random() * list.length))]!;

/**
 * The example after one from `previous` (null at the start). The category cycles through the
 * site's categories, so two in a row never share one; the first category and the item within a
 * category come from `random`.
 */
export function nextExample(previous: CategorySlug | null, random: () => number = Math.random): Example {
  const category = previous === null ? pick(SLUGS, random) : SLUGS[(SLUGS.indexOf(previous) + 1) % SLUGS.length]!;
  return { category, text: pick(SEARCH_EXAMPLES[category], random) };
}

/** One example from a random category, for people who asked for reduced motion. */
export function staticExample(random: () => number = Math.random): string {
  return nextExample(null, random).text;
}
