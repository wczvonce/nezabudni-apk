import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const required = [
  'capacitor.config.ts', 'src/main.js', 'src/services/task-service.js',
  'supabase/migrations/001_schema.sql', 'supabase/migrations/004_deep_audit_fixes.sql', 'supabase/functions/push-worker/index.ts',
  'android/app/build.gradle', 'ios/App/App.xcodeproj/project.pbxproj', 'ios/App/App/App.entitlements',
  'tests/auth-deadlock.test.mjs', 'tests/account-isolation.test.mjs', 'tests/sql-behavior.test.mjs', 'tests/ui-alarm.test.mjs', 'tests/worker-static.test.mjs',
];
for (const path of required) await readFile(path);

const forbiddenPatterns = [
  /ONESIGNAL_REST_API_KEY\s*=\s*["'][A-Za-z0-9_-]{20,}/,
  /SUPABASE_SERVICE_ROLE_KEY\s*=\s*["'][A-Za-z0-9._-]{20,}/,
  /Access-Control-Allow-Origin["']?\s*:\s*["']\*["']/,
];

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    if (['node_modules', '.git', 'dist'].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await walk(path)); else result.push(path);
  }
  return result;
}
for (const path of await walk('.')) {
  if (!/\.(js|mjs|ts|sql|toml|md|html|json|xml|gradle)$/.test(path)) continue;
  const text = await readFile(path, 'utf8').catch(() => '');
  for (const pattern of forbiddenPatterns) {
    if (pattern.test(text)) throw new Error(`Bezpečnostná kontrola zlyhala v ${path}: ${pattern}`);
  }
}
console.log('OK: povinné súbory existujú a nenašli sa natvrdo vložené tajné kľúče ani CORS * push proxy.');
