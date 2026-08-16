import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * API:et nås genom Vites proxy under /api. Det gör att webben och API:et delar origin,
 * vilket i sin tur gör att ingen CORS-konfiguration behövs i backenden — och att
 * Playwright bara behöver känna till en adress.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    // E2E-sviten kör i en container och når värden under det här namnet. Vite svarar
    // annars "Blocked request" på allt utom localhost, och sidan blir tom i stället
    // för att felet syns.
    allowedHosts: ['host.containers.internal'],
    port: Number(process.env.PORT ?? 5173),
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.API_TARGET ?? 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
