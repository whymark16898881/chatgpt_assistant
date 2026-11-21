import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {connectDatabase} from '../lib/db.mjs';
import {documentService} from '../lib/documents.mjs';
import {readPdf,pdfOverview} from '../lib/pdf.mjs';
import {batchSummary} from '../lib/batch-summary.mjs';
import {recordEvent,requestKey} from '../lib/ledger.mjs';
import {financeMcp} from '../lib/mcp.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
if(!process.env.DATABASE_URL)process.env.DATABASE_URL=(await readFile('.env.test','utf8')).trim().split('DATABASE_URL=')[1];
if(!new URL(process.env.DATABASE_URL).pathname.endsWith('_test'))throw new Error('Use isolated *_test database');
const pool=await connectDatabase(),dir=await mkdtemp(path.join(tmpdir(),'cfo-pdf-'));
after(async()=>{await pool.end();await rm(dir,{recursive:true,force:true});});
const reset=()=>pool.query('TRUNCATE cfo_audit,cfo_event_sources,cfo_lines,cfo_entries,cfo_events,cfo_documents RESTART IDENTITY CASCADE; DELETE FROM cfo_accounts WHERE system_key IS NULL');
const fixture=name=>readFile(path.join('tests','fixtures',name));

// Synthetic PDFs are generated here so the suite never depends on a real statement.
function buildPdf(objects,trailerExtra=''){
 let out=Buffer.from('%PDF-1.4\n');const offsets=[];
 objects.forEach((body,i)=>{offsets.push(out.length);out=Buffer.concat([out,Buffer.from(`${i+1} 0 obj\n`),Buffer.isBuffer(body)?body:Buffer.from(body),Buffer.from('\nendobj\n')]);});
 const xref=out.length;let table=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;
 for(const offset of offsets)table+=String(offset).padStart(10,'0')+' 00000 n \n';
 return Buffer.concat([out,Buffer.from(table+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R ${trailerExtra}>>\nstartxref\n${xref}\n%%EOF\n`)]);
}
const stream=(dict,body)=>Buffer.concat([Buffer.from(`<< ${dict} /Length ${body.length} >>\nstream\n`),Buffer.from(body),Buffer.from('\nendstream')]);
function textPdf(pages){
 const head=['<< /Type /Catalog /Pages 2 0 R >>',null,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'],kids=[],rest=[];
 pages.forEach((lines,i)=>{
  const pageNumber=4+i*2;kids.push(`${pageNumber} 0 R`);
  const content=['BT /F1 11 Tf'].concat(lines.map(([x,y,text])=>`1 0 0 1 ${x} ${y} Tm (${text.replace(/([()\\])/g,'\\$1')}) Tj`)).concat('ET').join('\n');
  rest.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageNumber+1} 0 R >>`,stream('',content));
 });
 head[1]=`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`;
 return buildPdf(head.concat(rest));
}
function imageOnlyPdf({width=120,height=160}={}){
 const raw=Buffer.alloc(width*height);for(let i=0;i<raw.length;i++)raw[i]=(i*7)%256;
 return buildPdf(['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>',
  stream(`/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`,zlib.deflateSync(raw)),
  stream('','q 300 0 0 400 0 0 cm /Im0 Do Q')]);
}
const encryptedPdf=()=>buildPdf(['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>',
 `<< /Filter /Standard /V 2 /R 3 /Length 128 /P -1340 /O <${'ab'.repeat(32)}> /U <${'cd'.repeat(32)}> >>`],
 '/Encrypt 4 0 R /ID [<0123456789abcdef0123456789abcdef> <0123456789abcdef0123456789abcdef>] ');

const column=(text,needle)=>text.split('\n').map(line=>line.indexOf(needle)).find(index=>index>=0);

test('a text-layer statement is read as real text with its columns still distinguishable',async()=>{
 const bytes=await fixture('synthetic-statement-text.pdf');
 assert.deepEqual(await pdfOverview(bytes),{page_count:1,probed_pages:1,has_text_layer:true,kind:'text_layer',read_hint:'用cfo_read_document按页读取真实文本后再提交候选交易'});
 const result=await readPdf(bytes);
 assert.equal(result.page_count,1);assert.equal(result.text_page_count,1);assert.equal(result.image_page_count,0);assert.equal(result.truncated,false);
 const text=result.pages[0].text;
 assert.equal(result.pages[0].kind,'text');
 for(const fact of ['012-345678-9','1,250.00','7,800.00','16,156.22','工资','利息'])assert.ok(text.includes(fact),'missing '+fact);
 // Compatibility glyphs from the producer's ToUnicode map must not survive as separate characters.
 assert.ok(text.includes('月')&&text.includes('结单')&&!text.includes('⽉'));
 // A withdrawal must not read as a deposit: each amount stays under its own heading.
 assert.ok(Math.abs(column(text,'1,250.00')-column(text,'支'))<=6,'withdrawal column drifted');
 assert.ok(Math.abs(column(text,'7,800.00')-column(text,'存'))<=6,'deposit column drifted');
 assert.ok(Math.abs(column(text,'8,430.25')-column(text,'余'))<=6,'balance column drifted');
});

