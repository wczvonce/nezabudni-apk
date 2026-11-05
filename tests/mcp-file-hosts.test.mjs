import assert from 'node:assert/strict';
import { fileDownloadUrl, fetchChatFile } from '../supabase/functions/nezabudni-mcp/files.js';
for (const host of ['files.oaiusercontent.com','sdmntpritalynorth.oaiusercontent.com','sdmntprwestus3.oaiusercontent.com']) {
  const url=`https://${host}/file?sig=synthetic`;
  assert.equal(fileDownloadUrl(url),url);
}
for (const url of [
  'https://sdmntpritalynorth.oaiusercontent.com.evil.test/a',
  'https://sdmntpritalynorth.evil.oaiusercontent.com/a',
  'https://evil.oaiusercontent.com/a','https://127.0.0.1/a',
  'http://sdmntpritalynorth.oaiusercontent.com/a',
  'https://sdmntpritalynorth.oaiusercontent.com:444/a',
  'https://user:pass@sdmntpritalynorth.oaiusercontent.com/a',
  'https://sdmntpritalynorth.oaiusercontent.com/a#fragment',
]) assert.throws(()=>fileDownloadUrl(url));
const jpg=new Uint8Array([255,216,255,224,0,16]);
const result=await fetchChatFile({file_id:'synthetic-file',file_name:'sample.jpg',mime_type:'image/jpeg',download_url:'https://sdmntpritalynorth.oaiusercontent.com/synthetic'},async(url,opts)=>{
  assert.equal(opts.redirect,'error'); assert.equal(opts.credentials,'omit');
  return new Response(jpg);
});
assert.equal(result.metadata.mime_type,'image/jpeg');
assert.equal(result.metadata.size_bytes,jpg.length);
assert.equal(result.metadata.sha256.length,64);
console.log('Regional file host acceptance, SSRF guards and download checks: passed');
