import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['bin/cli.ts', 'src/index.ts'],
  format: ['esm'],
  target: 'node22',
  clean: true,
  splitting: false,
  sourcemap: true,
  dts: true,
  shims: true,
});
