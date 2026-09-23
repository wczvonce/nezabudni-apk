import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT } from 'npm:jose@6.2.12';
import { tokenVerifier, authenticateMcp } from '../supabase/functions/nezabudni-mcp/auth.ts';
import { serveMcp } from '../supabase/functions/nezabudni-mcp/server.ts';
import { fileDownloadUrl, fetchChatFile } from '../supabase/functions/nezabudni-mcp/files.js';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.108.2';
import type { IntegrationClient } from '../supabase/functions/chatgpt-api/index.ts';
const id=(n:number)=>`${String(n).padStart(8,'0')}-0000-4000-8000-000000000000`;
const issuer='https://example.test/auth/v1', resource='https://example.test/mcp';
const client:IntegrationClient={id:id(1),actor_id:id(2),name:'Synthetic',active:true,allowed_operations:['create_task','read_tasks','upload_attachment'],expires_at:'2099-01-01'};

Deno.test('MCP SDK initialize, tool discovery and calls use real Streamable HTTP transport',async()=>{
  const invoke=async(name:string,args:Record<string,unknown>)=>({ok:true,name,args});
  const request=(method:string,params:unknown={},messageId=1)=>new Request(resource,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:messageId,method,params})});
  let response=await serveMcp(request('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'Synthetic',version:'1'}}),client,invoke);
  assert.equal(response.status,200);
  assert.equal((await response.json()).result.serverInfo.name,'nezabudni');
  response=await serveMcp(request('tools/list'),client,invoke);
  const tools=(await response.json()).result.tools;
  assert.equal(tools.length,6);
  const attachment=tools.find((t:{name:string})=>t.name==='add_nezabudni_attachment');
  assert.deepEqual(attachment._meta['openai/fileParams'],['file']);
  assert.deepEqual(attachment.inputSchema.properties.file.required,['download_url','file_id']);
  assert.equal(attachment.inputSchema.properties.file.properties.file_name.type,'string');
  assert.equal(attachment.annotations.readOnlyHint,false);
  response=await serveMcp(request('tools/call',{name:'get_nezabudni_context',arguments:{}}),client,invoke);
  assert.equal((await response.json()).result.structuredContent.ok,true);
  response=await serveMcp(request('tools/call',{name:'get_nezabudni_task',arguments:{}}),client,invoke);
  assert.equal((await response.json()).result.isError,true);
  const limited={...client,allowed_operations:['create_task']};
  response=await serveMcp(request('tools/list'),limited,invoke);
  assert.deepEqual((await response.json()).result.tools.map((t:{name:string})=>t.name),['get_nezabudni_context','create_nezabudni_task']);
  response=await serveMcp(request('tools/call',{name:'search_nezabudni_tasks',arguments:{}}),limited,invoke);
  assert.equal((await response.json()).result.isError,true);
});

Deno.test('OAuth cryptographic signature, audience, issuer, expiry, role and binding',async()=>{
  const {privateKey,publicKey}=await generateKeyPair('ES256');
  const verify=tokenVerifier(issuer,resource,async()=>publicKey);
  const claims={sub:client.actor_id,client_id:id(3),integration_id:client.id,role:'nezabudni_mcp',scope:'openid read_tasks create_task upload_attachment'};
  const sign=(override:Record<string,unknown>={})=>new SignJWT({...claims,...override}).setProtectedHeader({alg:'ES256'}).setIssuer(issuer).setAudience(resource).setIssuedAt().setExpirationTime('5m').sign(privateKey);
  const token=await sign();assert.equal((await verify(token)).sub,client.actor_id);
  await assert.rejects(()=>verify(`${token.slice(0,-8)}xxxxxxxx`));
  const wrongAudience=await new SignJWT(claims).setProtectedHeader({alg:'ES256'}).setIssuer(issuer).setAudience('wrong').setIssuedAt().setExpirationTime('5m').sign(privateKey);
  await assert.rejects(()=>verify(wrongAudience));
  await assert.rejects(()=>sign({role:'authenticated'}).then(verify));
  const expired=await new SignJWT(claims).setProtectedHeader({alg:'ES256'}).setIssuer(issuer).setAudience(resource).setIssuedAt().setExpirationTime(1).sign(privateKey);
  await assert.rejects(()=>verify(expired));
  let active=true;
  const admin={from(table:string){const filters:Record<string,unknown>={};return {
    select(){return this;},eq(key:string,value:unknown){filters[key]=value;return this;},
    async maybeSingle(){
      if(table==='integration_clients') {assert.equal(filters.id,client.id);assert.equal(filters.actor_id,client.actor_id);assert.equal(filters.oauth_client_id,id(3));return {data:{...client,active,allowed_operations:['read_tasks']},error:null};}
      return {data:{active:true,resource_uri:resource,allowed_operations:['read_tasks','create_task']},error:null};
    },
  };}} as unknown as SupabaseClient;
  const request=new Request(resource,{headers:{authorization:`Bearer ${token}`}});
  assert.deepEqual((await authenticateMcp(request,admin,resource,verify)).allowed_operations,['read_tasks']);
  active=false;await assert.rejects(()=>authenticateMcp(request,admin,resource,verify));
  await assert.rejects(()=>authenticateMcp(new Request(resource),admin,resource,verify));
});

Deno.test('Native file input blocks arbitrary hosts/redirects and computes actual MIME/hash',async()=>{
  for(const url of ['http://files.oaiusercontent.com/a','https://127.0.0.1/a','https://files.oaiusercontent.com.evil.test/a','https://files.oaiusercontent.com:444/a','https://user:pass@files.oaiusercontent.com/a']) assert.throws(()=>fileDownloadUrl(url));
  const pdf=new TextEncoder().encode('%PDF-1.7\nSynthetic MCP\n%%EOF');
  const fetcher=async(_url:unknown,options:RequestInit={})=>{
    assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');
    return new Response(pdf);
  };
  const result=await fetchChatFile({download_url:'https://files.oaiusercontent.com/synthetic',file_id:'synthetic-file'},fetcher);
  assert.equal(result.metadata.mime_type,'application/pdf');
  assert.equal(result.metadata.filename,'attachment.pdf');
  assert.equal(result.metadata.sha256.length,64);
  await assert.rejects(()=>fetchChatFile({download_url:'https://files.oaiusercontent.com/synthetic',file_id:'synthetic-file',mime_type:'image/jpeg'},fetcher));
});
