import { describe, expect, it } from 'vitest';
import { CATEGORY_RULES, SITE_CATEGORIES, categorize } from '../../src/site/categories.js';

function input(over: Partial<Parameters<typeof categorize>[0]> = {}): Parameters<typeof categorize>[0] {
  return { categoryPath: null, tags: [], title: null, shopCategory: null, ...over };
}

describe('SITE_CATEGORIES', () => {
  it('lists the categories in display order with names', () => {
    expect(SITE_CATEGORIES.map((c) => c.slug)).toEqual([
      'laptops', 'phones', 'tv-audio', 'gaming', 'appliances', 'toys', 'baby', 'fashion',
      'beauty-health', 'home-kitchen', 'sports', 'drinks', 'other',
    ]);
    expect(SITE_CATEGORIES.find((c) => c.slug === 'phones')?.name).toBe('Phones & tablets');
  });

  it('only has rules for known slugs', () => {
    const slugs = new Set(SITE_CATEGORIES.map((c) => c.slug));
    for (const r of CATEGORY_RULES) expect(slugs.has(r.slug)).toBe(true);
  });
});

describe('categorize', () => {
  it('uses the category path', () => {
    expect(categorize(input({ categoryPath: 'Laptops > Gaming Laptops' }))).toBe('laptops');
    expect(categorize(input({ categoryPath: 'Smart Phones' }))).toBe('phones');
  });

  it('checks the category path before the title', () => {
    expect(categorize(input({ title: 'Apple iPhone 17 256GB', categoryPath: 'Smart Phones' }))).toBe('phones');
    expect(categorize(input({ title: 'Apple iPhone 17 256GB', categoryPath: 'Laptops' }))).toBe('laptops');
  });

  it('falls back to tags then title', () => {
    expect(categorize(input({ tags: ['Soundbars'], title: 'Something' }))).toBe('tv-audio');
    expect(categorize(input({ title: 'Apple iPhone 17 256GB' }))).toBe('phones');
    expect(categorize(input({ title: 'LEGO Technic Bugatti', shopCategory: 'toys' }))).toBe('toys');
  });

  it('uses the shop category when no rule matches', () => {
    expect(categorize(input({ title: 'Corona - Case of 24', shopCategory: 'drinks' }))).toBe('drinks');
    expect(categorize(input({ categoryPath: 'Black Friday Deals', shopCategory: 'toys' }))).toBe('toys');
  });

  it('maps every shop category onto a site slug', () => {
    const expected: Record<string, string> = {
      electronics: 'other', sports: 'sports', bikes: 'sports', fashion: 'fashion', jewellery: 'fashion',
      travel: 'fashion', beauty: 'beauty-health', health: 'beauty-health', drinks: 'drinks', toys: 'toys',
      gaming: 'gaming', home: 'home-kitchen', baby: 'baby', books: 'other', music: 'other',
    };
    for (const [shopCategory, slug] of Object.entries(expected)) {
      expect(categorize(input({ shopCategory }))).toBe(slug);
    }
  });

  it('never lets a generic path segment decide the category', () => {
    for (const p of ['Black Friday Deals', 'Sale', 'Offers', 'Clearance', 'New', 'Deals > Sale']) {
      expect(categorize(input({ categoryPath: p, shopCategory: 'sports' }))).toBe('sports');
    }
    expect(categorize(input({ categoryPath: 'Black Friday Deals > Laptops' }))).toBe('laptops');
  });

  it('treats generic words as whole words only', () => {
    expect(categorize(input({ tags: ['Newborn'] }))).toBe('baby');
    expect(categorize(input({ categoryPath: 'Renewed Laptops' }))).toBe('laptops');
    expect(categorize(input({ categoryPath: 'Wholesale Laptops', shopCategory: 'sports' }))).toBe('laptops');
    expect(categorize(input({ categoryPath: 'Wholesale', title: 'Something', shopCategory: 'sports' }))).toBe('sports');
    expect(categorize(input({ categoryPath: 'New > Laptops' }))).toBe('laptops');
  });

  it('returns other when nothing matches', () => {
    expect(categorize(input())).toBe('other');
    expect(categorize(input({ categoryPath: 'Miscellaneous', title: 'Widget', shopCategory: 'unknown' }))).toBe('other');
  });

  it('lets overrides on any path segment win over the rules', () => {
    const overrides = { 'small appliances': 'appliances' };
    expect(categorize(input({ categoryPath: 'Home | Small Appliances' }), overrides)).toBe('appliances');
    expect(categorize(input({ categoryPath: 'Laptops > Small Appliances' }), overrides)).toBe('appliances');
    expect(categorize(input({ categoryPath: 'Home | Small Appliances' }))).toBe('appliances');
  });

  it('ignores overrides that point at an unknown slug', () => {
    expect(categorize(input({ categoryPath: 'Laptops' }, ), { laptops: 'nonsense' })).toBe('laptops');
  });
});

