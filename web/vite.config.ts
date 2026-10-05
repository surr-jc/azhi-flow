import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Mission control is served by the Azhi server at /ui (src/web/routes.ts). `npm run build:web`
// writes the bundle to src/web/dist; `npm run dev:web` proxies the API to a local server.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/ui/',
  plugins: [react()],
  build: { outDir: '../src/web/dist', emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 800 },
  server: { proxy: { '/v1': process.env.AZHI_URL ?? 'http://127.0.0.1:7400', '/healthz': process.env.AZHI_URL ?? 'http://127.0.0.1:7400' } },
});
