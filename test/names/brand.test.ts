import { describe, expect, it } from 'vitest';
import { basicBrandStatus, brandStatus, brandStats, distributorBrands, shopKeys, titleMaker, type BrandContext, type BrandRow, type ShopIdentity } from '../../src/names/brand.js';

// Real shops and brand values from the pilot sample (out/names/dry-20261022-222157-haiku.csv and the database).
const SHOPS: ShopIdentity[] = [
  { id: 1, slug: 'gamestore', name: 'Gamestore Malta', baseUrl: 'https://gamestore.mt' },
  { id: 2, slug: 'okfashion', name: 'OK Fashion', baseUrl: 'https://www.okfashion.com.mt' },
  { id: 3, slug: 'tezenis', name: 'Tezenis Malta', baseUrl: 'https://tezenismalta.com' },
  { id: 4, slug: 'calzedonia', name: 'Calzedonia Malta', baseUrl: 'https://calzedoniamalta.com' },
  { id: 5, slug: 'toysmalta', name: 'Toysmalta', baseUrl: 'https://toysmalta.com' },
  { id: 6, slug: 'sterling', name: 'Sterling Jewellers', baseUrl: 'https://www.sterling.com.mt' },
  { id: 7, slug: 'vanillamummy', name: 'Vanilla Mummy', baseUrl: 'https://vanillamummy.com' },
  { id: 8, slug: 'juniors', name: "Junior's", baseUrl: 'https://juniors.com.mt' },
  { id: 9, slug: 'icentre', name: 'iCentre', baseUrl: 'https://www.icentre.com.mt' },
  { id: 10, slug: 'soundvision', name: 'Sound & Vision', baseUrl: 'https://soundandvision.com.mt' },
  { id: 11, slug: 'eurosport', name: 'Eurosport', baseUrl: 'https://www.eurosport.com.mt' },
  { id: 12, slug: 'kitchenstore', name: 'The Kitchen Store', baseUrl: 'https://tks-onlinestore.com' },
  { id: 13, slug: 'swanky', name: 'Swanky Boutique', baseUrl: 'https://swankyboutique.com' },
  { id: 14, slug: 'bodyshop', name: 'The Body Shop Malta', baseUrl: 'https://thebodyshop.mt' },
  { id: 15, slug: 'hudsonstore', name: 'Hudsonstore', baseUrl: 'https://hudsonstore.com' },
  { id: 16, slug: 'epic', name: 'Epic', baseUrl: 'https://www.epic.com.mt' },
  { id: 17, slug: 'retail', name: 'Retail International', baseUrl: 'https://retail.com.mt' },
  { id: 18, slug: 'toytastic', name: 'Toytastic Malta', baseUrl: 'https://toytasticmalta.com' },
];
const shop = (slug: string) => SHOPS.find((s) => s.slug === slug)!.id;

