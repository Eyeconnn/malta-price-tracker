// A stand-in for ShopFetcher that answers from recorded responses (test/fixtures/shop-requests) and behaves
// like the real one: robots.txt is obeyed, 200/404/410 are returned, other statuses throw HttpError.
import { readFileSync } from 'node:fs';
import { DisallowedError, type FetchResult, HttpError, OutOfScopeError, parseJsonLenient, scopeHost } from '../../src/http/fetcher.js';
import { parseRobots, type RobotsRules } from '../../src/http/robots.js';

export const UA = 'MTPIndex/1.0 (price index crawler)';

export const fixture = (name: string) => readFileSync(new URL(`../fixtures/shop-requests/${name}`, import.meta.url), 'utf8');

export type Recorded = { status?: number; body?: string; headers?: Record<string, string>; redirectTo?: string } | Error;

/** routes keyed by full URL (origin + path + query); robots by origin ('' or missing: no robots.txt) */
export function fakeFetcher(origin: string, routes: Record<string, Recorded>, robots: Record<string, string | null> = {}) {
  const requests: string[] = [];
  const scope = scopeHost(origin);
  const cache = new Map<string, RobotsRules>();
  const robotsFor = async (url: string) => {
    const o = new URL(url).origin;
    let r = cache.get(o);
    if (!r) {
      requests.push(`${o}/robots.txt`);
      const text = robots[o];
      r = text === undefined || text === null ? parseRobots(o, '', UA, 'none') : parseRobots(o, text, UA, 'ok');
      cache.set(o, r);
    }
    return r;
  };
  const get = async (start: string): Promise<FetchResult> => {
    let url = start;
    for (let hop = 0; hop < 6; hop++) {
      const host = new URL(url).hostname;
      if (host !== scope && !host.endsWith(`.${scope}`)) throw new OutOfScopeError(url);
      if (!(await robotsFor(url)).isAllowed(url)) throw new DisallowedError(url);
      requests.push(url);
      const rec = routes[url] ?? { status: 404, body: 'not found' };
      if (rec instanceof Error) throw rec;
      if (rec.redirectTo) {
        url = new URL(rec.redirectTo, url).toString();
        continue;
      }
      const status = rec.status ?? 200;
      if (![200, 203, 204, 206, 404, 410].includes(status)) throw new HttpError(url, status);
      const body = Buffer.from(rec.body ?? '', 'utf8');
      return {
        url,
        status,
        headers: new Headers(rec.headers ?? {}),
        body,
        text: () => body.toString('utf8'),
        json: <T>() => parseJsonLenient(body.toString('utf8')) as T,
      };
    }
    throw new Error('too many redirects');
  };
  return { requests, robotsFor, get };
}
