import{test,after}from'node:test';
import assert from'node:assert/strict';
import{readFile,mkdtemp,rm}from'node:fs/promises';
import path from'node:path';import{tmpdir}from'node:os';import{randomUUID}from'node:crypto';
import{connectDatabase,migrate}from'../lib/db.mjs';
import{documentService}from'../lib/documents.mjs';
import{createAccount,recordEvent,reviseAndPost,reverseEvent}from'../lib/ledger.mjs';
import{reports}from'../lib/reports.mjs';
import{saveRecognition,readRecognition}from'../lib/recognition.mjs';
import{analysisOverview,allocateCents,transactionDetail}from'../lib/analysis.mjs';
import{fieldCoverage}from'../lib/field-coverage.mjs';
import{financeMcp}from'../lib/mcp.mjs';import{Client}from'@modelcontextprotocol/sdk/client/index.js';import{InMemoryTransport}from'@modelcontextprotocol/sdk/inMemory.js';
if(!process.env.DATABASE_URL)process.env.DATABASE_URL=(await readFile('.env.test','utf8')).trim().split('DATABASE_URL=')[1];if(!new URL(process.env.DATABASE_URL).pathname.endsWith('_test'))throw new Error('Use isolated *_test database');
const pool=await connectDatabase(),dir=await mkdtemp(path.join(tmpdir(),'cfo-recognition-runtime-')),docs=documentService(pool,dir,{download:async file=>({bytes:Buffer.from(file.file_id),mime:'image/png'})});after(async()=>{await pool.end();await rm(dir,{recursive:true,force:true});});
const reset=()=>pool.query('TRUNCATE cfo_audit,cfo_event_sources,cfo_lines,cfo_entries,cfo_events,cfo_documents RESTART IDENTITY CASCADE; DELETE FROM cfo_accounts WHERE system_key IS NULL');
async function seed(payload={},currency='CNY'){
 const account=await createAccount(pool,{name:'Synthetic runtime '+randomUUID(),kind:'bank',currency}),doc=await docs.saveBytes({file_name:'synthetic.json'},{bytes:Buffer.from(randomUUID()),mime:'application/json'});
 const result=await recordEvent(pool,{document_id:doc.id,source_ref:'row1',request_key:randomUUID(),payload:{kind:'expense',date:'2026-11-06',account_id:account.id,amount:'30.00',category:'expense.food',description:'Synthetic runtime',...payload}});return{account,doc,...result};
}
const rec=extra=>({schema:'cfo_recognition/v1',data_type:'live',...extra});
const split=()=>rec({allocation_status:'complete',items:[{item_ref:'food',amount:'20',category_code:'expense.food.dining',meal_type:'lunch',merchant:'Synthetic restaurant'},{item_ref:'home',amount:'10',category_code:'expense.home.utilities.electricity',merchant:'Synthetic utility'}]});
test('compatible migration preserves original IDs, entries, amount and unknown legacy dimensions',async()=>{
 await reset();const{event}=await seed();const before=JSON.stringify((await pool.query('SELECT * FROM cfo_events WHERE id=$1',[event.id])).rows);await migrate(pool);assert.equal(JSON.stringify((await pool.query('SELECT * FROM cfo_events WHERE id=$1',[event.id])).rows),before);
 const view=await analysisOverview(pool,{month:'2026-11'});assert.equal(view.totals.expense_cny,'30.00');assert.equal(view.totals.transaction_count,1);assert.equal(view.rows[0].item_id,null);assert.equal(view.rows[0].category_code,null);assert.equal(view.rows[0].meal_type,null);assert.equal(view.rows[0].occurred_time,null);assert.equal(view.rows[0].basis,'transaction_total_fallback');
});
test('inline recognition creates normalized facts and posted entry atomically; mismatch rolls everything except original archive back',async()=>{
 await reset();const{event,recognition_result}=await seed({recognition:split()});assert.equal(event.status,'posted');assert.equal(recognition_result.revision,1);assert.equal(Object.hasOwn(event.payload,'recognition'),false);const details=await readRecognition(pool,event.id);assert.equal(details.items.length,2);assert.equal(details.stale_for_transaction,false);
 const before=(await pool.query('SELECT count(*) FROM cfo_entries')).rows[0].count;
 await assert.rejects(seed({recognition:rec({allocation_status:'complete',items:[{item_ref:'wrong',amount:'29.99'}]})}),e=>e.code==='ALLOCATION_MISMATCH');assert.equal((await pool.query('SELECT count(*) FROM cfo_entries')).rows[0].count,before);assert.equal((await pool.query('SELECT count(*) FROM cfo_events')).rows[0].count,'1');
});
test('analysis rolls up disjoint descendants and traces evidence without multiplying journal amount',async()=>{
 await reset();const{event,account}=await seed({recognition:split(),external_id:'synthetic-order'});const doc=await docs.saveBytes({file_name:'synthetic-support.json'},{bytes:Buffer.from('support '+randomUUID()),mime:'application/json'});
 const duplicate=await recordEvent(pool,{document_id:doc.id,source_ref:'support',request_key:randomUUID(),payload:{...event.payload,external_id:'synthetic-order',account_id:account.id}});assert.equal(duplicate.reused,true);
 let view=await analysisOverview(pool,{month:'2026-11'});assert.equal(view.totals.expense_cny,'30.00');assert.equal(view.totals.transaction_count,1);assert.equal(view.totals.document_count,2);assert.equal(view.totals.item_count,2);assert.deepEqual(new Set(view.groups.map(g=>g.key)),new Set(['expense.food','expense.home']));
 view=await analysisOverview(pool,{month:'2026-11',category_code:'expense.food'});assert.equal(view.totals.expense_cny,'20.00');assert.equal(view.groups[0].key,'expense.food.dining');view=await analysisOverview(pool,{month:'2026-11',category_code:'expense.food.dining',meal_type:'lunch'});assert.equal(view.groups[0].next_code,null);assert.equal(view.rows[0].merchant,'Synthetic restaurant');
 const detail=await transactionDetail(pool,event.id);assert.equal(detail.documents.length,2);assert.equal(detail.entries.length,1);assert.equal(detail.event.id,event.id);assert.equal(detail.recognition.items.length,2);assert.equal((await reports(pool,'2026-11')).income_statement.total_expenses,'30.00');
});
test('cross-currency rounding allocates actual posted CNY cents exactly, with stable remainder ordering',async()=>{
 assert.deepEqual(allocateCents('656',['33','33','34']),[217n,216n,223n]);assert.deepEqual(allocateCents('-1',['1','1','1']),[-1n,0n,0n]);
 await reset();await seed({amount:'1.00',currency:'USD',fx_rate:'6.555',fx_source:'synthetic FX',recognition:rec({allocation_status:'complete',items:[{item_ref:'a',amount:'0.33',category_code:'expense.food.dining'},{item_ref:'b',amount:'0.33',category_code:'expense.food.takeaway'},{item_ref:'c',amount:'0.34',category_code:'expense.home'}]})},'USD');const r=await analysisOverview(pool,{month:'2026-11'});assert.equal(r.totals.expense_cny,'6.56');assert.deepEqual(r.rows.map(i=>i.cny_amount),['2.17','2.16','2.23']);
});
test('a changed draft cannot reuse stale allocations; partial or absent detail keeps the authoritative total',async()=>{
 await reset();const{event}=await seed({date:undefined,recognition:split()});assert.equal(event.status,'draft');const resolved=await reviseAndPost(pool,event.id,{revision:event.revision,payload:{...event.payload,date:'2026-11-07'}});assert.equal(resolved.status,'posted');assert.equal((await readRecognition(pool,event.id)).stale_for_transaction,true);
 let r=await analysisOverview(pool,{month:'2026-11'});assert.equal(r.rows.length,1);assert.equal(r.rows[0].recognition_stale,true);assert.equal(r.totals.expense_cny,'30.00');await saveRecognition(pool,event.id,1,split());r=await analysisOverview(pool,{month:'2026-11'});assert.equal(r.rows.length,2);assert.equal(r.rows[0].recognition_stale,false);
 await saveRecognition(pool,event.id,2,rec({allocation_status:'partial',items:[{item_ref:'part',amount:'5',category_code:'expense.food.dining'}]}));r=await analysisOverview(pool,{month:'2026-11'});assert.equal(r.rows.length,1);assert.equal(r.totals.expense_cny,'30.00');assert.equal(r.rows[0].category_code,null);
});
test('reversed entries and internal transfers cannot inflate income/expense analysis; totals are not page totals',async()=>{
 await reset();const first=await seed({recognition:split()});await seed({kind:'income',category:'income.salary',amount:'100'});let r=await analysisOverview(pool,{month:'2026-11',limit:1});assert.equal(r.scope.has_more,true);assert.equal(r.totals.expense_cny,'30.00');assert.equal(r.totals.income_cny,'100.00');await reverseEvent(pool,first.event.id,{date:'2026-11-07',reason:'synthetic reversal'});r=await analysisOverview(pool,{month:'2026-11'});assert.equal(r.totals.expense_cny,'0.00');assert.equal(r.totals.income_cny,'100.00');const d=await transactionDetail(pool,first.event.id);assert.equal(d.entries.length,2);
});
test('MCP resolves new attachment references into actual archive IDs and stores field provenance without duplicate posting',async()=>{
 await reset();const account=await createAccount(pool,{name:'Synthetic SDK','kind':'bank',currency:'CNY'}),server=financeMcp(pool,docs),client=new Client({name:'recognition-runtime',version:'1'});const[ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);await client.connect(ct);
 try{
 const args={files:[{download_url:'https://example.com/receipt.png',file_id:'synthetic-runtime-photo'}],candidates:[{file_index:0,source_ref:'row1',payload:{kind:'expense',date:'2026-11-06',amount:'30',account_id:account.id,category:'expense.food',recognition:rec({category_code:'expense.food.dining',observations:[{field_name:'amount',value:'30.00',value_status:'found',origin:'original',file_index:0,source_ref:'row1'}]})}}]};
 let result=await client.callTool({name:'cfo_capture',arguments:args});assert.ok(!result.isError,JSON.stringify(result.structuredContent));const event=result.structuredContent.events[0].event,doc=result.structuredContent.documents[0];assert.equal(result.structuredContent.posted_count,1);
 const detail=await client.callTool({name:'cfo_get_transaction',arguments:{event_id:event.id}});assert.ok(!detail.isError);assert.equal(detail.structuredContent.recognition.observations[0].document_id,doc.id);result=await client.callTool({name:'cfo_capture',arguments:args});assert.equal(result.structuredContent.posted_count,0);
 const audit=await fieldCoverage(pool,{event_ids:[event.id]});assert.equal(audit.transactions[0].fields.find(f=>f.key==='amount').field_evidence_status,'tracked_unverified');assert.equal(audit.transactions[0].fields.find(f=>f.key==='analysis_category_path').state,'present');
 const rows=await client.callTool({name:'cfo_drilldown',arguments:{month:'2026-11'}});assert.ok(!rows.isError,JSON.stringify(rows.structuredContent));assert.equal(rows.structuredContent.totals.expense_cny,'30.00');
 }finally{await client.close();await server.close();}
});