// Real misfiles from the name normaliser pilot sample (out/names/dry-20261022-222157-haiku.csv and the two runs after it):
// shop title, the shop's category path and tags, and the shop's own category.
type Misfile = { want: string; was: string; shop: string; title: string; categoryPath: string | null; tags?: string[]; shopCategory: string };
const MISFILES: Misfile[] = [
  // belts, sunglasses, swimwear and socks under drinks (title words such as "Wine", "Champagne", "Rum", "Drink")
  { want: 'fashion', was: 'drinks', shop: 'okfashion', title: 'U.S. POLO ASSN. WOMEN TOWNIE BELT WOMAN H35 IN WINE', categoryPath: 'Belt', tags: ['25S', 'Accessories', 'Belts', 'Synthetic', 'U.S. Polo Assn.', 'Women', 'XTRA'], shopCategory: 'fashion' },
  { want: 'fashion', was: 'drinks', shop: 'mvintage', title: 'Kalkara Champagne Sunglasses', categoryPath: 'Type_Sunglasses', shopCategory: 'fashion' },
  { want: 'fashion', was: 'drinks', shop: 'tezenis', title: 'Rum Paradise Bay Brazilian Bikini Bottoms', categoryPath: 'Women > Swimsuits and Bikini > Bikini Bottoms > Brazilian cut', tags: ['Women'], shopCategory: 'fashion' },
  { want: 'fashion', was: 'drinks', shop: 'bortex', title: 'Happy Socks Multicolour 2-Pack Energy Drink Socks Gift Set', categoryPath: 'Socks', tags: ['Accessories', 'BF25', 'Colour:Mix', 'Composition:Cotton', 'Female', 'Happy Socks', 'Male', 'Not Sale', 'Socks', 'Unisex'], shopCategory: 'fashion' },
  { want: 'drinks', was: 'fashion', shop: 'spades', title: 'Fee Brothers - Old Fashion Aromatic Bitters 15cl', categoryPath: 'USA', tags: ['Bitters'], shopCategory: 'drinks' },
  { want: 'drinks', was: 'sports', shop: 'farsons', title: 'Lemon Flavour', categoryPath: 'Sports Drinks', tags: ['bottle-type=PET Bottle', 'Brand_Gatorade', 'category=Non-alcoholic Beverages', 'Type_Sports Drinks'], shopCategory: 'drinks' },
  // journals, notebooks (paper) and bags under laptops
  { want: 'other', was: 'laptops', shop: 'accessorize', title: 'GIRLS FAUX FUR OWL LOCKABLE JOURNAL', categoryPath: 'Angels | Notebooks, journals & diaries | Stationery', shopCategory: 'fashion' },
  { want: 'other', was: 'laptops', shop: 'sterling', title: 'DGH Large Ruled Notebook Textile Cover Ref :TCC026TCAE7UB003', categoryPath: 'Notebooks & Notepads', shopCategory: 'jewellery' },
  { want: 'other', was: 'laptops', shop: 'retail', title: "Animal Figured Girls' Notebook", categoryPath: 'Stationery', tags: ['11.08.2026', 'CLR Mix', 'LC WAIKIKI', 'PT Notebooks', 'Stationery'], shopCategory: 'fashion' },
  { want: 'fashion', was: 'laptops', shop: 'bortex', title: 'Fjallraven Navy Kanken Laptop 15" Backpack', categoryPath: 'Bags', tags: ['Accessories', 'Bags', 'BF25', 'Colour:Navy', 'Fjallraven', 'Model Type:Backpacks'], shopCategory: 'fashion' },
  { want: 'fashion', was: 'laptops', shop: 'samsonite', title: 'Securipak 2.0 Laptop Backpack 15.6" - Light Sage', categoryPath: 'Laptop Backpacks', tags: ['Backpacks', 'Cabin Luggage', 'Laptop Backpacks', 'Laptop Bags', 'Softshell', 'Unisex'], shopCategory: 'travel' },
  { want: 'fashion', was: 'laptops', shop: 'okfashion', title: 'US POLO ASSN MEN CAMBRIDGE BUSINESS BAG', categoryPath: 'Bags', tags: ['25S', 'Bags', 'BLACKFRIDAY', 'Laptop Bags', 'Men', 'Synthetic', 'U.S. POLO ASSN.'], shopCategory: 'fashion' },
  { want: 'fashion', was: 'laptops', shop: 'womensecret', title: 'LAPTOP CASE', categoryPath: 'ACCESSORIES', tags: ['LAPTOP CASE'], shopCategory: 'fashion' },
  // keycaps, phone holders, TV stands, kids cameras
  { want: 'other', was: 'gaming', shop: 'scan', title: 'Glorious PC Gaming Race Keyboard GPBT Keycaps Set US Layout Pastel (114 Pieces)', categoryPath: 'Computer Peripherals', shopCategory: 'electronics' },
  { want: 'fashion', was: 'phones', shop: 'twinset', title: 'Phone holder with shoulder strap and Oval T', categoryPath: null, tags: ['womanaccessories'], shopCategory: 'fashion' },
  { want: 'other', was: 'laptops', shop: 'knightmusic', title: 'Hercules 2-in-1 Tablet & Phone Holder', categoryPath: 'Tablet & Laptop Stands', shopCategory: 'music' },
  { want: 'home-kitchen', was: 'tv-audio', shop: 'kitchenstore', title: 'TKS \u2013  Asmar TV Stand', categoryPath: 'Furniture | TV Stands', tags: ['console', 'interior furniture', 'tv table'], shopCategory: 'home' },
  { want: 'toys', was: 'tv-audio', shop: 'toymagic', title: 'Lexibook Unicorn Kids Camera With Protection', categoryPath: 'Headphones', tags: ['3 Years', '4 Years', '5 Years', '6 Years', '7 Years', '8 Years', '9 Years'], shopCategory: 'toys' },
  // a title word of a specialist shop decides nothing: the shop's own category is the better guess
  { want: 'gaming', was: 'baby', shop: 'gamestore', title: 'Million Dollar Baby (UMD Movie) (PSP) (Pre-owned)', categoryPath: null, shopCategory: 'gaming' },
  { want: 'gaming', was: 'drinks', shop: 'gamestore', title: 'Riding Spirits 2 (PS2) (Pre-owned)', categoryPath: null, tags: ['New This Week'], shopCategory: 'gaming' },
  { want: 'other', was: 'baby', shop: 'knightmusic', title: 'CRY BABY\u00ae CUSTOM BADASS\u2122 DUAL-INDUCTOR EDITION WAH', categoryPath: 'Wah/Volume/Expression Pedals', shopCategory: 'music' },
  { want: 'sports', was: 'appliances', shop: 'eurosport', title: 'RUBBER KETTLE DUMBBELL', categoryPath: null, shopCategory: 'sports' },
  { want: 'beauty-health', was: 'phones', shop: 'hollandbarrett', title: 'New Nordic Chili Burn 60 Tablets', categoryPath: 'Weight Management | Weight Management Support', shopCategory: 'health' },
  { want: 'beauty-health', was: 'toys', shop: 'perfandco', title: 'Moschino - Toy Boy - Gift Set - 50ml', categoryPath: 'Gift Set', tags: ['30ml', 'For Men', 'giftpack', 'giftset', 'moschino', 'NEW IN'], shopCategory: 'beauty' },
  { want: 'fashion', was: 'tv-audio', shop: 'samsonite', title: 'HI-FI Spinner Suitcase 55cm - Sand', categoryPath: 'Suitcases', tags: ['4 Wheels', '55cm', 'Cabin Luggage', 'Expandable', 'Hardshell', 'Spinner', 'Suitcases'], shopCategory: 'travel' },
  { want: 'toys', was: 'baby', shop: 'gamebreaker', title: 'Disney Angel Baby Plush  70cm', categoryPath: 'Plushies', shopCategory: 'gaming' },
  // footwear words of a fashion shop's path, not the "Sport" in its tags or the "Running" in its path
  { want: 'fashion', was: 'sports', shop: 'okfashion', title: 'BEIRA RIO SPORT MEN FLATS IN BLACK', categoryPath: 'Flats', tags: ['24S', 'Beira Rio', 'BLACKFRIDAY', 'BR Sport', 'Flats', 'Footwear', 'Loafers', 'Men'], shopCategory: 'fashion' },
  { want: 'fashion', was: 'sports', shop: 'okfashion', title: 'US POLO MENS SNEAKER RUNNING IN TEXTILE KNITTED MATERIAL', categoryPath: 'SNEAKER RUNNING', tags: ['24S', 'BLACKFRIDAY', 'Footwear', 'Knitted', 'Men', 'Sneakers', 'Trainers', 'U.S. Polo Assn.'], shopCategory: 'fashion' },
  // electronics shops: path words that were missing
  { want: 'phones', was: 'fashion', shop: 'digitalzone', title: 'Trevi IP68 Smart Fitness Watch for iOS & Android Black \u2013 TFIT320BK', categoryPath: 'Smart Watches', shopCategory: 'electronics' },
  { want: 'phones', was: 'sports', shop: 'intercomp', title: 'APPLE WATCH SE 3 GPS 44MM MIDNIGHT ALUMINIUM CASE WITH MIDNIGHT SPORT BAND - S/M', categoryPath: 'Smartwatch & Fitness Trackers > Smartwatches', shopCategory: 'electronics' },
  { want: 'appliances', was: 'drinks', shop: 'scan', title: 'Gree Airy Series 24000BTU Champagne Smart Air Conditioner w/Wifi (Installation Included)', categoryPath: 'Heating & Cooling', shopCategory: 'electronics' },
  { want: 'appliances', was: 'drinks', shop: 'atoz', title: 'AVINTAGE AVI81XDZA 79 Bottles Built-in Wine Cooler', categoryPath: 'Wine Coolers | Wine Coolers', tags: ['AVINTAGE', 'BackOrder', 'Black Friday'], shopCategory: 'electronics' },
  { want: 'appliances', was: 'other', shop: 'ultimate', title: 'Delonghi EC890M Dedica Duo \u2013 Silver', categoryPath: 'Pump Espresso Machines', shopCategory: 'electronics' },
  { want: 'appliances', was: 'other', shop: 'ultimate', title: 'TurboTronic Turbogrill', categoryPath: 'Kettles & Toasters - SALE | Grills & Sandwich toasters', shopCategory: 'electronics' },
  { want: 'home-kitchen', was: 'drinks', shop: 'kitchenstore', title: 'Ocean \u2014 Madison Cognac set of 2', categoryPath: 'Drinkware | Serving & Tableware | Whiskey & Cognac Glasses', tags: ['cognac', 'glassware'], shopCategory: 'home' },
  { want: 'home-kitchen', was: 'fashion', shop: 'atoz', title: 'LEIFHEIT Classic 25 2.5m Clothes Airer', categoryPath: 'Clothes Airers', tags: ['LEIFHEIT'], shopCategory: 'electronics' },
  { want: 'beauty-health', was: 'home-kitchen', shop: 'crosscraft', title: 'Philips Series 9000 Wet & Dry Epilator, 7 Accessories', categoryPath: 'Female Epilators', tags: ['PC', 'SDA1', 'Woo'], shopCategory: 'home' },
  { want: 'beauty-health', was: 'appliances', shop: 'telecom', title: 'Remington D3015 2000W Ionic Conditioning Hair Dryer', categoryPath: null, shopCategory: 'electronics' },
  { want: 'other', was: 'fashion', shop: 'intercomp', title: 'INSTA360 X5 INVISIBLE MIC COLD SHOE (FOR RODE MIC)', categoryPath: 'Photography & Accessories > Camera Accesories', shopCategory: 'electronics' },
];

