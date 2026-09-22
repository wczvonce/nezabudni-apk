import assert from 'node:assert/strict';
import { parseAuditResult } from '../scripts/audit-result.mjs';
const clean={auditReportVersion:2,vulnerabilities:{},metadata:{vulnerabilities:{high:0,critical:0}}};
assert.deepEqual(parseAuditResult({status:0,stdout:JSON.stringify(clean)}),clean);
for(const result of [{status:null,error:new Error('EINVAL'),stdout:''},{status:0,stdout:''},{status:0,stdout:'{}'},
  {status:1,stdout:JSON.stringify(clean)},{status:0,stdout:'{"error":{"message":"offline"}}'},
  {status:null,signal:'SIGTERM',stdout:JSON.stringify(clean)}]) {
  assert.throws(()=>parseAuditResult(result),'Incomplete or failed checks must never be green');
}
const vulnerable={...clean,vulnerabilities:{example:{severity:'high'}}};
assert.equal(parseAuditResult({status:1,stdout:JSON.stringify(vulnerable)}).vulnerabilities.example.severity,'high');
console.log('DEPENDENCY AUDIT FAILURE HANDLING OK');
