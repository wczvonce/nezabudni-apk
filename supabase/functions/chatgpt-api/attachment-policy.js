export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_TYPES = Object.freeze(['image/jpeg','image/png','image/webp','application/pdf']);

export class AttachmentError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}

export function attachmentMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AttachmentError('INVALID_ATTACHMENT');
  const keys = ['request_id','filename','mime_type','size_bytes','sha256'];
  if (Object.keys(value).some(key => !keys.includes(key))) throw new AttachmentError('UNKNOWN_ATTACHMENT_FIELD');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.request_id ?? '')) throw new AttachmentError('INVALID_REQUEST_ID');
  if (typeof value.filename !== 'string' || value.filename.length < 1 || value.filename.length > 180
    || value.filename !== value.filename.trim() || /[\x00-\x1f\x7f/\\]/.test(value.filename)) throw new AttachmentError('INVALID_FILENAME');
  if (!ATTACHMENT_TYPES.includes(value.mime_type)) throw new AttachmentError('UNSUPPORTED_ATTACHMENT_TYPE',415);
  if (!Number.isInteger(value.size_bytes) || value.size_bytes < 1) throw new AttachmentError('INVALID_ATTACHMENT_SIZE');
  if (value.size_bytes > MAX_ATTACHMENT_BYTES) throw new AttachmentError('ATTACHMENT_TOO_LARGE',413);
  if (typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(value.sha256)) throw new AttachmentError('INVALID_ATTACHMENT_HASH');
  return { request_id: value.request_id.toLowerCase(), filename: value.filename,
    mime_type: value.mime_type, size_bytes: value.size_bytes, sha256: value.sha256.toLowerCase() };
}

export function sniffAttachmentType(bytes) {
  const starts = expected => expected.every((byte,index) => bytes[index] === byte);
  if (bytes.length >= 4 && starts([0xff,0xd8,0xff])) return 'image/jpeg';
  if (bytes.length >= 24 && starts([137,80,78,71,13,10,26,10])
    && new TextDecoder().decode(bytes.slice(12,16)) === 'IHDR') return 'image/png';
  if (bytes.length >= 16 && new TextDecoder().decode(bytes.slice(0,4)) === 'RIFF'
    && new TextDecoder().decode(bytes.slice(8,12)) === 'WEBP'
    && ['VP8 ','VP8L','VP8X'].includes(new TextDecoder().decode(bytes.slice(12,16)))) return 'image/webp';
  if (bytes.length >= 12 && new TextDecoder().decode(bytes.slice(0,5)) === '%PDF-'
    && /%%EOF\s*$/.test(new TextDecoder().decode(bytes.slice(-1024)))) return 'application/pdf';
  throw new AttachmentError('ATTACHMENT_CONTENT_TYPE_MISMATCH',415);
}

/** Never buffer more than the declared bounded size, even with missing/false Content-Length. */
export async function readAttachmentBytes(stream, expectedSize) {
  if (!Number.isInteger(expectedSize) || expectedSize<1 || expectedSize>MAX_ATTACHMENT_BYTES) throw new AttachmentError('INVALID_ATTACHMENT_SIZE');
  if (!stream) throw new AttachmentError('EMPTY_ATTACHMENT');
  const reader=stream.getReader(), chunks=[];
  let length=0;
  try {
    while (true) {
      const {done,value}=await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length>expectedSize || length>MAX_ATTACHMENT_BYTES) {
        await reader.cancel();
        throw new AttachmentError('ATTACHMENT_SIZE_MISMATCH',413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  if (length !== expectedSize) throw new AttachmentError('ATTACHMENT_SIZE_MISMATCH');
  const bytes = new Uint8Array(length);
  let offset=0;
  for (const chunk of chunks) { bytes.set(chunk,offset); offset+=chunk.byteLength; }
  return bytes;
}

export async function verifyAttachment(bytes, metadata) {
  if (bytes.byteLength !== metadata.size_bytes || bytes.byteLength>MAX_ATTACHMENT_BYTES) throw new AttachmentError('ATTACHMENT_SIZE_MISMATCH');
  if (sniffAttachmentType(bytes) !== metadata.mime_type) throw new AttachmentError('ATTACHMENT_CONTENT_TYPE_MISMATCH',415);
  const digest=await crypto.subtle.digest('SHA-256',bytes);
  const hash=[...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
  if (hash !== metadata.sha256) throw new AttachmentError('ATTACHMENT_HASH_MISMATCH',409);
  return hash;
}