const rows = (shopId: number, brand: string, titles: string[]): BrandRow[] => titles.map((title) => ({ shopId, brand, title }));
const ROWS: BrandRow[] = [
  // a distributor: every title names another maker (Childs Farm), never M&Z
  ...rows(shop('vanillamummy'), 'M&Z', [
    'Childs Farm Nappy Cream 100ml', 'Childs Farm After Sun Lotion 100ml', 'Childs Farm Spray Sun Lotion 50+ SPF Fragrance-Free 100ml',
    'Childs Farm Sun Cream 50+ SPF Fragrance-Free 200ml', 'Childs Farm Baby Oil Coconut Oil 75ml', 'Childs Farm Baby Moisturiser Mildly Fragranced 200ml',
  ]),
  ...rows(shop('vanillamummy'), 'Childs Farm', ['Childs Farm Hair Detangler 125ml']),
  // the shop's own label leads every title (TKS is The Kitchen Store, tks-onlinestore.com), never Atmosphera
  ...rows(shop('kitchenstore'), 'Atmosphera', [
    'TKS \u2013 Caf\u00e9 Bowl Beige', 'TKS \u2013 Rope Face Cushion Cover 40x40cm', 'TKS \u2013  Chair cushion Taupe', 'TKS \u2013 Vase Terracotta H18 x D12.8',
    'TKS \u2013 Placemat Natural Cuba D38', 'TKS \u2013 Cushion Unicorn with Pompom', 'TKS \u2013 Luca Tea Tree Essential Oil 30ml',
  ]),
  // a real maker at a one-brand shop: titles name the product, not a maker
  ...rows(shop('hudsonstore'), 'MANGO', [
    'Strapless straight-neck top', 'Ribbed Knit Dress With Opening', 'Short-Sleeved T-Shirt With Shoulder Pads', 'Paris Super Slim Fit Suit Blazer',
    'Printed Detail T-Shirt', 'Houndstooth Linen Jacket',
  ]),
  // a real maker whose titles all start with its product line (Galaxy), which is no other maker's name
  ...rows(shop('epic'), 'Samsung', ['Galaxy S25 Ultra', 'Galaxy A56 5G', 'Galaxy Tab S10', 'Galaxy Watch 8', 'Galaxy Buds 3 Pro', 'Galaxy Z Flip 7']),
  // real makers at a multi-brand shop
  ...rows(shop('eurosport'), 'Adidas Performance', [
    'Running Adizero HEAT.RDY Socks', 'Adizero Evo Sl Shoes', 'FC Bayern 26/27 Home Shorts', 'Colour Pop Tracksuit Kids', 'Kit 3-Stripes Hoodie',
  ]),
  ...rows(shop('retail'), 'Marks & Spencer', ['M&S Easy Cook Long Grain Rice 1kg', 'M&S Basmati Rice 500g', 'Super Soft Reusable Cleansing Cloths', 'Cotton Rich Textured Half Zip Sweatshirt', 'Go Balance Foldover Waist Flared Leggings']),
  // a distributor whose titles lead with other makers' names
  ...rows(shop('toytastic'), 'Alfred Gera', ['Munchkin White Hot Bowls \u2013 3Pk', 'Munchkin Caterpillar Spillers', 'Avent Soother 0-6 GIRL', 'Munchkin Splash Cutlery \u2013 18m+', 'Avent Soother 0-6 NEUTRAL']),
  ...rows(shop('juniors'), 'Munchkin', ['Munchkin Bath Duck']),
  ...rows(shop('juniors'), 'Avent', ['Avent Natural Bottle 260ml']),
];
const CTX: BrandContext = { shops: SHOPS, distributors: distributorBrands(ROWS, SHOPS) };

describe('shopKeys', () => {
  it('takes the slug, the name and the web address labels of a shop, without www and the top-level domain', () => {
    expect(shopKeys(SHOPS.find((s) => s.slug === 'kitchenstore')!)).toEqual(expect.arrayContaining(['kitchenstore', 'thekitchenstore', 'tksonlinestore']));
    expect(shopKeys(SHOPS.find((s) => s.slug === 'tezenis')!)).toEqual(expect.arrayContaining(['tezenis', 'tezenismalta']));
  });
});

