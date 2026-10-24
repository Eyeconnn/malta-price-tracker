// The was price a shopper actually sees struck through, for shops whose shown reference price differs from their
// feed's regular price (migration 015). AtoZ's Store API gave regular_price 809.00 for the Lenovo V15 G5 IRL while its
// page showed "List Price" 969.00 struck through, under the price name "Black Friday".
import * as cheerio from 'cheerio';
import type { ShopConfig } from '../types.js';
import { toCents } from '../util/normalise.js';

/**
 * shops.seed.json config.shown_was:
 *
 *   source           where the shown price markup comes from. 'price_html': the Woo Store API's price_html field,
 *                    the same markup the shop prints on its product pages and listing cards, so it costs no
 *                    extra request (it arrives with every listing page and every single-product read).
 *   selector         CSS selector of the element holding the struck-through reference price (".atoz-price__list")
 *   label_selector   CSS selector of the price's name (".atoz-price__name": "Black Friday", "Cash Price"); recorded
 *                    as the observation's badge text, where the Black Friday marker detection reads it
 *   ignore_selector  removed before anything is read: member or login prices (".atoz-price__teaser", zOnePRICE)
 */
export interface ShownWasConfig {
  source: 'price_html';
  selector: string;
  label_selector?: string;
  ignore_selector?: string;
}

const SOURCES = new Set(['price_html']);

/** The shop's shown_was config, or null when it has none. A malformed config throws (it is a seed file mistake). */
export function shownWasConfig(cfg: ShopConfig): ShownWasConfig | null {
  const raw = cfg.shown_was;
  if (raw === undefined || raw === null) return null;
  const c = raw as Partial<ShownWasConfig>;
  if (typeof c !== 'object' || !SOURCES.has(String(c.source))) {
    throw new Error(`config.shown_was.source must be one of ${[...SOURCES].join(', ')}`);
  }
  if (typeof c.selector !== 'string' || !c.selector.trim()) throw new Error('config.shown_was.selector is required');
  return c as ShownWasConfig;
}

export interface ShownWas {
  /** the shown struck-through price above the price, in cents; null when none is shown (or it is not above the price) */
  wasCents: number | null;
  /** the shown price name, e.g. "Black Friday" */
  label: string | null;
  /**
   * selector     read from the configured element
   * struck_feed  the configured element was missing, but the markup strikes through exactly the feed's regular price
   * none         nothing usable shown: the was price is unknown, never the feed value
   * no_html      the feed carried no price markup
   */
  found: 'selector' | 'struck_feed' | 'none' | 'no_html';
}

const AMOUNT = /\d[\d.,]*/;

function amountOf(text: string): number | null {
  const m = AMOUNT.exec(text.replace(/\s+/g, ' '));
  return m ? toCents(m[0]) : null;
}

/**
 * Reads the shown was price from the price markup. Member and login prices are removed first (ignore_selector).
 * When the configured element is missing, the feed's regular price is used only if the markup itself strikes it
 * through (a <del>, <s> or <strike> showing that amount); otherwise the was price is unknown (null), never a value
 * shoppers did not see.
 */
export function readShownWas(
  markup: string | null | undefined,
  cfg: ShownWasConfig,
  priceCents: number | null,
  feedRegularCents: number | null,
): ShownWas {
  if (!markup || !markup.trim()) return { wasCents: null, label: null, found: 'no_html' };
  const $ = cheerio.load(markup, null, false);
  if (cfg.ignore_selector) $(cfg.ignore_selector).remove();

  const labelText = cfg.label_selector ? $(cfg.label_selector).first().text().replace(/\s+/g, ' ').trim() : '';
  const label = labelText ? labelText.slice(0, 100) : null;
  const above = (c: number | null) => (c !== null && c > 0 && (priceCents === null || c > priceCents) ? c : null);

  const el = $(cfg.selector).first();
  if (el.length) {
    // the first price amount inside the element when the shop marks it up (Woo's .amount), else the element's text
    const amount = el.find('.amount').first();
    const cents = amountOf((amount.length ? amount : el).text());
    return { wasCents: above(cents), label, found: cents === null ? 'none' : 'selector' };
  }

  if (feedRegularCents !== null) {
    const struck = $('del, s, strike')
      .toArray()
      .map((d) => amountOf($(d).text()));
    if (struck.includes(feedRegularCents)) return { wasCents: above(feedRegularCents), label, found: 'struck_feed' };
  }
  return { wasCents: null, label, found: 'none' };
}
