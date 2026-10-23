import { createRequire } from 'node:module';

interface Robot {
  isAllowed(url: string, ua?: string): boolean | undefined;
  getCrawlDelay(ua?: string): number | undefined;
  getMatchingLineNumber(url: string, ua?: string): number | undefined;
}
// robots-parser is CommonJS and its typings do not match NodeNext default imports
const robotsParser = createRequire(import.meta.url)('robots-parser') as (url: string, txt: string) => Robot;

export interface RobotsRules {
  origin: string;
  isAllowed(url: string): boolean;
  /** Crawl-delay for our agent (or *), in milliseconds, or 0 */
  crawlDelayMs: number;
  /** 'ok' parsed, 'none' no robots.txt (allow all), 'unreachable' server error (disallow all) */
  status: 'ok' | 'none' | 'unreachable';
  /** the robots.txt line that blocks url for our agent, e.g. "Disallow: /cart (line 4)"; null when allowed */
  blockingRule(url: string): string | null;
}

/**
 * Every product token in the user agent: the leading one ("MTPIndex/1.0 (...)" gives "mtpindex")
 * plus any "compatible; Name/x" token in the comment. Rules are applied for all of them.
 */
export function productTokens(ua: string): string[] {
  const out = new Set<string>();
  const lead = ua.trim().split(/[\/\s(]/)[0];
  if (lead) out.add(lead.toLowerCase());
  for (const m of ua.matchAll(/\(\s*compatible;\s*([A-Za-z0-9_.-]+)/gi)) out.add(m[1]!.toLowerCase());
  return [...out];
}

/**
 * Parses robots.txt text. Only real crawl directives matter: robots-parser reads
 * User-agent / Allow / Disallow / Crawl-delay / Sitemap lines and ignores everything else,
 * including any prose addressed at bots or AI agents. With several tokens, the strictest
 * verdict and the longest crawl delay win.
 */
export function parseRobots(origin: string, text: string, ua: string, status: RobotsRules['status'] = 'ok'): RobotsRules {
  const robotsUrl = `${origin}/robots.txt`;
  const parser = robotsParser(robotsUrl, text);
  const tokens = productTokens(ua);
  // split as robots-parser does, so its 1-based line numbers point into this array
  const lines = text.split(/\r\n|\r|\n/);
  const delays = tokens.map((t) => parser.getCrawlDelay(t)).filter((d): d is number => typeof d === 'number' && d > 0);
  return {
    origin,
    status,
    crawlDelayMs: delays.length ? Math.round(Math.max(...delays) * 1000) : 0,
    isAllowed(url: string) {
      if (status === 'unreachable') return false;
      // false from any token blocks; undefined means another origin, whose own robots.txt is checked instead
      return !tokens.some((t) => parser.isAllowed(url, t) === false);
    },
    blockingRule(url: string) {
      if (status === 'unreachable') return 'robots.txt unreachable (server errors), treated as disallow all';
      for (const t of tokens) {
        if (parser.isAllowed(url, t) !== false) continue;
        const n = parser.getMatchingLineNumber(url, t);
        const line = n && n > 0 ? lines[n - 1]?.trim() : undefined;
        return line ? `${line.slice(0, 200)} (line ${n})` : 'disallowed';
      }
      return null;
    },
  };
}
