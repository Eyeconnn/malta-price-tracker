// The admin area (/admin/*), behind ADMIN_PASSWORD in the Worker. Never indexed: the Worker sends
// x-robots-tag for every admin path, and the page adds a robots meta tag as well.
import { NavLink, Route, Routes } from 'react-router';
import { cn } from '@/lib/utils';
import { NotFoundPage } from '@/pages/NotFound';
import { AdminAddShopPage } from '@/pages/admin/AddShop';
import { AdminMatchesPage } from '@/pages/admin/Matches';
import { AdminPhrasesPage } from '@/pages/admin/Phrases';
import { AdminReportsPage } from '@/pages/admin/Reports';
import { AdminSettingsPage } from '@/pages/admin/Settings';
import { AdminShopsPage } from '@/pages/admin/Shops';
import { AdminThresholdsPage } from '@/pages/admin/Thresholds';
import { AdminSettingsProvider } from '@/pages/admin/shared';

const SECTIONS = [
  { to: '/admin', label: 'Settings', end: true },
  { to: '/admin/phrases', label: 'Phrases' },
  { to: '/admin/thresholds', label: 'Thresholds' },
  { to: '/admin/reports', label: 'Reports' },
  { to: '/admin/shops', label: 'Shops' },
  { to: '/admin/add-shop', label: 'Add shop' },
  { to: '/admin/matches', label: 'Matches' },
];

export function AdminPage() {
  return (
    <div className="flex flex-col gap-4">
      {/* React hoists this into <head> */}
      <meta name="robots" content="noindex, nofollow" />
      <h1 className="text-2xl font-bold tracking-tight">Admin</h1>
      <nav aria-label="Admin sections">
        <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
          {SECTIONS.map((s) => (
            <li key={s.to}>
              <NavLink
                to={s.to}
                end={s.end}
                className={({ isActive }) =>
                  cn(
                    'inline-flex min-h-11 items-center rounded-md border px-4 text-sm font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                    isActive ? 'border-transparent bg-primary text-primary-foreground' : 'bg-background hover:bg-secondary',
                  )
                }
              >
                {s.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <AdminSettingsProvider>
        <Routes>
          <Route index element={<AdminSettingsPage />} />
          <Route path="phrases" element={<AdminPhrasesPage />} />
          <Route path="thresholds" element={<AdminThresholdsPage />} />
          <Route path="reports" element={<AdminReportsPage />} />
          <Route path="shops" element={<AdminShopsPage />} />
          <Route path="add-shop" element={<AdminAddShopPage />} />
          <Route path="matches" element={<AdminMatchesPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </AdminSettingsProvider>
    </div>
  );
}
