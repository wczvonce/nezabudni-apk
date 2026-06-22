import { build } from 'esbuild';

await build({
  entryPoints: ['supabase/functions/push-worker/index.ts'],
  bundle: true,
  write: false,
  platform: 'neutral',
  format: 'esm',
  external: ['npm:*'],
  logLevel: 'silent',
});

console.log('EDGE WORKER BUILD OK');
