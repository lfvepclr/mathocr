import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

// Vite config: build output goes to ../static (served by Robyn).
// emptyOutDir clears the old vanilla JS/CSS on each build.
// base '/static/' matches the server's /static/* route so index.html
// references /static/assets/... (a relative './' base would resolve to
// /assets/... which the server does not serve -> 404 -> blank page).
export default defineConfig({
  plugins: [react()],
  base: '/static/',
  build: {
    outDir: resolve(__dirname, '../static'),
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'zustand'],
          text: ['marked', 'katex'],
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:7861',
    },
  },
});
