import { createRequire } from 'node:module';

interface Robot {
  isAllowed(url: string, ua?: string): boolean | undefined;
  getCrawlDelay(ua?: string): number | undefined;
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
}

/** Product token used for robots.txt group matching, e.g. "MaltaPriceTracker/0.1 (...)" gives "maltapricetracker". */
export function productToken(ua: string): string {
  // "Mozilla/5.0 (compatible; MTPIndex/1.0)" gives "mtpindex"; "Foo/1.0 (...)" gives "foo"
  const compatible = /compatible;\s*([^\/;\s)]+)/i.exec(ua);
  return (compatible ? compatible[1]! : ua.split(/[\/\s]/)[0]!).toLowerCase();
}

/**
 * Parses robots.txt text. Only real crawl directives matter: robots-parser reads
 * User-agent / Allow / Disallow / Crawl-delay / Sitemap lines and ignores everything else,
 * including any prose addressed at bots or AI agents.
 */
export function parseRobots(origin: string, text: string, ua: string, status: RobotsRules['status'] = 'ok'): RobotsRules {
  const robotsUrl = `${origin}/robots.txt`;
  const parser = robotsParser(robotsUrl, text);
  const token = productToken(ua);
  const delay = parser.getCrawlDelay(token);
  return {
    origin,
    status,
    crawlDelayMs: typeof delay === 'number' && delay > 0 ? Math.round(delay * 1000) : 0,
    isAllowed(url: string) {
      if (status === 'unreachable') return false;
      const verdict = parser.isAllowed(url, token);
      // undefined means the URL is on another origin; callers check that origin's robots instead
      return verdict !== false;
    },
  };
}
