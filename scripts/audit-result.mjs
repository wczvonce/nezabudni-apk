export function parseAuditResult(result) {
  if (result.error || result.signal || ![0, 1].includes(result.status)) {
    throw new Error(`npm audit sa nedokončil: ${result.error?.message || result.signal || result.status}`);
  }
  const report = JSON.parse(result.stdout);
  if (report.error || report.auditReportVersion !== 2 || !report.vulnerabilities || !report.metadata?.vulnerabilities) {
    throw new Error('npm audit nevrátil úplnú správu o zraniteľnostiach.');
  }
  if (result.status !== 0 && Object.keys(report.vulnerabilities).length === 0) {
    throw new Error('npm audit zlyhal bez vysvetlenia v správe.');
  }
  return report;
}
