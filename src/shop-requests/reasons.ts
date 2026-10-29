// Why a shop cannot be tracked, in words a visitor understands (Suggest a shop on /shops, owner request 29 Oct 2026).
// Stored as a short code: shop_requests.reason (set by the PC check, process.ts) and shops.unavailable_reason (set in
// shops.seed.json for shops switched off by hand). The Worker turns the code into the text below; the raw error and
// the owner's notes never reach a visitor. Pure.

export const UNAVAILABLE_REASONS = ['robots', 'bot_protection', 'crawl_delay', 'rate_limited', 'not_readable', 'not_found', 'needs_setup', 'declined'] as const;
export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number];

export const isUnavailableReason = (v: unknown): v is UnavailableReason => (UNAVAILABLE_REASONS as readonly unknown[]).includes(v);

/** The project's rules every explanation rests on. */
export const SCOPE_NOTE =
  'This guide only reads public pages a shop allows, one page at a time at a slow, polite pace, and never gets around a block or a bot check.';

export const REASON_TEXT: Record<UnavailableReason, { title: string; text: string }> = {
  robots: {
    title: 'The shop asks crawlers to stay away',
    text: "This shop's robots.txt file asks automated visitors like ours not to read its pages, or the pages with its products and prices. We always respect that, so we cannot track this shop.",
  },
  bot_protection: {
    title: 'The shop blocks automated visitors',
    text: 'This shop answers our checker with an access-denied page or a bot check. We never get around protections like that, so we cannot track this shop unless it lets our checker in.',
  },
  crawl_delay: {
    title: 'The shop asks for very long pauses',
    text: 'This shop asks crawlers to wait so long between pages that its catalogue could not be read in a night while keeping to its request.',
  },
  rate_limited: {
    title: 'The shop kept asking us to slow down',
    text: 'During our check this shop repeatedly asked us to slow down. We stop rather than push, so it could not be added.',
  },
  not_readable: {
    title: 'Not enough products could be read',
    text: 'We reached the shop but could not read enough products with a name and a price to compare them reliably.',
  },
  not_found: {
    title: 'No working shop at this address',
    text: "We could not reach a working online shop at this address. Check the address, or suggest the shop's main website.",
  },
  needs_setup: {
    title: 'This shop needs a manual setup',
    text: 'This shop runs on a system we cannot add automatically. It is on the list to be set up by hand, which can take a while.',
  },
  declined: {
    title: 'Not added',
    text: 'The site owner decided not to add this shop.',
  },
};
