import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  root: __dirname,
  plugins: [react()],
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
