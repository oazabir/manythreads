import { defaultClientConditions, defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { devFixtures } from './vite.dev-fixtures';

// The API the dev and preview servers proxy to (same-origin cookies); browser e2e points it at its own test server.
const api = process.env['MANYTHREADS_API_ORIGIN'] ?? 'http://localhost:3000';

const proxy = {
  '/api': { target: api, ws: true },
  '/hooks': api,
  '/healthz': api,
  '/readyz': api,
  '/ws': { target: api, ws: true },
};

export default defineConfig({
  plugins: [react(), devFixtures()],
  // The speech worker (src/speech/worker.ts) is a module worker and loads the model library with import(), so it needs the `es` format (the
  // default `iife` cannot split code). The library is left out of dev pre-bundling: it picks its ONNX Runtime files by address at run time.
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
  // ONNX Runtime Web has two builds: one with its script and a 21 MB `.wasm` file folded into the bundle, one that expects them to be served.
  // We serve them ourselves (/models/ort/<revision>/, pinned and hash-checked by models.lock.json), so take the second: no second copy in the image.
  resolve: { conditions: [...defaultClientConditions, 'onnxruntime-web-use-extern-wasm'] },
  server: {
    port: 5173,
    strictPort: true,
    proxy,
  },
  preview: { port: 5173, strictPort: true, proxy },
});
