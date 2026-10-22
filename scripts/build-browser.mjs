import { build } from 'esbuild';
await build({
  entryPoints: ['src/browser/phone.ts'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  outfile: 'dist/phone.js',
});
console.log('built dist/phone.js');
