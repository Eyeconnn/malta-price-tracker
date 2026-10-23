// The identity of a candidate group (candidate_key: which listings) and of what Claude saw (fingerprint: their
// titles and variant titles). The judge skips a group whose stored fingerprint is current; the site build uses a
// judgement only while its fingerprint still matches the listings.
import { createHash } from 'node:crypto';

export type MemberRef = { shopId: number; groupKey: string };
export type MemberText = MemberRef & { title: string; variantTitles: string[] };

export const memberRef = (m: MemberRef) => `${m.shopId}|${m.groupKey}`;

/** A title in the one spelling the fingerprint and the stored members use. */
export const normText = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const norm = normText;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** "c" and 32 hex characters of the sha256 of the sorted member refs (shop id and group key). */
export function candidateKey(members: MemberRef[]): string {
  return `c${sha([...new Set(members.map(memberRef))].sort().join('\n')).slice(0, 32)}`;
}

/** sha256 of every member's ref, normalised title and sorted normalised variant titles, members sorted. */
export function fingerprint(members: MemberText[]): string {
  const lines = members.map((m) => {
    const variants = [...new Set(m.variantTitles.map(norm).filter((v) => v !== ''))].sort();
    return [memberRef(m), norm(m.title), ...variants].join('\u001f');
  });
  return sha(lines.sort().join('\n'));
}
