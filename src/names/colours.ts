// Colour words, the one list the judge's veto (src/match/veto.ts), its splitting (src/match/candidates.ts) and the
// site build's colour-sibling rule (src/site/matching.ts colourSiblings) share. A colour is a variant option, not part
// of a product's name; two titles that differ only in colour words name one product in two colours.

/** Colour words (a marketing colour name next to "titanium" keeps it a colour: Natural Titanium). */
export const COLOURS = new Set(
  ('black white silver grey gray blue red green pink purple gold yellow orange beige brown navy natural desert midnight starlight ' +
    'graphite space sage mist lavender cream rose violet teal mint coral obsidian porcelain jet onyx phantom cobalt icy amber marble ' +
    'silverblue jetblack titaniumblack whitesilver').split(' '),
);

/**
 * Words that make one colour name with the colour word right after them (Deep Blue, Cosmic Orange, Sky Blue, Jet
 * Black, Space Grey, Light Pink, Icy Blue, Rose Gold). Only these are left out with the colour: never a word that
 * names a model, a line or a part (Titanium, Edge, Classic, Fold, Pro, eSIM, Left, Right, Fabric, Braided, Nylon,
 * Matte, Clear), so titles differing in such a word stay different.
 */
export const COLOUR_MODIFIERS = new Set(
  'deep cosmic sky jet space light dark ice icy pale midnight rose mint misty desert ocean arctic frost frosted soft bright hot royal pacific sierra'.split(' '),
);

/** The words (lower case, in order) without colour words and the colour modifier right before each. */
export function withoutColourWords(words: string[]): string[] {
  const drop = new Set<number>();
  words.forEach((w, i) => {
    if (!COLOURS.has(w)) return;
    drop.add(i);
    if (i > 0 && COLOUR_MODIFIERS.has(words[i - 1])) drop.add(i - 1);
  });
  return words.filter((_, i) => !drop.has(i));
}

/** The colour words among the words, sorted, once each. */
export const colourWordsIn = (words: string[]) => [...new Set(words.filter((w) => COLOURS.has(w)))].sort();
