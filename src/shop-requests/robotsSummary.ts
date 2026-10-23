// What robots.txt says about a requested shop, as stored on the request and shown on the Add shop page.
import type { RobotsRules } from '../http/robots.js';

export interface RobotsSummary {
  /** 'ok' parsed, 'none' no robots.txt (allow all), 'unreachable' server errors (disallow all) */
  status: RobotsRules['status'];
  /** every checked path is allowed for our user agent */
  allowed: boolean;
  /** Crawl-delay for our agent in seconds (0: none); obeyed by the fetcher */
  crawlDelaySeconds: number;
  checked: { path: string; allowed: boolean; rule: string | null }[];
  /** the first checked path that is disallowed, with the robots.txt line that blocks it */
  blockedBy: { path: string; rule: string } | null;
}

/** Checks each path (home page, product feed) of origin against the parsed rules. */
export function summariseRobots(rules: RobotsRules, origin: string, paths: string[]): RobotsSummary {
  const checked = paths.map((path) => {
    const url = new URL(path, origin).toString();
    const allowed = rules.isAllowed(url);
    return { path, allowed, rule: allowed ? null : (rules.blockingRule(url) ?? 'disallowed') };
  });
  const first = checked.find((c) => !c.allowed);
  return {
    status: rules.status,
    allowed: !first,
    crawlDelaySeconds: Math.round(rules.crawlDelayMs / 100) / 10,
    checked,
    blockedBy: first ? { path: first.path, rule: first.rule! } : null,
  };
}
