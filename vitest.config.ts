// Tests run from the repo root in node; component tests opt into jsdom with `// @vitest-environment jsdom`.
// This file exists so Vitest does not pick up vite.config.ts (whose root is web/).
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./web/src', import.meta.url)) },
  },
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
});
