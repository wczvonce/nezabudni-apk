import { AttachmentError } from '../chatgpt-api/attachment-policy.js';

// Return only fixed error codes, never signed URLs, tokens or exception messages.
const safeCodes = new Set([
  'INVALID_FILE', 'INVALID_FILE_URL', 'FILE_HOST_NOT_ALLOWED', 'FILE_DOWNLOAD_FAILED',
  'EMPTY_ATTACHMENT', 'ATTACHMENT_TOO_LARGE', 'ATTACHMENT_CONTENT_TYPE_MISMATCH',
  'INVALID_ATTACHMENT', 'UNKNOWN_ATTACHMENT_FIELD', 'INVALID_REQUEST_ID',
  'INVALID_FILENAME', 'UNSUPPORTED_ATTACHMENT_TYPE', 'INVALID_ATTACHMENT_SIZE',
  'INVALID_ATTACHMENT_HASH', 'ATTACHMENT_SIZE_MISMATCH', 'ATTACHMENT_HASH_MISMATCH',
  'INVALID_ID', 'OPERATION_NOT_ALLOWED', 'ATTACHMENT_OPERATION_FAILED',
  'ATTACHMENT_STORAGE_FAILED', 'ATTACHMENT_STORAGE_VERIFY_FAILED',
  'ATTACHMENT_DOWNLOAD_FAILED', 'TASK_NOT_FOUND', 'ATTACHMENT_NOT_FOUND',
  'UPLOAD_EXPIRED', 'PAIR_REQUIRED', 'INTEGRATION_UNAUTHORIZED',
  'INTEGRATION_OPERATION_NOT_ALLOWED',
]);
export function toolErrorResult(error) {
  const code = error instanceof AttachmentError && safeCodes.has(error.code)
    ? error.code
    : error instanceof Error && ['TOOL_NOT_ALLOWED', 'INVALID_ARGUMENTS'].includes(error.message)
      ? error.message : 'OPERATION_FAILED';
  return {ok:false,error:{code,message:'Operácia nebola dokončená. Neoznamuj úspech.'}};
}
