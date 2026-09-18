import * as esbuild from 'esbuild';
import { mkdirSync, copyFileSync } from 'node:fs';

mkdirSync('dist', { recursive: true });

await esbuild.build({
  entryPoints: {
    background: 'src/background.ts',
    'content-widget': 'src/content-widget.ts',
    popup: 'src/popup/popup.ts',
    options: 'src/options/options.ts',
    'fill-engine': 'src/fill-engine/index.ts',
    'international-fit-check': 'src/international-fit-check.ts',
  },
  bundle: true,
  outdir: 'dist',
  format: 'iife',
  target: 'chrome110',
});

copyFileSync('src/popup/popup.html', 'dist/popup.html');
copyFileSync('src/options/options.html', 'dist/options.html');

console.log('Build complete.');
