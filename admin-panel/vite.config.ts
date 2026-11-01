import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: the API runs in Docker on :3000; Vite proxies /api, /socket.io and /fw to it.
const target = process.env.VITE_API_TARGET || 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': target,
      '/fw': target,
      '/socket.io': { target, ws: true },
    },
  },
  build: { outDir: 'dist', sourcemap: false },
});
