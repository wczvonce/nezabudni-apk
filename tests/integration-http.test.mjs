import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { build } from 'esbuild';

const id = n => `${String(n).padStart(8,'0')}-0000-4000-8000-000000000000`;
const A=id(1), B=id(2), C=id(3), CLIENT=id(4), P=id(5), TASK=id(6);
const token = 'synthetic_test_token_never_valid_on_a_real_server';
const hash = Buffer.from(await webcrypto.subtle.digest('SHA-256',new TextEncoder().encode(token))).toString('hex');
let scopes = ['create_task','read_tasks'];
let requests=[];
let readResult = [{ id:TASK, title:'Synthetic task', attachments:[], attachment_count:0 }];
let rpcError = null;
const uploads=new Map(), objects=new Map();
let finalized=0;
const profiles = [{id:A,display_name:'Owner'},{id:B,display_name:'Partner'},{id:C,display_name:'Third'}];
const admin = {
  from(table) {
    const eq = {};
    const builder = {
      select() { return this; }, eq(key,value) { eq[key]=value;return this; },
      is(key,value) { eq[key]=value;return this; },
      in() { return this; }, order() { return this; },
      maybeSingle() { return this; },
      then(resolve,reject) {
        let data;
        if (table==='integration_clients') data=eq.token_hash===hash ? {id:CLIENT,actor_id:A,active:true,expires_at:'2099-01-01',allowed_operations:scopes}:null;
        else if(table==='pair_members') data=eq.user_id ? {pair_id:P}:profiles.map(p=>({user_id:p.id}));
        else if(table==='profiles') data=profiles;
        else if(table==='pair_primary_partners') data={partner_id:B};
        else throw new Error(`Unexpected table ${table}`);
        return Promise.resolve({data,error:null}).then(resolve,reject);
      },
    };
    return builder;
  },
  async rpc(name,args) {
    requests.push({name,args});
    if (rpcError) return {data:null,error:{message:rpcError}};
    if(name==='api_read_tasks_from_integration') return {data:readResult,error:null};
    if(name==='api_create_task_from_integration') return {data:{id:TASK,title:args.p_title,due_at:args.p_due_at,timezone:args.p_timezone,status:'pending'},error:null};
    if(name==='api_reserve_integration_attachment') {
      if(!uploads.has(args.p_request_id)) uploads.set(args.p_request_id,{
        attachment_id:args.p_request_id,request_id:args.p_request_id,task_id:args.p_task_id,
        storage_path:`${P}/${args.p_task_id}/${args.p_request_id}`,filename:args.p_filename,
        mime_type:args.p_mime_type,size_bytes:args.p_size_bytes,sha256:args.p_sha256,
        expires_at:'2099-01-01',completed_at:null,
      });
      return {data:uploads.get(args.p_request_id),error:null};
    }
    if(name==='api_get_integration_upload') return {data:uploads.get(args.p_request_id),error:null};
    if(name==='api_finalize_integration_attachment') {
      const row=uploads.get(args.p_request_id);
      if(!row.completed_at) finalized++;
      row.completed_at='2027-01-01';
      return {data:{...row,id:row.attachment_id},error:null};
    }
    if(name==='api_read_integration_attachment') {
      const row=uploads.get(args.p_attachment_id);
      return {data:row?.completed_at?{...row,id:row.attachment_id}:null,error:null};
    }
    throw new Error(`Unexpected RPC ${name}`);
  },
  storage:{from(bucket){
    assert.equal(bucket,'task-attachments');
    return {
      async upload(path,bytes,options){
        assert.equal(options.upsert,false);
        if(objects.has(path)) return {error:{statusCode:'409'}};
        objects.set(path,new Blob([bytes],{type:options.contentType}));return {error:null};
      },
      async download(path){return {data:objects.get(path),error:null};},
      async createSignedUrl(path,seconds,options){
        assert.equal(seconds,60);assert.ok(options.download);
        assert.ok(objects.has(path));return {data:{signedUrl:'https://example.test/synthetic-signed-file'},error:null};
      },
    };
  }},
};
let handle;
const bundled=await build({entryPoints:['supabase/functions/chatgpt-api/index.ts'],bundle:true,write:false,format:'iife',platform:'neutral',define:{'import.meta.main':'true'},plugins:[{
  name:'isolated-test-database',setup(b){
    b.onResolve({filter:/^npm:/},()=>({path:'supabase-test-client',namespace:'test'}));
    b.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'export const createClient = () => globalThis.testAdmin;',loader:'js'}));
  },
}]});
vm.runInNewContext(bundled.outputFiles[0].text,{testAdmin:admin,crypto:webcrypto,TextEncoder,TextDecoder,URL,URLSearchParams,Response,Request,console,
  Deno:{env:{get:()=> 'synthetic-env'},serve:fn=>{handle=fn;}}});