describe('categorize: misfiles found in the name normaliser pilot', () => {
  it.each(MISFILES)('$shop "$title" goes to $want (was $was)', (m) => {
    expect(categorize(input({ title: m.title, categoryPath: m.categoryPath, tags: m.tags ?? [], shopCategory: m.shopCategory }))).toBe(m.want);
  });

  it('still files real laptops, phones and their cases, kids toys and electronics by title', () => {
    expect(categorize(input({ title: 'HP OmniBook 3', categoryPath: 'Laptop', shopCategory: 'electronics' }))).toBe('laptops');
    expect(categorize(input({ title: 'ACER Aspire Lite 14 Office Notebook, 8GB, 256GB SSD', shopCategory: 'electronics' }))).toBe('laptops');
    expect(categorize(input({ title: 'SWAROVSKI HIGH SMARTPHONE CASE IN BLACK', categoryPath: 'Mobile Phone Cases', shopCategory: 'fashion' }))).toBe('phones');
    expect(categorize(input({ title: 'Forcell F-Grip Car Phone Holder', categoryPath: 'Mobile Phone Accessories', shopCategory: 'electronics' }))).toBe('phones');
    expect(categorize(input({ title: 'Paw Patrol My First Laptop', shopCategory: 'toys' }))).toBe('toys');
    expect(categorize(input({ title: 'Paw Patrol My First Laptop', shopCategory: 'electronics' }))).toBe('toys');
    expect(categorize(input({ title: 'Xiaomi Mi Robot Vacuum Mop 2 Pro Black', shopCategory: 'electronics' }))).toBe('appliances');
    expect(categorize(input({ title: 'Stolichnaya Vodka 70cl', categoryPath: 'Russia > Vodka', shopCategory: 'drinks' }))).toBe('drinks');
    expect(categorize(input({ title: 'Samsung TV Wall Mount Bracket', categoryPath: 'TV Accessories', shopCategory: 'electronics' }))).toBe('tv-audio');
    // underscores in a path read as spaces; in tags they do not (promo codes)
    expect(categorize(input({ title: 'Mvintage Gin', categoryPath: 'Type_Alcoholic Beverages', shopCategory: 'fashion' }))).toBe('drinks');
    expect(categorize(input({ title: 'Bobble Striped Bath Mat', categoryPath: 'Bathroom', tags: ['Home', 'HW_BEAUTY_PROMO_OCT2024'], shopCategory: 'fashion' }))).toBe('home-kitchen');
  });
});

