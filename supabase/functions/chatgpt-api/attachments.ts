import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.108.2';
import { AttachmentError, attachmentMetadata, readAttachmentBytes, verifyAttachment } from './attachment-policy.js';

type Client = { id: string; actor_id: string; allowed_operations: string[] };
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BUCKET='task-attachments';
function identity(value: string) { if(!UUID.test(value)) throw new AttachmentError('INVALID_ID'); return value; }
function requireScope(client: Client, scope: string) {
  if(!client.allowed_operations.includes(scope)) throw new AttachmentError('OPERATION_NOT_ALLOWED',403);
}
function failRpc(error: {message: string}) {
  const code=error.message.match(/(INTEGRATION_[A-Z_]+|IDEMPOTENCY_[A-Z_]+|UPLOAD_[A-Z_]+|TASK_NOT_FOUND|ATTACHMENT_NOT_FOUND|INVALID_ATTACHMENT|PAIR_REQUIRED)/)?.[1];
  if(code==='INTEGRATION_UNAUTHORIZED') throw new AttachmentError(code,401);
  if(code==='INTEGRATION_OPERATION_NOT_ALLOWED' || code==='PAIR_REQUIRED') throw new AttachmentError(code,403);
  if(code?.includes('LIMITED')) throw new AttachmentError(code,429);
  if(code?.includes('NOT_FOUND')) throw new AttachmentError(code,404);
  if(code==='UPLOAD_EXPIRED') throw new AttachmentError(code,410);
  if(code?.startsWith('IDEMPOTENCY_')) throw new AttachmentError(code,409);
  if(code==='INVALID_ATTACHMENT') throw new AttachmentError(code,400);
  throw new AttachmentError('ATTACHMENT_OPERATION_FAILED',500);
}
async function rpc(admin: SupabaseClient,name: string,args: Record<string,unknown>) {
  const {data,error}=await admin.rpc(name,args);
  if(error) failRpc(error);
  const result=Array.isArray(data)?data[0]:data;
  if(!result) throw new AttachmentError('ATTACHMENT_OPERATION_FAILED',500);
  return result;
}
function meta(row: Record<string,unknown>) {
  return {id:row.id,task_id:row.task_id,filename:row.filename,mime_type:row.mime_type,size_bytes:row.size_bytes,created_at:row.created_at};
}
export async function reserveAttachment(admin: SupabaseClient,client: Client,taskId: string,raw: unknown) {
  requireScope(client,'upload_attachment');
  const input=attachmentMetadata(raw);
  const row=await rpc(admin,'api_reserve_integration_attachment',{
    p_client_id:client.id,p_actor_id:client.actor_id,p_task_id:identity(taskId),
    p_request_id:input.request_id,p_filename:input.filename,p_mime_type:input.mime_type,
    p_size_bytes:input.size_bytes,p_sha256:input.sha256,
  });
  return {ok:true,request_id:input.request_id,attachment_id:row.attachment_id,
    completed:Boolean(row.completed_at),expires_at:row.expires_at,
    upload_path:`/attachment-uploads/${input.request_id}`};
}
export async function uploadAttachment(admin: SupabaseClient,client: Client,requestId: string,request: Request) {
  requireScope(client,'upload_attachment');
  const args={p_client_id:client.id,p_actor_id:client.actor_id,p_request_id:identity(requestId)};
  const row=await rpc(admin,'api_get_integration_upload',args);
  const contentType=request.headers.get('content-type')?.split(';')[0].trim();
  if(contentType!==row.mime_type && contentType!=='application/octet-stream') throw new AttachmentError('UNSUPPORTED_ATTACHMENT_TYPE',415);
  const bytes=await readAttachmentBytes(request.body,row.size_bytes);
  await verifyAttachment(bytes,row);
  const bucket=admin.storage.from(BUCKET);
  if(!row.completed_at) {
    const {error}=await bucket.upload(row.storage_path,bytes,{contentType:row.mime_type,upsert:false});
    // A retry may find the same immutable object left by a previous interrupted request.
    if(error && !['409','400'].includes(String((error as {statusCode?:string}).statusCode))) throw new AttachmentError('ATTACHMENT_STORAGE_FAILED',502);
  }
  // Verify persisted bytes, not merely the successful upload response, before publication.
  const {data:stored,error:downloadError}=await bucket.download(row.storage_path);
  if(downloadError || !stored) throw new AttachmentError('ATTACHMENT_STORAGE_VERIFY_FAILED',502);
  const storedBytes=await readAttachmentBytes(stored.stream(),row.size_bytes);
  await verifyAttachment(storedBytes,row);
  const attachment=await rpc(admin,'api_finalize_integration_attachment',args);
  return {ok:true,request_id:requestId,attachment:meta(attachment),verified:true};
}
export async function attachmentDownload(admin: SupabaseClient,client: Client,taskId: string,attachmentId: string) {
  requireScope(client,'read_tasks');
  const row=await rpc(admin,'api_read_integration_attachment',{
    p_client_id:client.id,p_actor_id:client.actor_id,p_task_id:identity(taskId),p_attachment_id:identity(attachmentId),
  });
  const {data,error}=await admin.storage.from(BUCKET).createSignedUrl(row.storage_path,60,{download:row.filename});
  if(error || !data?.signedUrl) throw new AttachmentError('ATTACHMENT_DOWNLOAD_FAILED',502);
  return {ok:true,attachment:meta(row),download_url:data.signedUrl,expires_in:60};
}
