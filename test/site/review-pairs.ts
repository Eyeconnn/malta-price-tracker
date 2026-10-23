// The listing pairs of the re-review (2026-10-23): pairs the name rule merged by mistake, which must stay apart, and
// true matches, which must still match. Shared by test/site/matching.test.ts and test/site/name-match.test.ts.
export type PairListing = {
  key: string;
  shop: 'alpha' | 'beta';
  title: string;
  name: string;
  label: string | null;
  attrs: Record<string, unknown>;
  category: string;
  brand: string;
};
export type Pair = { what: string; pair: [PairListing, PairListing] };

export const APART: Pair[] = [
  {
    what: "iPhone 15 Plus vs 15",
    pair: [
      { key: "IP15P", shop: "alpha", title: "Apple iPhone 15 Plus 128GB Black", name: "Apple iPhone 15 Smartphone", label: "Plus, 128GB, Black", attrs: {"storage_gb":128}, category: "phones", brand: "Apple" },
      { key: "IP15", shop: "beta", title: "Apple iPhone 15 128GB Black", name: "Apple iPhone 15 Smartphone", label: "128GB, Black", attrs: {"storage_gb":128}, category: "phones", brand: "Apple" },
    ],
  },
  {
    what: "S24 vs S24 Ultra",
    pair: [
      { key: "S24U", shop: "alpha", title: "Samsung Galaxy S24 Ultra 256GB", name: "Samsung Galaxy S24 Smartphone", label: "Ultra, 256GB", attrs: {"storage_gb":256}, category: "phones", brand: "Samsung" },
      { key: "S24", shop: "beta", title: "Samsung Galaxy S24 256GB", name: "Samsung Galaxy S24 Smartphone", label: "256GB", attrs: {"storage_gb":256}, category: "phones", brand: "Samsung" },
    ],
  },
  {
    what: "Buds2 vs Buds2 Pro",
    pair: [
      { key: "BUDS2P", shop: "alpha", title: "Samsung Galaxy Buds2 Pro Graphite", name: "Samsung Galaxy Buds2 Earbuds", label: "Pro, Graphite", attrs: {}, category: "tv-audio", brand: "Samsung" },
      { key: "BUDS2", shop: "beta", title: "Samsung Galaxy Buds2 Graphite", name: "Samsung Galaxy Buds2 Earbuds", label: "Graphite", attrs: {}, category: "tv-audio", brand: "Samsung" },
    ],
  },
  {
    what: "Switch OLED vs Lite",
    pair: [
      { key: "SW-OLED", shop: "alpha", title: "Nintendo Switch OLED White", name: "Nintendo Switch Console", label: "OLED, White", attrs: {}, category: "gaming", brand: "Nintendo" },
      { key: "SW-LITE", shop: "beta", title: "Nintendo Switch Lite Turquoise", name: "Nintendo Switch Console", label: "Lite, Turquoise", attrs: {}, category: "gaming", brand: "Nintendo" },
    ],
  },
  {
    what: "PS5 Slim Digital vs Disc",
    pair: [
      { key: "PS5-DIG", shop: "alpha", title: "Sony PS5 Slim Digital Edition", name: "Sony PlayStation 5 Slim Console", label: "Digital", attrs: {}, category: "gaming", brand: "Sony" },
      { key: "PS5-DISC", shop: "beta", title: "Sony PS5 Slim Disc Edition", name: "Sony PlayStation 5 Slim Console", label: "Disc", attrs: {}, category: "gaming", brand: "Sony" },
    ],
  },
  {
    what: "LEGO 42115 vs + LEGO Bag",
    pair: [
      { key: "LEGO", shop: "alpha", title: "LEGO Technic 42115 Lamborghini Sian", name: "LEGO Technic 42115 Lamborghini Sian", label: null, attrs: {"model":"42115"}, category: "toys", brand: "LEGO" },
      { key: "LEGO-BAG", shop: "beta", title: "LEGO Technic 42115 Lamborghini Sian + LEGO Bag", name: "LEGO Technic 42115 Lamborghini Sian", label: null, attrs: {"model":"42115"}, category: "toys", brand: "LEGO" },
    ],
  },
  {
    what: "PS5 vs PS5 Bundle + 2 controllers",
    pair: [
      { key: "PS5", shop: "alpha", title: "Sony PS5 Console", name: "Sony PS5 Console", label: null, attrs: {}, category: "gaming", brand: "Sony" },
      { key: "PS5-BUNDLE", shop: "beta", title: "Sony PS5 Console Bundle + 2 Controllers", name: "Sony PS5 Console", label: null, attrs: {}, category: "gaming", brand: "Sony" },
    ],
  },
  {
    what: "kids vs adult shoe",
    pair: [
      { key: "AM90-K", shop: "alpha", title: "Nike Air Max 90 Kids", name: "Nike Air Max 90", label: null, attrs: {}, category: "fashion", brand: "Nike" },
      { key: "AM90", shop: "beta", title: "Nike Air Max 90", name: "Nike Air Max 90", label: null, attrs: {}, category: "fashion", brand: "Nike" },
    ],
  },
  {
    what: "Cisk 330ml vs pack of 6",
    pair: [
      { key: "CISK", shop: "alpha", title: "Cisk Lager 330ml", name: "Cisk Lager 330ml", label: null, attrs: {"volume_ml":330}, category: "drinks", brand: "Cisk" },
      { key: "CISK-6", shop: "beta", title: "Cisk Lager 330ml Pack of 6", name: "Cisk Lager 330ml", label: null, attrs: {"volume_ml":330}, category: "drinks", brand: "Cisk" },
    ],
  },
  {
    what: "Pampers 44 vs 88",
    pair: [
      { key: "PAMP-44", shop: "alpha", title: "Pampers Baby-Dry Size 4 44 Nappies", name: "Pampers Baby-Dry Size 4 Nappies", label: null, attrs: {"pack_count":44}, category: "baby", brand: "Pampers" },
      { key: "PAMP-88", shop: "beta", title: "Pampers Baby-Dry Size 4 88 Nappies", name: "Pampers Baby-Dry Size 4 Nappies", label: null, attrs: {}, category: "baby", brand: "Pampers" },
    ],
  },
  {
    what: "Ninja vs Twin Pack",
    pair: [
      { key: "NINJA", shop: "alpha", title: "Ninja Foodi Power Blender", name: "Ninja Foodi Power Blender", label: null, attrs: {}, category: "appliances", brand: "Ninja" },
      { key: "NINJA-2", shop: "beta", title: "Ninja Foodi Power Blender Twin Pack", name: "Ninja Foodi Power Blender", label: null, attrs: {}, category: "appliances", brand: "Ninja" },
    ],
  },
];

