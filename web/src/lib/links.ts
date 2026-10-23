// Links to product pages.

/**
 * The product page of one shop's listing (site_products id), with that listing marked: the page moves to the
 * product's own key and keeps ?seller=.
 */
export const listingPath = (id: number) => `/product/s${id}?seller=${id}`;