async function call(path,body,key=token) {
  const headers={}; if(key)headers['x-nezabudni-action-key']=key;
  return handle(new Request(`https://example.test/functions/v1/chatgpt-api${path}`,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined}));
}
assert.equal((await call('/context',null,null)).status,401);
assert.equal((await call('/tasks',null,'invalid_token_that_has_at_least_32_characters')).status,401);
let context=await (await call('/context')).json();
assert.equal(context.members.length,3);
assert.equal(context.partner.display_name,'Partner');
assert.equal(context.members.find(p=>p.id===C).display_name,'Third');
let response=await call('/tasks?query=Synthetic&status=pending');
assert.equal(response.status,200);
assert.equal((await response.json()).tasks[0].id,TASK);
assert.equal(requests.at(-1).args.p_actor_id,A);
assert.equal(requests.at(-1).args.p_client_id,CLIENT);
assert.equal(requests.at(-1).args.p_query,'Synthetic');
assert.equal((await call(`/tasks/${TASK}`)).status,200);
assert.equal(requests.at(-1).args.p_task_id,TASK);
assert.equal((await call(`/tasks/${TASK}?limit=1`)).status,400);
assert.equal((await call('/tasks?limit=999')).status,400);
readResult=[];
assert.equal((await call(`/tasks/${TASK}`)).status,404);
scopes=['create_task'];
const count=requests.length;
assert.equal((await call('/tasks')).status,403);
assert.equal(requests.length,count,'No read RPC without read scope');
scopes=['read_tasks'];
const body={request_id:id(7),title:'Synthetic task',local_date:'2027-01-10',local_time:'10:00',timezone:'Europe/Bratislava',assignee_id:C};
assert.equal((await call('/reminders',body)).status,403);
scopes=['create_task','read_tasks'];
assert.equal((await call('/reminders',body)).status,200);
assert.equal(requests.at(-1).args.p_assigned_to,C);
assert.equal(requests.at(-1).args.p_due_at,'2027-01-10T09:00:00.000Z');
assert.equal((await call('/reminders',{...body,assignee_id:id(99)})).status,400);
assert.equal((await call('/reminders',{...body,assignee:'partner'})).status,400);
const {assignee_id:_,...legacy}=body;
assert.equal((await call('/reminders',{...legacy,assignee:'partner'})).status,200);
assert.equal(requests.at(-1).args.p_assigned_to,B,'Legacy partner mapping unchanged');
rpcError='INTEGRATION_UNAUTHORIZED';
assert.equal((await call('/tasks')).status,401,'Revocation race checked again by database');
rpcError='internal confidential database error';
response=await call('/tasks');
assert.equal(response.status,500);
assert.equal((await response.text()).includes(rpcError),false);
rpcError=null;
let sequence=20;
for(const [mime,bytes] of [
  ['application/pdf',new TextEncoder().encode('%PDF-1.7\nSynthetic HTTP fixture\n%%EOF\n')],
  ['image/jpeg',new Uint8Array([255,216,255,224,0,16,74,70,73,70,0,255,217])],
]) {
  const requestId=id(sequence++);
  const sha=Buffer.from(await webcrypto.subtle.digest('SHA-256',bytes)).toString('hex');
  const input={request_id:requestId,filename:'synthetic-file',mime_type:mime,size_bytes:bytes.length,sha256:sha};
  scopes=['create_task'];
  assert.equal((await call(`/tasks/${TASK}/attachments`,input)).status,403);
  scopes=['upload_attachment','read_tasks'];
  const reserved=await (await call(`/tasks/${TASK}/attachments`,input)).json();
  assert.equal(reserved.ok,true);
  assert.equal('storage_path' in reserved,false);
  const put=(data,type=mime)=>handle(new Request(`https://example.test/functions/v1/chatgpt-api${reserved.upload_path}`,{
    method:'PUT',headers:{'x-nezabudni-action-key':token,'content-type':type},body:data,
  }));
  assert.equal((await put(bytes,'text/html')).status,415);
  assert.equal((await put(bytes.slice(1))).status,400);
  response=await put(bytes);
  assert.equal(response.status,200);
  assert.equal((await response.json()).verified,true);
  response=await put(bytes);
  assert.equal(response.status,200);
  assert.equal((await response.json()).attachment.id,requestId);
  const download=await (await call(`/tasks/${TASK}/attachments/${requestId}`)).json();
  assert.equal(download.download_url,'https://example.test/synthetic-signed-file');
  assert.equal(download.expires_in,60);
  assert.equal('storage_path' in download.attachment,false);
  scopes=['upload_attachment'];
  assert.equal((await call(`/tasks/${TASK}/attachments/${requestId}`)).status,403);
}
assert.equal(finalized,2,'Two files and their retries create only two finalized attachments');
assert.equal(objects.size,2,'Retries never overwrite stored objects');
console.log('Attachment HTTP: JPG/PDF binary upload, persisted read-back, retry, invalid content-type/size, permissions, signed download metadata passed (mock Storage).');
console.log('Integration HTTP: auth, read scopes, RPC scoping, filters, third-member create and legacy Action compatibility passed (mock database transport).');
