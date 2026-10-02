import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { devFixtures } from './vite.dev-fixtures';

// The API the dev and preview servers proxy to (same-origin cookies); browser e2e points it at its own test server.
const api = process.env['MANYTHREADS_API_ORIGIN'] ?? 'http://localhost:3000';

const proxy = {
  '/api': api,
  '/healthz': api,
  '/readyz': api,
  '/ws': { target: api, ws: true },
};

export default defineConfig({
  plugins: [react(), devFixtures()],
  server: {
    port: 5173,
    strictPort: true,
    proxy,
  },
  preview: { port: 5173, strictPort: true, proxy },
});
