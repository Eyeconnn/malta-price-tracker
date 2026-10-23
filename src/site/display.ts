// How a clean name and its specs summary are written together (design Part 3). No imports, so the browser bundle
// can use it without the attribute schemas.

/** "Samsung Galaxy S25 Ultra Smartphone · 256GB", or the name alone without a summary. */
export function withSpecs(name: string, summary: string | null): string {
  return summary ? `${name} \u00b7 ${summary}` : name;
}