export const TOGETHER: Pair[] = [
  {
    what: "same phone at two shops",
    pair: [
      { key: "S23-A", shop: "alpha", title: "SAMSUNG Galaxy S23 256GB-Storage 8GB Smartphone, Black", name: "Samsung Galaxy S23 Smartphone", label: "256GB, 8GB, Black", attrs: {"storage_gb":256,"ram_gb":8}, category: "phones", brand: "Samsung" },
      { key: "S23-B", shop: "beta", title: "Samsung Galaxy S23 5G 256GB Phantom Black", name: "Samsung Galaxy S23 Smartphone", label: "256GB, Black", attrs: {"storage_gb":256}, category: "phones", brand: "Samsung" },
    ],
  },
  {
    what: "JW 70cl label vs 700ml attr",
    pair: [
      { key: "JW-A", shop: "alpha", title: "Johnnie Walker Black Label 70cl", name: "Johnnie Walker Black Label", label: "70cl", attrs: {}, category: "drinks", brand: "Johnnie Walker" },
      { key: "JW-B", shop: "beta", title: "Johnnie Walker Black Label Whisky 700ml", name: "Johnnie Walker Black Label", label: null, attrs: {"volume_ml":700}, category: "drinks", brand: "Johnnie Walker" },
    ],
  },
];
