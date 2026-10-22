/** Secrets and settings of the public site Worker (Ruling R7: one database role per job). */
export interface Env {
  /** read-only role dashboard_ro: every public read */
  DATABASE_URL: string;
  /** role site_reporter: insert-only on reports */
  REPORTER_DATABASE_URL: string;
  /** role site_admin: admin routes only */
  ADMIN_DATABASE_URL: string;
  /** Basic auth password while the site is private */
  SITE_PASSWORD: string;
  /** Basic auth password for /admin and /api/admin/* */
  ADMIN_PASSWORD: string;
  /** e.g. https://bf-guide.example.workers.dev or the custom domain */
  SITE_ORIGIN: string;
  /** salt for hashing client IPs (report rate limits) */
  IP_SALT: string;
  TURNSTILE_SECRET?: string;
}
