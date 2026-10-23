import { Route, Routes } from 'react-router';
import { Layout } from '@/components/site/Layout';
import { AdminPage } from '@/pages/Admin';
import { DealsPage } from '@/pages/Deals';
import { HomePage } from '@/pages/Home';
import { HowWeCheckPage } from '@/pages/HowWeCheck';
import { NotFoundPage } from '@/pages/NotFound';
import { ListingRedirect, ProductPage } from '@/pages/Product';
import { SearchPage } from '@/pages/Search';
import { ShopPage } from '@/pages/Shop';
import { ShopsPage } from '@/pages/Shops';

/** Routes only: main.tsx supplies the router (tests supply a MemoryRouter). */
export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<HomePage />} />
        <Route path="search" element={<SearchPage />} />
        <Route path="deals" element={<DealsPage />} />
        <Route path="shops" element={<ShopsPage />} />
        <Route path="shops/:slug" element={<ShopPage />} />
        <Route path="product/:key" element={<ProductPage />} />
        {/* old listing links: to their product page */}
        <Route path="p/:id" element={<ListingRedirect />} />
        <Route path="how-we-check" element={<HowWeCheckPage />} />
        <Route path="admin/*" element={<AdminPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
