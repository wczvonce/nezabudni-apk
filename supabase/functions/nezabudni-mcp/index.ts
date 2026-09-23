import { supabaseAdmin, handleContext, handleCreate, handleReadTasks, type IntegrationClient } from '../chatgpt-api/index.ts';
import { reserveAttachment, uploadAttachment, attachmentDownload } from '../chatgpt-api/attachments.ts';
import { fetchChatFile } from './files.js';
import { authenticateMcp, tokenVerifier, OAuthError } from './auth.ts';
import { serveMcp } from './server.ts';

const supabaseUrl=Deno.env.get('SUPABASE_URL')!.replace(/\/$/,'');
const resource=`${supabaseUrl}/functions/v1/nezabudni-mcp`;
const issuer=`${supabaseUrl}/auth/v1`;
const metadataUrl=`${resource}/.well-known/oauth-protected-resource`;
const verify=tokenVerifier(issuer,resource);
const json=(status:number,value:unknown,headers:Record<string,string>={})=>new Response(JSON.stringify(value),{
  status,headers:{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff',...headers},
});
async function invoke(client:IntegrationClient,name:string,args:Record<string,unknown>):Promise<Record<string,unknown>> {
  if(name==='get_nezabudni_context') return (await handleContext(client)).json();
  if(name==='search_nezabudni_tasks') {
    const url=new URL(`${resource}/tasks`);
    for(const [key,value] of Object.entries(args)) url.searchParams.set(key,String(value));
    return (await handleReadTasks(url,client,null)).json();
  }
  if(name==='get_nezabudni_task') return (await handleReadTasks(new URL(`${resource}/tasks`),client,String(args.task_id))).json();
  if(name==='create_nezabudni_task') {
    const result=await (await handleCreate(new Request(resource,{method:'POST',body:JSON.stringify(args)}),client)).json();
    if(result.ok && client.allowed_operations.includes('read_tasks')) {
      const read=await (await handleReadTasks(new URL(`${resource}/tasks`),client,result.task.id)).json();
      return {...result,verified_task:read.task};
    }
    return result;
  }
  if(name==='add_nezabudni_attachment') {
    const {bytes,metadata}=await fetchChatFile(args.file);
    const requestId=String(args.request_id);
    await reserveAttachment(supabaseAdmin,client,String(args.task_id),{...metadata,request_id:requestId});
    return await uploadAttachment(supabaseAdmin,client,requestId,new Request(resource,{method:'PUT',headers:{'content-type':metadata.mime_type},body:bytes}));
  }
  if(name==='get_nezabudni_attachment') return await attachmentDownload(supabaseAdmin,client,String(args.task_id),String(args.attachment_id));
  throw new Error('TOOL_NOT_ALLOWED');
}
export async function handleMcp(request:Request):Promise<Response> {
  const url=new URL(request.url);
  if(request.method==='GET' && url.pathname.endsWith('/.well-known/oauth-protected-resource')) {
    return json(200,{resource,authorization_servers:[issuer],scopes_supported:['openid'],bearer_methods_supported:['header']});
  }
  if(!url.pathname.replace(/\/$/,'').endsWith('/nezabudni-mcp')) return json(404,{error:'not_found'});
  if(request.method!=='POST') return json(405,{error:'method_not_allowed'},{allow:'POST'});
  // Browser-origin requests are not the server-to-server MCP transport.
  if(request.headers.has('origin')) return json(403,{error:'origin_not_allowed'});
  try {
    const client=await authenticateMcp(request,supabaseAdmin,resource,verify);
    // Bounded request JSON, including when Content-Length is missing or false.
    const reader=request.body?.getReader(); if(!reader)return json(400,{error:'invalid_request'});
    const chunks:Uint8Array[]=[];let size=0;
    try {
      while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;
        if(size>65536){await reader.cancel();return json(413,{error:'request_too_large'});}chunks.push(value);}
    } finally {reader.releaseLock();}
    const body=new Uint8Array(size);let offset=0;for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.length;}
    const forwarded=new Request(request.url,{method:'POST',headers:request.headers,body});
    const response=await serveMcp(forwarded,client,(name,args)=>invoke(client,name,args));
    response.headers.set('cache-control','no-store');
    return response;
  } catch(error) {
    if(error instanceof OAuthError) return json(401,{error:'unauthorized'},{'www-authenticate':`Bearer resource_metadata="${metadataUrl}"`});
    return json(500,{error:'mcp_request_failed'});
  }
}
if(import.meta.main) Deno.serve(handleMcp);
