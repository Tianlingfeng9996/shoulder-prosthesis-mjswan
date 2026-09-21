import { defineConfig } from 'vite';

export default defineConfig({
  // Relative assets work both at localhost and under a GitHub Pages repository path.
  base: './',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});

