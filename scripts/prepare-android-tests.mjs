import { build } from 'esbuild';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
const out = 'android/app/build/generated/reviewTestAssets';
await mkdir(out, { recursive: true });
const html = (await readFile('index.html', 'utf8'))
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
  .replace(/<link\b[^>]*>/g, '');
await writeFile(`${out}/fixture.html`, html.replace('</head>', `<style>${await readFile('src/styles.css', 'utf8')}</style></head>`));
await build({ entryPoints: ['tests/android-webview.mjs'], bundle: true, format: 'iife',
  outfile: `${out}/scenarios.js`, platform: 'browser', target: 'chrome120',
  define: { 'import.meta.env': JSON.stringify({ DEV: false, VITE_SUPABASE_URL: 'http://127.0.0.1:1', VITE_SUPABASE_PUBLISHABLE_KEY: 'test-only-public-key' }) } });
console.log('Android test assets built; network fixtures use only synthetic accounts.');
