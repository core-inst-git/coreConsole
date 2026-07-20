import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { version as appVersion } from '../package.json';

export default defineConfig({
  root: __dirname,
  base: './',
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion)
  },
  resolve: {
    alias: {
      '@': path.join(__dirname, 'src')
    }
  },
  build: {
    outDir: path.join(__dirname, 'dist'),
    emptyOutDir: true
  },
  server: {
    port: 5173,
    strictPort: true
  }
});