describe('brandStatus: which brand values name the maker', () => {
  const status = (brand: string | null, slug: string) => brandStatus(brand, shop(slug), CTX).status;

  it('treats the shop name, slug or web address as unreliable (GameStore.mt, OKFASHION.COM.MT, Toysmalta, iCentre, The Body Shop)', () => {
    expect(status('GameStore.mt', 'gamestore')).toBe('unreliable');
    expect(status('OKFASHION.COM.MT', 'okfashion')).toBe('unreliable');
    expect(status('Toysmalta', 'toysmalta')).toBe('unreliable');
    expect(status('iCentre', 'icentre')).toBe('unreliable');
    expect(status('BodyShopMalta', 'bodyshop')).toBe('unreliable');
    // another tracked shop's name is a supplier label too
    expect(status('Swanky Boutique', 'vanillamummy')).toBe('unreliable');
  });

  it('treats company and place words as unreliable (Tezenis Malta, Calzedonia Malta, Sterling Holdings, ADDO PLAY LTD, Carnival S.R.L., Bart Ent)', () => {
    expect(status('Tezenis Malta', 'tezenis')).toBe('unreliable');
    expect(status('Calzedonia Malta', 'calzedonia')).toBe('unreliable');
    expect(status('Sterling Holdings', 'sterling')).toBe('unreliable');
    expect(status('ADDO PLAY LTD', 'juniors')).toBe('unreliable');
    expect(status('Carnival S.R.L.', 'toysmalta')).toBe('unreliable');
    expect(status('Bart Ent', 'toytastic')).toBe('unreliable');
  });

  it('flags a distributor from the shop data: its titles name other makers or the shop label, never it (M&Z, Atmosphera, Alfred Gera)', () => {
    expect(status('M&Z', 'vanillamummy')).toBe('unreliable');
    expect(status('Atmosphera', 'kitchenstore')).toBe('unreliable');
    expect(status('Alfred Gera', 'toytastic')).toBe('unreliable');
    expect(brandStatus('M&Z', shop('vanillamummy'), CTX).why).toMatch(/distributor/);
  });

  it('flags a short code that no title of the shop contains, even when the makers in its titles are not in the brand column (M&Z)', () => {
    const only = rows(shop('vanillamummy'), 'M&Z', ['Childs Farm Nappy Cream 100ml', 'Childs Farm After Sun Lotion 100ml', 'Childs Farm Baby Oil Coconut Oil 75ml', 'Childs Farm Sun Cream 50+ SPF Fragrance-Free 200ml', 'Childs Farm Baby Moisturiser Mildly Fragranced 200ml']);
    const ctx: BrandContext = { shops: SHOPS, distributors: distributorBrands(only, SHOPS) };
    expect(brandStatus('M&Z', shop('vanillamummy'), ctx).status).toBe('unreliable');
    // JBL is a short brand too, but its titles carry it
    const jbl = rows(shop('soundvision'), 'JBL', ['JBL Tune 500', 'JBL Flip 6', 'JBL Charge 5', 'Quantum 100 M2 Gaming Headset', 'JBL Go 4']);
    expect(brandStatus('JBL', shop('soundvision'), { shops: SHOPS, distributors: distributorBrands(jbl, SHOPS) }).status).toBe('reliable');
  });

  it('keeps real makers reliable, also at one-brand shops and when titles start with a product line (MANGO, Samsung Galaxy, Adidas Performance, Marks & Spencer)', () => {
    expect(status('MANGO', 'hudsonstore')).toBe('reliable');
    expect(status('Samsung', 'epic')).toBe('reliable');
    expect(status('Adidas Performance', 'eurosport')).toBe('reliable');
    expect(status('Marks & Spencer', 'retail')).toBe('reliable');
    expect(status('Superior Electronics', 'soundvision')).toBe('reliable');
    expect(status('VTECH KIDS', 'juniors')).toBe('reliable');
    expect(status('Childs Farm', 'vanillamummy')).toBe('reliable');
  });

  it('calls the shop name a house brand when nearly all the shop\'s groups carry it (Calzedonia, Tezenis, Samsonite): not required, may be added', () => {
    const shops: ShopIdentity[] = [...SHOPS, { id: 30, slug: 'samsonite', name: 'Samsonite Malta', baseUrl: 'https://www.samsonite.mt' }];
    const house: BrandRow[] = [
      ...rows(shop('calzedonia'), 'Calzedonia Malta', ['15 Denier Matt Sheer Hold-Ups', 'First Class Soft Touch Top', 'Newborn Eco Cotton Tights']),
      ...rows(30, 'Samsonite', ['Securipak 2.0 Laptop Backpack 15.6" - Light Sage', 'HI-FI Spinner Suitcase 55cm - Sand', 'Respark Laptop Shoulder Bag', 'Re-Lite Climbing Ivy Beauty Case']),
      ...rows(30, 'American Tourister', ['Urban Groove Arctic Grey Laptop Backpack 15.6"']),
      // a retailer that uses its own name for a share of its groups only
      ...rows(shop('toysmalta'), 'Toysmalta', ['46834 Frozen 16"', '46840 Disney Princess 16"']),
      ...rows(shop('toysmalta'), 'Carnival S.R.L.', ['63708 Little Red Riding Hood', '63711 Pirate Costume', '63712 Witch Costume']),
      ...rows(shop('gamestore'), 'GameStore.mt', ['Far Cry Instincts (Xbox) (Pre-owned)', 'TV Superstars (PS3) (Pre-owned)']),
    ];
    const ctx: BrandContext = { shops, ...brandStats(house, shops) };
    expect(brandStatus('Calzedonia Malta', shop('calzedonia'), ctx)).toEqual({ status: 'house', why: "the shop's own brand", name: 'Calzedonia' });
    expect(brandStatus('Samsonite', 30, ctx).status).toBe('house');
    expect(brandStatus('American Tourister', 30, ctx).status).toBe('reliable');
    expect(brandStatus('Toysmalta', shop('toysmalta'), ctx).status).toBe('unreliable');
    expect(brandStatus('GameStore.mt', shop('gamestore'), ctx).status).toBe('unreliable');
  });

  it('treats internal labels with words such as Accessories or Boutique as unreliable (T - Accessories)', () => {
    expect(status('T - Accessories', 'retail')).toBe('unreliable');
  });

  it('has no brand for empty, placeholder or number-only values (Women\'secret uses product numbers)', () => {
    expect(status(null, 'retail')).toBe('none');
    expect(status('Generic', 'retail')).toBe('none');
    expect(status('4993716', 'retail')).toBe('none');
  });

  it('works without shop data for the shop-independent part', () => {
    expect(basicBrandStatus('GameStore.mt')).toBe('unreliable');
    expect(basicBrandStatus('Sterling Holdings')).toBe('unreliable');
    expect(basicBrandStatus('Lenovo')).toBe('reliable');
    expect(basicBrandStatus('8325181')).toBe('none');
  });
});

