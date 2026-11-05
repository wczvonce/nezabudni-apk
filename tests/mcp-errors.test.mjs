import assert from 'node:assert/strict';
import { toolErrorResult } from '../supabase/functions/nezabudni-mcp/errors.js';
import { AttachmentError } from '../supabase/functions/chatgpt-api/attachment-policy.js';
for (const code of ['INVALID_FILE','FILE_HOST_NOT_ALLOWED','FILE_DOWNLOAD_FAILED','ATTACHMENT_STORAGE_FAILED']) {
  assert.equal(toolErrorResult(new AttachmentError(code)).error.code,code);
}
for (const error of [new Error('https://private.test/?token=secret'),new AttachmentError('secret'),null]) {
  const result=toolErrorResult(error);
  assert.equal(result.error.code,'OPERATION_FAILED');
  assert.ok(!JSON.stringify(result).includes('secret'));
}
assert.equal(toolErrorResult(new Error('INVALID_ARGUMENTS')).error.code,'INVALID_ARGUMENTS');
console.log('MCP error diagnostics and redaction: passed');
