// Loads .env when present (local runs). In GitHub Actions the variables come from secrets.
try {
  process.loadEnvFile();
} catch {
  // no .env file, fine
}

export function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

export function optionalEnv(name: string): string | undefined {
  const v = process.env[name];
  return v ? v : undefined;
}

export function userAgent(): string {
  return optionalEnv('SCRAPER_USER_AGENT')?.trim() ?? 'PriceIndexBot/0.1 (price index crawler)';
}