// Distributors the first rule missed in the rerun out/names/dry-20261023-073704-haiku.csv (Toytastic): their titles
// start with makers that no shop has as a brand value (Avent, Lansinoh, Woomax, Winfun), but those words start titles
// under two or more brand values of the catalogue and almost never stand anywhere else in a title.
describe('distributors whose titles name makers outside the brand column (Alfred Gera, IK, Colorbaby)', () => {
  const T = shop('toytastic');
  const E = shop('eurosport');
  const KLIKK = 40;
  const shops: ShopIdentity[] = [...SHOPS, { id: KLIKK, slug: 'klikk', name: 'Klikk', baseUrl: 'https://www.klikk.com.mt' }];
  const data: BrandRow[] = [
    ...rows(T, 'Alfred Gera', ['Munchkin Miracle Trainer Cup 6m+', 'Avent Natural Glass 120ml Bottle', 'Avent Responsive Natural 260ml White Koala Bottle', 'Avent Responsive Natural Air Free 125ml', 'Angelcare Dress Up Nappy Bin', 'Angelcare Soft-Touch Bath Support Grey', 'Avent Bendi Straw Cup 300ml Green/Pink']),
    ...rows(T, 'IK', ['TOYZ Beetle Ride On Push Car Green/Blue/Purple/Pink', 'Sensillo Jersey Waterproof 60x120 Fitted Sheet White/Grey', 'Lansinoh Lanolin Nipple Cream \u2013 40ML/10ML', 'Fridamom Postpartum Peri Intimate Wash', 'TOYZ Mercedes C Class Black/White/Blue/Red', 'Avent Sterilizer & Dryer', 'Lansinoh Breast Pads 60pcs', "Mom's Stroller Bag Carmen Beige"]),
    ...rows(T, 'babyimports', ['Lansinoh Nipple Shields', 'Tommee Tippee Closer To Nature Complete Feeding Set White', 'Munchkin Click Lock Bowls', 'Munchkin White Hot Spoons', 'Lansinoh Postpartum Wash Bottle', 'Fridamom Nipple Balm', 'Fridamom Peri Bottle']),
    ...rows(T, 'Colorbaby', ['Spidey Amazing Friends Bucket Set', 'Woomax Wooden Kitchen With Accessories 57X30X85', 'Woomax Disney Mickey & Minnie Magnetic Wooden Maze 22x22cm', 'Winfun Pop UP Monkey Camera', 'Paw Patrol My First Laptop', 'Aqua World Unicorn Water Gun 35cm']),
    ...rows(T, 'Cousins', ['Winfun Newborn Gift Toy Set 4pc', 'Winfun Baby Phone', 'Clementoni Baby Fun Vehicles', 'Water And Sand Game Table']),
    ...rows(T, 'Small Foot', ['Woomax Electric Supermarket With Lights And Sound', 'Small-Foot Children\'s Play Kitchen Gourmet Pink', 'Small-Foot Guitar "Sound"']),
    // real makers: shoe model lines of one brand (Hoka) and a product line under a maker that other shops' titles name (Samsung)
    ...rows(E, 'Hoka', ['Clifton 11 Gtx Running Shoes', 'Tecton X 2 Running Shoes', 'Clifton 11 Running Shoes', 'Ora Recovery Slides 3', 'Bondi 9 Running Shoes (Wide Fit)', 'Mach 7 Running Shoes', 'Bondi 9 Running Shoes']),
    ...rows(shop('epic'), 'Samsung', ['Galaxy S25 Ultra', 'Galaxy A56 5G', 'Galaxy Tab S10', 'Galaxy Watch 8', 'Galaxy Buds 3 Pro']),
    ...rows(KLIKK, 'Samsung', ['Samsung Galaxy S25 Ultra 256GB', 'Samsung Galaxy Tab S10 128GB', 'Samsung Galaxy A56 5G 128GB']),
    ...rows(KLIKK, 'Galaxy Cases', ['Galaxy S25 Clear Case']),
  ];
  const ctx: BrandContext = { shops, ...brandStats(data, shops) };

  it('flags Alfred Gera, IK and Colorbaby at Toytastic', () => {
    expect(brandStatus('Alfred Gera', T, ctx).status).toBe('unreliable');
    expect(brandStatus('IK', T, ctx).status).toBe('unreliable');
    expect(brandStatus('Colorbaby', T, ctx).status).toBe('unreliable');
  });

  it('keeps Hoka and Samsung reliable (model lines; a maker other shops name in their titles)', () => {
    expect(brandStatus('Hoka', E, ctx).status).toBe('reliable');
    expect(brandStatus('Samsung', shop('epic'), ctx).status).toBe('reliable');
  });
});

describe('titleMaker: a maker the title starts with, which the name must keep', () => {
  const data: BrandRow[] = [
    { shopId: 1, brand: 'Therabody', title: 'Therabody TheraFace PRO 6-in-1 Facial Health Device - Black' },
    { shopId: 1, brand: 'Theragun', title: 'Theragun Prime G5 Muscle Stimulator' },
    { shopId: 1, brand: 'Paw Patrol', title: 'Paw Patrol Lookout Tower' },
    { shopId: 1, brand: 'Kids', title: 'Kids Beauty Vanity Table' },
  ];
  const ctx: BrandContext = { shops: SHOPS, ...brandStats(data, SHOPS) };

  it('finds the first word or the first two words when they are a brand that its own titles carry', () => {
    expect(titleMaker('Therabody TheraCup (Single)', ctx)).toBe('Therabody');
    expect(titleMaker('Paw Patrol My First Laptop', ctx)).toBe('Paw Patrol');
    expect(titleMaker('Kids Beauty Vanity Table + Stool White', ctx)).toBeNull();
    expect(titleMaker('Angelcare Dress Up Nappy Bin', ctx)).toBeNull();
  });
});
