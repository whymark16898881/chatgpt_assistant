import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';import {tmpdir} from 'node:os';import{createHash}from'node:crypto';
import {parsePortfolioManifest,readVerifiedPortfolioExport,verifyManifestIdentity,PORTFOLIO_FILES} from '../lib/portfolio-manifest.mjs';
const root=await mkdtemp(path.join(tmpdir(),'manifest-check-'));after(()=>rm(root,{recursive:true,force:true}));const hash=b=>createHash('sha256').update(b).digest('hex');
function fixture(){const p={schema:'positions_latest/v1',snapshot_id:'test-snapshot',generated_at:'2026-11-15T13:24:32+08:00',complete:true,stale:false,coverage:{moomoo:{ok:true},tiger:{ok:true},futubull:{ok:true}}};const bytes=Object.fromEntries(PORTFOLIO_FILES.map(n=>[n,Buffer.from(n.endsWith('.json')?JSON.stringify(n==='positions_latest.json'?p:{ts:'2026-11-15 12:23:59'}):'column\nvalue\n')]));
 const m={schema:'cfo-export/v1',export_id:'test-export',exported_at:'2026-11-15T13:28:32+08:00',source:{snapshot_id:p.snapshot_id,generated_at:p.generated_at,complete:p.complete,stale:p.stale,coverage:p.coverage},files:PORTFOLIO_FILES.map(name=>({name,status:'ok',sha256:hash(bytes[name]),bytes:bytes[name].length,source_mtime:name.startsWith('nontrade')?'2026-11-10T12:00:00+08:00':'2026-11-15T13:24:32+08:00'}))};return{m,bytes};}
const text=m=>Buffer.from(JSON.stringify(m));
test('real manifest field shape verifies all13 files while old historical mtimes remain valid',async()=>{const {m,bytes}=fixture();let manifests=0;const result=await readVerifiedPortfolioExport(root,{read:async(_,name)=>name==='manifest.json'?(manifests++,text(m)):bytes[name]});assert.equal(Object.keys(result).length,14);assert.equal(manifests,2);assert.equal(verifyManifestIdentity(result).export_id,'test-export');});
test('changed file with unchanged manifest is rejected before data import',async()=>{const {m,bytes}=fixture();bytes['trades.csv']=Buffer.from('different');await assert.rejects(readVerifiedPortfolioExport(root,{read:async(_,n)=>n==='manifest.json'?text(m):bytes[n]}),e=>e.code==='HASH_MISMATCH');});
test('batch changes mid-read are rejected, including same exportID with modified manifest content',async()=>{for(const sameId of[false,true]){const{m,bytes}=fixture();let reads=0;await assert.rejects(readVerifiedPortfolioExport(root,{read:async(_,n)=>{if(n!=='manifest.json')return bytes[n];if(++reads===1)return text(m);return text({...m,export_id:sameId?m.export_id:'next-export',contract:'changed'});}}),e=>e.code==='SOURCE_CHANGED_RETRY');}});
test('retained previous, missing and copy-failed files cannot masquerade as a complete export',()=>{for(const change of[{kept_previous:true},{status:'missing_source'},{status:'copy_failed: source vanished'}]){const{m}=fixture();Object.assign(m.files[0],change);assert.throws(()=>parsePortfolioManifest(text(m).toString()),e=>e.code==='INCOMPLETE_EXPORT');}});
test('unexpected paths, duplicated/missing names, bad hashes and byte counts fail closed',()=>{
 for(const mutate of[m=>m.files[0].name='../secrets/key',m=>m.files[0].name=m.files[1].name,m=>m.files.pop(),m=>m.files[0].sha256='bad',m=>m.files[0].bytes=-1,m=>m.files[0].bytes=17*1024*1024]){const{m}=fixture();mutate(m);assert.throws(()=>parsePortfolioManifest(text(m).toString()));}
});
test('declared batch size over64MiB fails before any large body allocation',()=>{const{m}=fixture();for(const f of m.files)f.bytes=16*1024*1024;assert.throws(()=>parsePortfolioManifest(text(m).toString()),e=>e.code==='SOURCE_TOO_LARGE');});
test('valid UTF8 BOM is preserved for hashing; invalid UTF8 is rejected',async()=>{
 const{m,bytes}=fixture();bytes['trades.csv']=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),bytes['trades.csv']]);const f=m.files.find(x=>x.name==='trades.csv');f.sha256=hash(bytes[f.name]);f.bytes=bytes[f.name].length;const read=async(_,n)=>n==='manifest.json'?text(m):bytes[n];const good=await readVerifiedPortfolioExport(root,{read});assert.equal(good['trades.csv'].charCodeAt(0),0xfeff);verifyManifestIdentity(good);
 bytes['trades.csv']=Buffer.from([255]);f.sha256=hash(bytes[f.name]);f.bytes=1;await assert.rejects(readVerifiedPortfolioExport(root,{read}),e=>e.code==='INVALID_SOURCE_ENCODING');
});
test('manifest snapshot identity and coverage must match actual JSON, not just file hashes',async()=>{
 const{m,bytes}=fixture();m.source.snapshot_id='not-the-actual-snapshot';const result=await readVerifiedPortfolioExport(root,{read:async(_,n)=>n==='manifest.json'?text(m):bytes[n]});assert.throws(()=>verifyManifestIdentity(result),e=>e.code==='MANIFEST_SOURCE_MISMATCH');
});
test('on-disk regular file read validates exact manifest contract',async()=>{const{m,bytes}=fixture();for(const[n,b]of Object.entries(bytes))await writeFile(path.join(root,n),b);await writeFile(path.join(root,'manifest.json'),text(m));const result=await readVerifiedPortfolioExport(root);assert.equal(verifyManifestIdentity(result).source.complete,true);});

