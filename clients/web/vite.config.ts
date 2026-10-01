import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': api,
      '/healthz': api,
      '/readyz': api,
      '/ws': { target: api, ws: true },
    },
  },
  preview: { port: 5173, strictPort: true },
});
