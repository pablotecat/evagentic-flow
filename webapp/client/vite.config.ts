import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const target = process.env.WEBAPP_TARGET ?? `http://127.0.0.1:${process.env.WEBAPP_PORT ?? 4173}`;
const targetOrigin = new URL(target).origin;

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
        target,
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', proxyReq => {
            if (proxyReq.getHeader('origin')) {
              proxyReq.setHeader('origin', targetOrigin);
            }
          });
        },
      },
    },
  },
});