// Review of 1769c46 and 21b4a04: the reviewer's pairs.
describe('categorize: review fixes', () => {
  it('C2a: a Notebooks path is a laptop path for generalist shops or when the title has laptop specs', () => {
    expect(categorize(input({ title: 'Lenovo IdeaPad Slim 3 15IAH8 i5 16GB 512GB', categoryPath: 'Computers > Notebooks', shopCategory: 'electronics' }))).toBe('laptops');
    expect(categorize(input({ title: 'HP 255 G9 15.6 Ryzen 5', categoryPath: 'Notebooks', shopCategory: 'electronics' }))).toBe('laptops');
    expect(categorize(input({ title: 'Lenovo IdeaPad Slim 3 15IAH8 i5 16GB 512GB', categoryPath: 'Notebooks', shopCategory: 'gaming' }))).toBe('laptops');
    // paper notebooks at specialist shops stay out of laptops
    expect(categorize(input({ title: 'Notebook - Planes', categoryPath: 'notebook', shopCategory: 'baby' }))).not.toBe('laptops');
    expect(categorize(input({ title: 'Notebook - Mouse Fairies', categoryPath: 'Notebooks & Notepads', shopCategory: 'fashion' }))).toBe('other');
  });

  it('C2b: stationery and printer words decide only as the last path segment', () => {
    expect(categorize(input({ title: 'Dell XPS 13 9340 Core Ultra 7 16GB 512GB', categoryPath: 'Computers & Printers > Laptops', shopCategory: 'electronics' }))).toBe('laptops');
    expect(categorize(input({ title: 'Apple iPad 11 A16 128GB Wi-Fi', categoryPath: 'Tablets & Printers', shopCategory: 'electronics' }))).toBe('phones');
    expect(categorize(input({ title: 'BROTHER YELLOW TONER TN248CLY', categoryPath: 'Printer Toners > Printers, Shredders & Supplies', shopCategory: 'electronics' }))).toBe('other');
    expect(categorize(input({ title: 'GIRLS FAUX FUR OWL LOCKABLE JOURNAL', categoryPath: 'Angels | Notebooks, journals & diaries | Stationery', shopCategory: 'fashion' }))).toBe('other');
  });

  it('C2c: tea, coffee, bin, rubbish, refuse, dust, cleaner, vacuum, storage, sandwich, freezer, camera, tool, seat and laundry bags and belts are not fashion', () => {
    for (const w of ['Tea', 'Coffee', 'Bin', 'Rubbish', 'Refuse', 'Dust', 'Cleaner', 'Vacuum', 'Storage', 'Sandwich', 'Freezer', 'Camera', 'Tool', 'Seat', 'Laundry']) {
      expect(categorize(input({ title: `${w} bags 20 pack`, categoryPath: `${w} Bags`, shopCategory: 'home' }))).not.toBe('fashion');
      expect(categorize(input({ title: `${w} belt`, categoryPath: `${w} Belts`, shopCategory: 'home' }))).not.toBe('fashion');
    }
    expect(categorize(input({ title: 'Leather Belt', categoryPath: 'Belts', shopCategory: 'home' }))).toBe('fashion');
  });

  it('I5: only toy-maker devices are toys; kids editions of real tablets stay with phones and tablets; a bag or case for a device is no device', () => {
    expect(categorize(input({ title: 'Amazon Fire HD 8 Kids Tablet 32GB Blue', shopCategory: 'electronics' }))).toBe('phones');
    expect(categorize(input({ title: 'Samsung Galaxy Tab A9 Kids Edition 64GB', shopCategory: 'electronics' }))).toBe('phones');
    expect(categorize(input({ title: 'Huawei MatePad T10 Kids Edition 32GB', shopCategory: 'electronics' }))).toBe('phones');
    expect(categorize(input({ title: 'VTech KidiZoom Duo DX Camera', shopCategory: 'electronics' }))).toBe('toys');
    expect(categorize(input({ title: 'LeapFrog LeapPad Academy Kids Tablet', shopCategory: 'electronics' }))).toBe('toys');
    expect(categorize(input({ title: 'Clementoni Kids Camera Unicorn', categoryPath: 'Cameras', shopCategory: 'electronics' }))).toBe('toys');
    expect(categorize(input({ title: 'Lexibook Unicorn Kids Camera With Protection', categoryPath: 'Headphones', shopCategory: 'toys' }))).toBe('toys');
    expect(categorize(input({ title: 'Lexibook Kids Camera Bag Blue', shopCategory: 'electronics' }))).not.toBe('toys');
    expect(categorize(input({ title: 'VTech Kids Tablet Case', categoryPath: 'Tablet Accessories', shopCategory: 'electronics' }))).toBe('phones');
  });
});
