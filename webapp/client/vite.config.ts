import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': {
        target: process.env.WEBAPP_TARGET ?? `http://127.0.0.1:${process.env.WEBAPP_PORT ?? 4173}`,
        changeOrigin: true,
      },
    },
  },
});
