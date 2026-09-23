import { AttachmentError, MAX_ATTACHMENT_BYTES, sniffAttachmentType } from '../chatgpt-api/attachment-policy.js';

export function fileDownloadUrl(value) {
  let url;
  try { url=new URL(value); } catch { throw new AttachmentError('INVALID_FILE_URL'); }
  // Only OpenAI's file delivery domain; no arbitrary URL fetching, ports or redirects.
  if(url.protocol!=='https:' || url.hostname!=='files.oaiusercontent.com' || url.port || url.username || url.password || url.hash) {
    throw new AttachmentError('FILE_HOST_NOT_ALLOWED');
  }
  return url.href;
}
export async function fetchChatFile(file,fetcher=fetch) {
  if(!file || typeof file.file_id!=='string' || !file.file_id || file.file_id.length>200) throw new AttachmentError('INVALID_FILE');
  const response=await fetcher(fileDownloadUrl(file.download_url),{redirect:'error',signal:AbortSignal.timeout(20000),credentials:'omit'});
  if(!response.ok || !response.body) throw new AttachmentError('FILE_DOWNLOAD_FAILED',502);
  const declared=response.headers.get('content-length');
  if(declared && (!/^\d+$/.test(declared) || Number(declared)>MAX_ATTACHMENT_BYTES)) throw new AttachmentError('ATTACHMENT_TOO_LARGE',413);
  const reader=response.body.getReader(), chunks=[];
  let length=0;
  try {
    while(true) {
      const {done,value}=await reader.read(); if(done)break;
      length+=value.byteLength;
      if(length>MAX_ATTACHMENT_BYTES){await reader.cancel();throw new AttachmentError('ATTACHMENT_TOO_LARGE',413);}
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  if(!length) throw new AttachmentError('EMPTY_ATTACHMENT');
  const bytes=new Uint8Array(length);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  const mime=sniffAttachmentType(bytes);
  if(file.mime_type && file.mime_type!==mime) throw new AttachmentError('ATTACHMENT_CONTENT_TYPE_MISMATCH',415);
  const extension={'image/jpeg':'jpg','image/png':'png','image/webp':'webp','application/pdf':'pdf'}[mime];
  const digest=await crypto.subtle.digest('SHA-256',bytes);
  return {bytes,metadata:{filename:file.file_name||`attachment.${extension}`,mime_type:mime,size_bytes:length,
    sha256:[...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('')}};
}