test('a scanned statement has no text layer and comes back as a rendered page image, never as empty text',async()=>{
 const bytes=await fixture('synthetic-statement-scan.pdf');
 const overview=await pdfOverview(bytes);
 assert.equal(overview.has_text_layer,false);assert.equal(overview.kind,'scanned_or_image_only');
 const result=await readPdf(bytes);
 assert.equal(result.text_page_count,0);
 const page=result.pages[0];
 assert.ok(['image','unreadable'].includes(page.kind));
 if(page.kind==='image'){
  assert.equal(result.image_page_count,1);
  assert.equal(page.image.mime,'image/jpeg');
  assert.deepEqual(page.image.bytes.subarray(0,3),Buffer.from([0xff,0xd8,0xff]));
  assert.ok(page.image.width>=800&&page.image.bytes.length>2000);
 }else assert.equal(page.reason,'renderer_missing','a scan must name why it could not be rendered');
});

test('page selection, budgets and damaged files are explicit rather than silently short',async()=>{
 const bytes=textPdf([[[60,760,'Page one 2026-11-02 CNY 12.34'],[60,740,'merchant alpha']],[[60,760,'Page two 2026-11-03 CNY 56.78']],[[60,760,'Page three closing 99.00']]]);
 const all=await readPdf(bytes);
 assert.equal(all.page_count,3);assert.equal(all.text_page_count,3);assert.equal(all.truncated,false);
 const capped=await readPdf(bytes,{maxTextPages:1});
 assert.equal(capped.truncated,true);assert.deepEqual(capped.skipped_pages,[2,3]);assert.equal(capped.pages.length,1);
 const budgeted=await readPdf(bytes,{textBudget:40});
 assert.equal(budgeted.pages.length,1);assert.deepEqual(budgeted.skipped_pages,[2,3]);
 const selected=await readPdf(bytes,{pages:[3,3]});
 assert.deepEqual(selected.pages.map(p=>p.page),[3]);assert.ok(selected.pages[0].text.includes('99.00'));
 await assert.rejects(readPdf(bytes,{pages:[9]}),{code:'PDF_PAGE_OUT_OF_RANGE'});
 await assert.rejects(readPdf(encryptedPdf()),{code:'PDF_PASSWORD_REQUIRED'});
 await assert.rejects(readPdf(Buffer.from('synthetic bytes that are not a PDF')),{code:'PDF_UNREADABLE'});
 const scan=await readPdf(imageOnlyPdf(),{maxImagePages:0});
 assert.deepEqual(scan.skipped_pages,[1]);assert.equal(scan.truncated,true);
});

function mcpFor(download){
 const docs=documentService(pool,dir,{download});
 return async()=>{const server=financeMcp(pool,docs),client=new Client({name:'pdf-ingest',version:'1'});const [ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);await client.connect(ct);return{client,docs};};
}
const call=async(client,name,args)=>{const r=await client.callTool({name,arguments:args});assert.ok(!r.isError,JSON.stringify(r.content));return r;};

test('an uploaded PDF is archived, flagged as readable and returns its real text through the tool',async()=>{
 await reset();
 const statement=await fixture('synthetic-statement-text.pdf'),scan=await fixture('synthetic-statement-scan.pdf');
 const connect=mcpFor(async file=>({bytes:file.file_id==='scan'?scan:statement,mime:'application/pdf'}));
 const {client}=await connect();
 const captured=(await call(client,'cfo_capture',{files:[{download_url:'https://files.example.com/a.pdf',file_id:'statement',file_name:'statement.pdf',mime_type:'application/pdf'},{download_url:'https://files.example.com/b.pdf',file_id:'scan',file_name:'scan.pdf',mime_type:'application/pdf'}],candidates:[]})).structuredContent;
 assert.equal(captured.documents.length,2);assert.equal(captured.events.length,0);assert.equal(captured.financial_transaction_posted,false);
 assert.equal(captured.documents[0].mime_type,'application/pdf');
 assert.equal(captured.documents[0].pdf.has_text_layer,true);assert.equal(captured.documents[0].pdf.page_count,1);
 assert.equal(captured.documents[1].pdf.has_text_layer,false);assert.equal(captured.documents[1].pdf.kind,'scanned_or_image_only');
 const read=await call(client,'cfo_read_document',{document_id:captured.documents[0].id});
 const body=read.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
 assert.ok(body.includes('1,250.00')&&body.includes('16,156.22'));
 const meta=JSON.parse(read.content.at(-1).text);
 assert.equal(meta.page_count,1);assert.deepEqual(meta.text_pages,[1]);assert.equal(meta.truncated,false);assert.equal(meta.document_id,captured.documents[0].id);
 const scanned=await call(client,'cfo_read_document',{document_id:captured.documents[1].id});
 const scanMeta=JSON.parse(scanned.content.at(-1).text);
 assert.equal(scanMeta.page_count,1);assert.deepEqual(scanMeta.text_pages,[]);
 if(scanned.content.some(c=>c.type==='image')){
  assert.deepEqual(scanMeta.image_pages,[1]);
  assert.equal(scanned.content.find(c=>c.type==='image').mimeType,'image/jpeg');
 }else{
  assert.deepEqual(scanMeta.unreadable_pages,[1]);
  assert.ok(scanned.content.some(c=>c.type==='text'&&c.text.includes('请改传该页截图')));
 }
 // Facts read from the PDF are posted against the already archived original, without a second upload.
 const posted=(await call(client,'cfo_record_existing_document',{document_id:captured.documents[0].id,candidates:[{source_ref:'page1:row3',payload:{kind:'income',date:'2026-10-12',amount:'7800.00',currency:'SGD',description:'SALARY CREDIT 工资'}}]})).structuredContent;
 assert.equal(posted.events.length,1);
 assert.equal((await pool.query('SELECT count(*)::int n FROM cfo_documents')).rows[0].n,2);
});

