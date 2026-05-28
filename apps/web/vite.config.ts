import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Mirrors `paths` in tsconfig.json so `import x from '@/lib/date'` works
      // identically in TS resolution and Vite bundling.
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/graphql': 'http://localhost:4000',
    },
  },
});