function addAccountResult(f){const name='account_results.json',body=Buffer.from(JSON.stringify({schema:'account_results/v1',accounts:[]}));f.bytes[name]=body;f.m.files.push({name,status:'ok',sha256:hash(body),bytes:body.length,source_mtime:f.m.exported_at});return f;}
test('transition accepts only the optional account-results fourteenth file with exact hash checks',async()=>{
 const{m,bytes}=addAccountResult(fixture());const read=async(_,n)=>n==='manifest.json'?text(m):bytes[n];const r=await readVerifiedPortfolioExport(root,{read});assert.equal(JSON.parse(r['account_results.json']).schema,'account_results/v1');assert.equal(verifyManifestIdentity(r).files.length,14);
 bytes['account_results.json']=Buffer.from('corrupted');await assert.rejects(readVerifiedPortfolioExport(root,{read}),e=>e.code==='HASH_MISMATCH');
});
test('optional account results cannot replace any base file or expand the allowlist arbitrarily',()=>{
 const f=addAccountResult(fixture());f.m.files.shift();assert.throws(()=>parsePortfolioManifest(text(f.m).toString()),e=>e.code==='INVALID_MANIFEST');
 const other=addAccountResult(fixture());other.m.files[13].name='credentials.json';assert.throws(()=>parsePortfolioManifest(text(other.m).toString()),e=>e.code==='INVALID_MANIFEST');
});
test('failed optional account results invalidate a 14-file batch without dropping the prior accepted snapshot',()=>{
 const f=addAccountResult(fixture());f.m.files[13].kept_previous=true;assert.throws(()=>parsePortfolioManifest(text(f.m).toString()),e=>e.code==='INCOMPLETE_EXPORT');
});

test('opaque timestamp/UUID export IDs and optional diagnostic content digests keep full per-file verification',async()=>{
 const{m,bytes}=fixture();m.export_id='20261115T175127+0800#0123abcd';m.content_digest='12345678';const r=await readVerifiedPortfolioExport(root,{read:async(_,n)=>n==='manifest.json'?text(m):bytes[n]});assert.equal(verifyManifestIdentity(r).export_id,m.export_id);
 bytes['trades.csv']=Buffer.from('corrupt');await assert.rejects(readVerifiedPortfolioExport(root,{read:async(_,n)=>n==='manifest.json'?text(m):bytes[n]}),e=>e.code==='HASH_MISMATCH');
});

test('declared failed entries with null metadata are INCOMPLETE_EXPORT, not malformed-success INVALID_MANIFEST',()=>{
 for(const [optional,status]of[[false,'missing_source'],[true,'generate_failed']])for(const kept_previous of[false,true]){
  const f=optional?addAccountResult(fixture()):fixture();const entry=optional?f.m.files.at(-1):f.m.files[0];Object.assign(entry,{status,sha256:null,bytes:null,source_mtime:null,kept_previous});
  assert.throws(()=>parsePortfolioManifest(text(f.m).toString()),e=>e.code==='INCOMPLETE_EXPORT');
 }
});