test('a PDF that cannot be parsed is reported as unreadable instead of archived as understood',async()=>{
 await reset();
 const {client}=await mcpFor(async()=>({bytes:encryptedPdf(),mime:'application/pdf'}))();
 const captured=(await call(client,'cfo_capture',{files:[{download_url:'https://files.example.com/locked.pdf',file_id:'locked',file_name:'locked.pdf'}],candidates:[]})).structuredContent;
 assert.equal(captured.documents[0].pdf.kind,'unreadable');
 assert.equal(captured.documents[0].pdf.has_text_layer,false);
 assert.match(captured.documents[0].pdf.read_hint,/加密/);
 const read=await client.callTool({name:'cfo_read_document',arguments:{document_id:captured.documents[0].id}});
 assert.equal(read.isError,true);
 assert.match(read.content[0].text,/加密/);
});

test('one capture group carries six attachments and refuses a seventh',async()=>{
 await reset();
 const {client}=await mcpFor(async file=>({bytes:Buffer.from('synthetic-'+file.file_id),mime:'image/png'}))();
 const files=Array.from({length:6},(_,i)=>({download_url:`https://files.example.com/${i}.png`,file_id:'f'+i,file_name:`shot-${i}.png`,mime_type:'image/png'}));
 const captured=(await call(client,'cfo_capture',{files,candidates:[{file_index:5,source_ref:'alipay:9900',payload:{kind:'expense',date:'2026-11-03',amount:'31.50',currency:'CNY',description:'第六张截图'}}]})).structuredContent;
 assert.equal(captured.documents.length,6);
 assert.equal(new Set(captured.documents.map(d=>d.id)).size,6);
 assert.deepEqual(captured.documents.map(d=>d.filename),['shot-0.png','shot-1.png','shot-2.png','shot-3.png','shot-4.png','shot-5.png']);
 assert.equal(captured.posted_count,1);
 const seventh=await client.callTool({name:'cfo_capture',arguments:{files:[...files,{download_url:'https://files.example.com/6.png',file_id:'f6'}],candidates:[]}});
 assert.equal(seventh.isError,true);
 const outOfGroup=await client.callTool({name:'cfo_capture',arguments:{files:files.slice(0,2),candidates:[{file_index:5,source_ref:'x',payload:{kind:'expense',date:'2026-11-03',amount:'1.00',currency:'CNY'}}]}});
 assert.equal(outOfGroup.isError,true);
});

test('a batch receipt names neighbouring transactions the caller left out instead of implying completeness',async()=>{
 await reset();
 const docs=documentService(pool,dir,{download:async()=>({bytes:Buffer.from(randomUUID()),mime:'image/png'})});
 const made=[];
 for(const amount of ['11.00','22.00','33.00']){
  const d=await docs.saveBytes({file_name:'synthetic.png'},{bytes:Buffer.from(randomUUID()),mime:'image/png'});
  made.push((await recordEvent(pool,{document_id:d.id,source_ref:'row:1',request_key:requestKey(d.id,'row:1'),payload:{kind:'expense',date:'2026-11-03',amount,currency:'CNY',description:'合计检查'}})).event);
 }
 const partial=await batchSummary(pool,[made[0].id,made[1].id]);
 assert.equal(partial.event_count,2);
 assert.equal(partial.possible_missing_count,1);
 assert.deepEqual(partial.possible_missing_events.map(e=>e.event_id),[made[2].id]);
 assert.equal(partial.possible_missing_events[0].amount,'33.00');
 const complete=await batchSummary(pool,made.map(e=>e.id));
 assert.equal(complete.possible_missing_count,0);
 assert.deepEqual(complete.possible_missing_events,[]);
 // Older work and deleted records are not dressed up as a missing group.
 await pool.query("UPDATE cfo_events SET created_at=now()-interval '3 hours' WHERE id=$1",[made[2].id]);
 assert.equal((await batchSummary(pool,[made[0].id,made[1].id])).possible_missing_count,0);
 await pool.query("UPDATE cfo_events SET created_at=now(),deleted_at=now(),deleted_status='draft' WHERE id=$1",[made[2].id]);
 assert.equal((await batchSummary(pool,[made[0].id,made[1].id])).possible_missing_count,0);
});
