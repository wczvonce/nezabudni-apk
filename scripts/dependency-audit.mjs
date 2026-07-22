import { spawnSync } from 'node:child_process';

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npmCommand, ['audit', '--audit-level=high', '--json'], {
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024,
});

let report;
try {
  report = JSON.parse(result.stdout || '{}');
} catch (error) {
  console.error('DEPENDENCY AUDIT: npm nevrátil platný JSON.');
  console.error(result.stderr || error.message);
  process.exit(1);
}

const rank = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const vulnerabilities = Object.entries(report.vulnerabilities || {})
  .map(([name, value]) => ({ name, ...value }))
  .filter((item) => (rank[item.severity] ?? 0) >= rank.high)
  .sort((a, b) => (rank[b.severity] ?? 0) - (rank[a.severity] ?? 0) || a.name.localeCompare(b.name));

if (vulnerabilities.length === 0) {
  console.log('DEPENDENCY AUDIT OK: žiadne high ani critical zraniteľnosti.');
  process.exit(0);
}

console.error(`DEPENDENCY AUDIT FAILED: ${vulnerabilities.length} high/critical balíkov.`);
for (const item of vulnerabilities) {
  const via = (item.via || []).map((entry) => typeof entry === 'string' ? entry : `${entry.name || 'advisory'}: ${entry.title || entry.url || 'bez názvu'}`);
  const fix = item.fixAvailable === false
    ? 'bez automatickej opravy'
    : typeof item.fixAvailable === 'object'
      ? `oprava ${item.fixAvailable.name}@${item.fixAvailable.version}${item.fixAvailable.isSemVerMajor ? ' (major)' : ''}`
      : 'oprava dostupná';
  console.error(`- ${item.name}: ${item.severity}; direct=${Boolean(item.isDirect)}; range=${item.range}; ${fix}`);
  for (const reason of via.slice(0, 5)) console.error(`  via: ${reason}`);
}
process.exit(1);
