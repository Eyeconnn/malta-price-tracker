// The one spelling of the canonical name check (src/names/canonical.ts) and the title guard of name matching
// (src/site/matching.ts). Its own module so matching never imports the name checks.
import { prep } from './text.js';

const ROMAN: Record<string, string> = { ii: '2', iii: '3', iv: '4', vi: '6', vii: '7', viii: '8', ix: '9' };

/**
 * A text in the one spelling both sides of the check and the canonical name use: prepped (case, accents, units), and
 * "Eau de Parfum" is EDP, "PlayStation 5" is PS5, "3rd Gen" is 3, "II" is 2, "In-Ear" one word, "Copilot + PC" the
 * Copilot+ PC label (no bundle), "Building Set" filler.
 */
export function canonText(s: string): string {
  return prep(s)
    .replace(/\beau\s+de\s+parfum\b/g, ' edp ')
    .replace(/\beau\s+de\s+toilette\b/g, ' edt ')
    .replace(/\beau\s+de\s+cologne\b/g, ' edc ')
    .replace(/\bplay\s*station\s*([2-5])\b/g, ' ps$1 ')
    .replace(/\b(in|on|over)[\s-]ear\b/g, ' $1ear ')
    .replace(/\b(\d+)(?:st|nd|rd|th)\s+gen(?:eration)?\b/g, ' $1 ')
    .replace(/\bgen(?:eration)?\s+(\d+)\b/g, ' $1 ')
    .replace(/\b(ii|iii|iv|vi|vii|viii|ix)\b/g, (m) => ` ${ROMAN[m]} `)
    // Copilot+ PC, also written without PC ("Copilot+ 16in"): a label, not a bundle
    .replace(/\bcopilot\s*\+(?:\s*pc\b)?/g, ' copilotpc ')
    .replace(/\bbuilding\s+(?:set|kit|toy)\b/g, ' ');
}


/**
 * The memory a shop states next to a GPU ("RTX5060-8GB", "RTX 5060 8GB"), never RAM ("16GB RAM"). The gpu field
 * leaves it out; the name check drops it from the title (withoutGpuMemory) and the title guard of name matching keeps
 * it (gpuMemory), so an 8GB and a 16GB card never share a product.
 */
const GPU_MEMORY = /\b((?:rtx|gtx|rx|arc)\s*-?\s*[a-z]?\d{3,4}(?:\s*(?:ti|super|xtx|xt))?)\s*-?\s*(\d{1,2})\s*gb\b(?!\s*(?:ram|ddr\d*|lpddr\d*x?|memory|unified))/g;

/** The GPU memory amounts of a prepped (lower-case) text, as "8gb". */
export function gpuMemory(s: string): string[] {
  return [...new Set([...s.matchAll(GPU_MEMORY)].map((m) => `${Number(m[2])}gb`))].sort();
}

/** A prepped text without the GPU memory amounts (the GPU code stays). */
export function withoutGpuMemory(s: string): string {
  return s.replace(GPU_MEMORY, '$1 ');
}
