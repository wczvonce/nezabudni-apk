import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { attachmentMetadata, sniffAttachmentType, readAttachmentBytes, verifyAttachment, MAX_ATTACHMENT_BYTES } from '../supabase/functions/chatgpt-api/attachment-policy.js';
const pdf=new TextEncoder().encode('%PDF-1.7\nsynthetic test fixture\n%%EOF\n');
const jpg=new Uint8Array([255,216,255,224,0,16,74,70,73,70,0,255,217]);
const metadata=bytes=>({request_id:'11111111-1111-4111-8111-111111111111',filename:'synthetic-file',mime_type:sniffAttachmentType(bytes),size_bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
for(const bytes of [pdf,jpg]) {
  const meta=attachmentMetadata(metadata(bytes));
  assert.equal(await verifyAttachment(bytes,meta),meta.sha256);
  assert.deepEqual(await readAttachmentBytes(new Blob([bytes]).stream(),bytes.length),bytes);
}
assert.throws(()=>attachmentMetadata({...metadata(pdf),storage_path:'foreign/path'}),/UNKNOWN_ATTACHMENT_FIELD/);
assert.throws(()=>attachmentMetadata({...metadata(pdf),filename:'../file.pdf'}),/INVALID_FILENAME/);
assert.throws(()=>attachmentMetadata({...metadata(pdf),mime_type:'text/html'}),/UNSUPPORTED_ATTACHMENT_TYPE/);
assert.throws(()=>attachmentMetadata({...metadata(pdf),size_bytes:MAX_ATTACHMENT_BYTES+1}),/ATTACHMENT_TOO_LARGE/);
assert.throws(()=>attachmentMetadata({...metadata(pdf),sha256:'oops'}),/INVALID_ATTACHMENT_HASH/);
await assert.rejects(()=>verifyAttachment(jpg,{...metadata(jpg),mime_type:'application/pdf'}),/CONTENT_TYPE_MISMATCH/);
await assert.rejects(()=>verifyAttachment(pdf,{...metadata(pdf),sha256:'0'.repeat(64)}),/HASH_MISMATCH/);
await assert.rejects(()=>readAttachmentBytes(new Blob([pdf]).stream(),pdf.length-1),/SIZE_MISMATCH/);
await assert.rejects(()=>readAttachmentBytes(new Blob([pdf]).stream(),pdf.length+1),/SIZE_MISMATCH/);
assert.throws(()=>sniffAttachmentType(new TextEncoder().encode('<svg onload="alert(1)"></svg>')),/CONTENT_TYPE_MISMATCH/);
assert.throws(()=>sniffAttachmentType(new TextEncoder().encode('%PDF-1.7 truncated')),/CONTENT_TYPE_MISMATCH/);
console.log('Attachment policy: bounded binary streams, JPG/PDF signatures, MIME/size/hash/path rejection passed. Signature checks are not antivirus or full document parsing.');
