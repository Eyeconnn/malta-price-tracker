import {
  Camera,
  Dumbbell,
  Footprints,
  Gamepad2,
  Headphones,
  Keyboard,
  Laptop,
  type LucideIcon,
  Package,
  Shirt,
  ShoppingBag,
  Smartphone,
  ToyBrick,
  Tv,
  Watch,
} from 'lucide-react';

/**
 * A product line icon (the same family as the page texture) for a product, from its title and then its category.
 * Deal cards carry no photo, so this stands in for one.
 */
const BY_TITLE: [RegExp, LucideIcon][] = [
  [/headphone|airpods|earbud|ear ?buds|speaker|soundbar|\bjbl\b|beats|headset/i, Headphones],
  [/\btv\b|television|oled|qled|monitor|projector|"|\binch\b/i, Tv],
  [/laptop|notebook|macbook|chromebook|thinkpad|ideapad|thinkbook/i, Laptop],
  [/iphone|galaxy|smartphone|\bphone\b|pixel|redmi|ipad|tablet/i, Smartphone],
  [/playstation|\bps5\b|\bps4\b|switch|xbox|controller|gaming|console/i, Gamepad2],
  [/keyboard|mouse/i, Keyboard],
  [/camera|gopro|lens/i, Camera],
  [/watch|garmin|fitbit/i, Watch],
  [/sneaker|trainer|shoe|air max|samba|boot/i, Footprints],
  [/shirt|jacket|hoodie|dress|jeans|t-shirt|sweater/i, Shirt],
  [/lego|toy|barbie|playmobil|hot wheels|puzzle|doll/i, ToyBrick],
  [/dumbbell|treadmill|yoga|bike|fitness|weights|racket|football/i, Dumbbell],
  [/bag|backpack|suitcase|wallet/i, ShoppingBag],
];

const BY_CATEGORY: Record<string, LucideIcon> = {
  laptops: Laptop,
  phones: Smartphone,
  'tv-audio': Tv,
  gaming: Gamepad2,
  toys: ToyBrick,
  fashion: Shirt,
  sports: Dumbbell,
};

export function productIcon(title: string, category?: string | null): LucideIcon {
  for (const [re, icon] of BY_TITLE) if (re.test(title)) return icon;
  return (category && BY_CATEGORY[category]) || Package;
}
