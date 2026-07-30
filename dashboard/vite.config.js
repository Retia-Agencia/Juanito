import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// El bundle se compila en GitHub Actions y llega al droplet ya construido: 1 vCPU no es
// lugar para correr builds (ver docs/DASHBOARD-ROADMAP.md).
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  // En desarrollo local, el API corre aparte con `node dashboard/server/index.js`.
  server: {
    proxy: { '/api': 'http://127.0.0.1:8080' },
  },
});
