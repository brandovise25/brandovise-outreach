import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Served by the API server under /app/ (same origin as the API, so no CORS).
// `npm run dev -w web` proxies API calls to the local Docker server.
export default defineConfig({
  base: '/app/',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: Object.fromEntries(
      ['/auth', '/panel', '/ext', '/ai', '/health'].map((p) => [p, 'http://localhost:3300']),
    ),
  },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
});
