import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {connectDatabase} from '../lib/db.mjs';
import {createAccount,recordEvent,reviseAndPost,reverseEvent,listAccounts} from '../lib/ledger.mjs';
import {reports} from '../lib/reports.mjs';
import {documentService} from '../lib/documents.mjs';
import {createAuth} from '../lib/auth.mjs';
import {financeMcp} from '../lib/mcp.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
if(!process.env.DATABASE_URL)process.env.DATABASE_URL=(await readFile('.env.test','utf8')).trim().split('DATABASE_URL=')[1];
if(!new URL(process.env.DATABASE_URL).pathname.endsWith('_test'))throw new Error('Tests require a dedicated *_test database');
const pool=await connectDatabase();
const dir=await mkdtemp(path.join(tmpdir(),'cfo-ledger-'));
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1kAAAAASUVORK5CYII=','base64');
const docs=documentService(pool,dir,{download:async()=>({bytes:png,mime:'image/png'})});
after(async()=>{await pool.end();await rm(dir,{recursive:true,force:true});});
const reset=async()=>pool.query('TRUNCATE cfo_audit,cfo_event_sources,cfo_lines,cfo_entries,cfo_events,cfo_documents RESTART IDENTITY CASCADE; DELETE FROM cfo_accounts WHERE system_key IS NULL');
const account=(name,kind='bank',currency='CNY')=>createAccount(pool,{name,kind,currency});
async function record(payload,extra={}){const d=await docs.saveBytes({file_name:'source.json'},{bytes:Buffer.from(randomUUID()),mime:'application/json'});return recordEvent(pool,{document_id:d.id,source_ref:'row:1',request_key:randomUUID(),payload:{date:'2026-11-02',...payload},...extra});}
test('balanced statements: salary, family support, transfers, credit repayment, reimbursement and valuation',async()=>{
 await reset();const bank=await account('银行'),other=await account('支付宝'),credit=await account('信用卡','credit_card'),recv=await account('应收报销','receivable'),inv=await account('证券','investment');
 for(const a of[bank,other,credit,recv,inv])assert.equal((await record({kind:'opening',date:'2026-11-01',account_id:a.id,amount:a.id===bank.id?'1000':'0'})).event.status,'posted');
 for(const payload of[
  {kind:'income',account_id:bank.id,amount:'3000',category:'income.salary'},
  {kind:'expense',account_id:bank.id,amount:'500',category:'expense.family'},
  {kind:'transfer',account_id:bank.id,counter_account_id:other.id,amount:'200'},
  {kind:'expense',account_id:credit.id,amount:'80',category:'expense.food'},
  {kind:'transfer',account_id:bank.id,counter_account_id:credit.id,amount:'80'},
  {kind:'reimbursement_advance',account_id:bank.id,counter_account_id:recv.id,amount:'100'},
  {kind:'reimbursement_received',account_id:recv.id,counter_account_id:bank.id,amount:'100'},
  {kind:'transfer',account_id:bank.id,counter_account_id:inv.id,amount:'300'},
  {kind:'valuation_gain',account_id:inv.id,amount:'20'}
 ])assert.equal((await record(payload)).event.status,'posted');
 const r=await reports(pool,'2026-11');assert.equal(r.balance_sheet.balanced,true);assert.equal(r.cash_flow.reconciled,true);assert.equal(r.opening_complete,true);
 assert.equal(r.income_statement.total_expenses,'580.00');assert.equal(r.income_statement.net_income,'2440.00');assert.equal(r.balance_sheet.net_worth,'3440.00');assert.equal(r.cash_flow.closing,'3120.00');assert.equal(r.cash_flow.net_change,'2120.00');
 const a=await listAccounts(pool);assert.equal(a.find(a=>a.id===credit.id).balance,'0.00');assert.equal(a.find(a=>a.id===recv.id).balance,'0.00');
});
test('foreign salary stays draft without rate and source; exact decimal rounding; revision guard',async()=>{
 await reset();const a=await account('DBS','bank','SGD');const p={kind:'income',account_id:a.id,amount:'123.45',category:'income.salary',date:'2026-11-03'};
 const d=(await record(p)).event;assert.equal(d.status,'draft');assert.ok(d.issues.length>=2);
 const payload={...p,fx_rate:'5.123456',fx_source:'用户提供银行成交汇率'};
 await assert.rejects(reviseAndPost(pool,d.id,{revision:100,payload}),/已更新/);
 assert.equal((await reviseAndPost(pool,d.id,{revision:d.revision,payload})).status,'posted');
 assert.equal((await reports(pool,'2026-11')).income_statement.total_income,'632.49');
});
test('same source and reliable transaction ID reuse; ambiguous duplicates wait for confirmation',async()=>{
 await reset();const a=await account('支付宝');const p={kind:'expense',account_id:a.id,date:'2026-11-04',amount:'22.50',external_id:'alipay:12345',category:'expense.food'};
 const first=await record(p);const d=await docs.saveBytes({file_name:'statement.json'},{bytes:Buffer.from('statement'),mime:'application/json'});
 const second=await recordEvent(pool,{document_id:d.id,source_ref:'page1:row1',request_key:'statement:1',payload:p});
 assert.equal(second.reused,true);assert.equal(second.event.id,first.event.id);
 const repeated=await recordEvent(pool,{document_id:d.id,source_ref:'page1:row1',request_key:'another-request',payload:p});assert.equal(repeated.event.id,first.event.id);
 const candidate=(await record({...p,external_id:undefined})).event;assert.equal(candidate.status,'draft');assert.match(candidate.issues.join(),/可能重复/);
 const resolved=await reviseAndPost(pool,candidate.id,{revision:candidate.revision,payload:candidate.payload,allow_possible_duplicate:true});assert.equal(resolved.status,'posted');
 assert.equal((await reports(pool,'2026-11')).income_statement.total_expenses,'45.00');
});
test('five concurrent identical documents and transactions produce one receipt and journal',async()=>{
 await reset();const a=await account('现金');const result=await Promise.all(Array.from({length:5},()=>docs.archive({file_name:'same.png'})));
 assert.equal(new Set(result.map(x=>x.id)).size,1);
 const ids=await Promise.all(Array.from({length:5},()=>recordEvent(pool,{document_id:result[0].id,source_ref:'1',request_key:'concurrent',payload:{kind:'expense',date:'2026-11-05',account_id:a.id,amount:'1'}})));
 assert.equal(new Set(ids.map(x=>x.event.id)).size,1);assert.equal((await pool.query('SELECT count(*) FROM cfo_entries')).rows[0].count,'1');
});
test('reversals retain history, are idempotent and zero out financial effect',async()=>{
 await reset();const a=await account('银行');const event=(await record({kind:'expense',account_id:a.id,amount:'90'})).event;
 await reverseEvent(pool,event.id,{date:'2026-11-03',reason:'用户确认记错'});await reverseEvent(pool,event.id,{date:'2026-11-03',reason:'重试'});
 assert.equal((await pool.query('SELECT count(*) FROM cfo_entries')).rows[0].count,'2');const r=await reports(pool,'2026-11');assert.equal(r.income_statement.total_expenses,'0.00');assert.equal(r.cash_flow.reconciled,true);assert.equal(r.balance_sheet.balanced,true);
});
test('invalid facts remain drafts; pre-start dates and unknown categories never post',async()=>{
 await reset();const a=await account('银行');
 for(const bad of[{amount:'NaN'},{date:'2026-10-30'},{date:'2026-02-30'},{category:'income.salary'},{category:'expense.unknown'},{needs_review:['截图模糊']}])assert.equal((await record({kind:'expense',account_id:a.id,amount:'1',...bad})).event.status,'draft');
 assert.equal((await pool.query('SELECT count(*) FROM cfo_entries')).rows[0].count,'0');
});
test('cross-currency transfer balances; not ordinary income; rate source required',async()=>{
 await reset();const a=await account('人民币'),b=await account('美元','bank','USD');
 const e=await record({kind:'transfer',account_id:a.id,counter_account_id:b.id,amount:'720',counter_amount:'100',counter_fx_rate:'7.2',fx_source:'用户提供换汇成交回单'});assert.equal(e.event.status,'posted');const r=await reports(pool,'2026-11');assert.equal(r.income_statement.net_income,'0.00');assert.equal(r.cash_flow.net_change,'0.00');assert.equal(r.balance_sheet.balanced,true);
});
test('database rejects unbalanced journal even if application is bypassed',async()=>{
 const a=await account('数据库校验');const c=await pool.connect();try{await c.query('BEGIN');const e=(await c.query("INSERT INTO cfo_entries(entry_date,description,kind,cash_flow_bucket) VALUES('2026-11-01','invalid','expense','operating') RETURNING id")).rows[0];await c.query("INSERT INTO cfo_lines(entry_id,account_id,native_cents,cny_cents,fx_rate,fx_source) VALUES($1,$2,100,100,1,'CNY')",[e.id,a.id]);await assert.rejects(c.query('COMMIT'),/unbalanced|balanced|两条|balance/i);}finally{await c.query('ROLLBACK');c.release();}
});
test('signed sessions reject tampering, wrong password and expiration',()=>{let now=0;const a=createAuth('local-test-password',{now:()=>now});const token=a.issue();assert.ok(a.valid(token));assert.ok(!a.checkPassword('wrong'));assert.ok(!a.valid(token+'x'));now=13*3600000;assert.ok(!a.valid(token));assert.match(a.cookie(token),/HttpOnly; SameSite=Strict/);});
test('actual MCP calls archive, post and return NAS image bytes through SDK transport',async()=>{
 await reset();const a=await account('MCP现金');const server=financeMcp(pool,docs),client=new Client({name:'test',version:'1'});const [ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);await client.connect(ct);
 try{const health=await client.callTool({name:'cfo_health',arguments:{}});assert.equal(health.structuredContent.service_version,'0.4.12');const capture=await client.callTool({name:'cfo_capture',arguments:{files:[{download_url:'https://example.com/test.png',file_id:'file-test',file_name:'test.png'}],candidates:[{file_index:0,source_ref:'row:1',payload:{kind:'expense',date:'2026-11-04',amount:'10',account_id:a.id}}]}});assert.equal(capture.isError,undefined);assert.equal(capture.structuredContent.posted_count,1);const d=capture.structuredContent.documents[0];const image=await client.callTool({name:'cfo_read_document',arguments:{document_id:d.id}});assert.equal(image.content[0].type,'image');assert.equal(image.content[0].data,png.toString('base64'));}finally{await client.close();await server.close();}
});
test('journal cannot be overwritten or deleted; audit records before/after draft facts',async()=>{
 await reset();const a=await account('审计银行');const d=(await record({kind:'expense',account_id:a.id})).event;
 await reviseAndPost(pool,d.id,{revision:d.revision,payload:{...d.payload,amount:'9'}});
 const audit=(await pool.query("SELECT details FROM cfo_audit WHERE entity_id=$1 AND action='event_revised'",[d.id])).rows[0].details;assert.equal(audit.after.amount,'9');assert.equal(audit.before.amount,undefined);
 await assert.rejects(pool.query('UPDATE cfo_lines SET cny_cents=0'),/immutable/);await assert.rejects(pool.query('DELETE FROM cfo_entries'),/immutable/);
});
test('probe originals import is read-only, hash checked and idempotent without financial postings',async()=>{
 await reset();const {writeFile}=await import('node:fs/promises');const {createHash}=await import('node:crypto');const {importProbe}=await import('../lib/import-probe.mjs');
 await pool.query('CREATE TABLE IF NOT EXISTS cfo_probe_documents(sha256 text PRIMARY KEY,filename text,mime_type text,created_at timestamptz DEFAULT now()); TRUNCATE cfo_probe_documents');
 const sourceDir=await mkdtemp(path.join(tmpdir(),'cfo-source-'));const sha=createHash('sha256').update(png).digest('hex');await writeFile(path.join(sourceDir,sha),png);
 await pool.query('INSERT INTO cfo_probe_documents(sha256,filename,mime_type) VALUES($1,$2,$3)',[sha,'already-uploaded.png','image/png']);
 try{const first=await importProbe(pool,docs,sourceDir),again=await importProbe(pool,docs,sourceDir);assert.equal(first.imported,1);assert.equal(again.reused,1);assert.equal(first.financial_transaction_posted,false);assert.equal((await pool.query('SELECT count(*) FROM cfo_entries')).rows[0].count,'0');assert.deepEqual(await readFile(path.join(sourceDir,sha)),png);await writeFile(path.join(sourceDir,sha),'bad');await assert.rejects(importProbe(pool,docs,sourceDir),/checksum/);}finally{await rm(sourceDir,{recursive:true,force:true});}
});

test('eight-character web password works; seven characters are rejected; password change invalidates old sessions',()=>{
 const first=createAuth('Ab12!xyZ');const token=first.issue();assert.ok(first.valid(token));assert.ok(first.checkPassword('Ab12!xyZ'));
 assert.throws(()=>createAuth('Ab12!xy'),/at least 8/);const changed=createAuth('Cd34!uvW');assert.ok(!changed.valid(token));assert.ok(!changed.checkPassword('Ab12!xyZ'));
});
test('seven-image request can be processed as automatic 3+3+1 batches with one ambiguous item and safe retry',async()=>{
 await reset();const a=await account('批量测试支付宝');const batchDocs=documentService(pool,dir,{download:async file=>({bytes:Buffer.concat([png,Buffer.from(file.file_id)]),mime:'image/png'})});
 const server=financeMcp(pool,batchDocs),client=new Client({name:'batch-check',version:'1'});const [ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);await client.connect(ct);
 const makeBatch=ids=>({files:ids.map(i=>({file_id:'batch-image-'+i,download_url:'https://example.com/'+i+'.png',file_name:i+'.png'})),candidates:ids.map((i,file_index)=>({file_index,source_ref:'page1:row1',payload:{kind:'expense',date:'2026-11-06',amount:String(i),...(i===7?{account_hint:'扣款账户不清楚',needs_review:['请确认扣款账户']}:{account_id:a.id})}}))});
 try{let posted=0,drafts=0;for(const ids of[[1,2,3],[4,5,6],[7]]){const r=await client.callTool({name:'cfo_capture',arguments:makeBatch(ids)});assert.ok(!r.isError);posted+=r.structuredContent.posted_count;drafts+=r.structuredContent.draft_count;}
 assert.equal(posted,6);assert.equal(drafts,1);const retry=await client.callTool({name:'cfo_capture',arguments:makeBatch([4,5,6])});assert.equal(retry.structuredContent.posted_count,0);assert.ok(retry.structuredContent.events.every(x=>x.reused));assert.equal((await pool.query('SELECT count(*) FROM cfo_entries')).rows[0].count,'6');assert.equal((await pool.query('SELECT count(*) FROM cfo_documents')).rows[0].count,'7');
 }finally{await client.close();await server.close();}
});

test('borrowing, principal repayment and interest keep three statements balanced and expose book leverage/costs',async()=>{
 await reset();const bank=await account('工资卡'),loan=await account('银行贷款','loan');
 for(const [a,amount]of[[bank,'2000'],[loan,'0']])assert.equal((await record({kind:'opening',date:'2026-11-01',account_id:a.id,amount})).event.status,'posted');
 for(const payload of[
  {kind:'transfer',account_id:loan.id,counter_account_id:bank.id,amount:'1000'},
  {kind:'transfer',account_id:bank.id,counter_account_id:loan.id,amount:'200'},
  {kind:'expense',account_id:bank.id,amount:'20',category:'expense.interest'},
  {kind:'expense',account_id:loan.id,amount:'5',category:'expense.interest'},
  {kind:'expense',account_id:bank.id,amount:'3',category:'expense.financing_fees'}
 ])assert.equal((await record(payload)).event.status,'posted');
 const r=await reports(pool,'2026-11');assert.equal(r.income_statement.total_income,'0.00');assert.equal(r.income_statement.net_income,'-28.00');assert.equal(r.balance_sheet.total_assets,'2777.00');assert.equal(r.balance_sheet.total_liabilities,'805.00');assert.equal(r.balance_sheet.net_worth,'1972.00');assert.equal(r.balance_sheet.balanced,true);assert.equal(r.cash_flow.reconciled,true);assert.equal(r.cash_flow.net_change,'777.00');
 assert.equal(r.financing.monthly_interest_expense,'25.00');assert.equal(r.financing.year_to_date_interest_expense,'25.00');assert.equal(r.financing.monthly_total_cost,'28.00');assert.equal(r.financing.year_coverage_from,'2026-11-01');assert.equal(r.financing.estimated_annual_interest,null);assert.equal(r.leverage.debt_accounts[0].balance,'805.00');assert.equal(r.leverage.coverage_complete,true);assert.ok(Number(r.leverage.asset_liability_ratio_percent)>28);assert.ok(Number(r.leverage.assets_to_net_worth)>1);
});
test('interest reversal removes the cost and unconfirmed debt marks leverage coverage incomplete',async()=>{
 await reset();const bank=await account('银行'),loan=await account('未确认借呗','loan');
 const event=(await record({kind:'expense',account_id:bank.id,amount:'10',category:'expense.interest'})).event;await reverseEvent(pool,event.id,{date:'2026-11-03',reason:'利息重复'});
 const r=await reports(pool,'2026-11');assert.equal(r.financing.monthly_interest_expense,'0.00');assert.equal(r.leverage.coverage_complete,false);assert.equal(r.leverage.assets_to_net_worth,null);assert.equal(r.leverage.asset_liability_ratio_percent,null);assert.equal(r.leverage.debt_accounts.find(a=>a.account_id===loan.id).opening_confirmed,false);
});
test('MCP batch summary spans groups, deduplicates IDs, refreshes resolved drafts and never creates entries',async()=>{
 await reset();const a=await account('synthetic batch account');
 const first=(await record({kind:'income',account_id:a.id,amount:'0.12',date:'2026-11-04'})).event;
 const second=(await record({kind:'income',account_id:a.id,amount:'0.13',date:'2026-11-05'})).event;
 const draft=(await record({kind:'expense',settlement:'unknown',currency:'CNY',amount:'125.10',date:'2026-11-05'})).event;
 const server=financeMcp(pool,docs),client=new Client({name:'batch-summary-check',version:'1'});const [ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);await client.connect(ct);
 try{
  const event_ids=[first.id,second.id,draft.id,first.id],before=(await pool.query('SELECT count(*) FROM cfo_entries')).rows[0].count;
  let response=await client.callTool({name:'cfo_batch_summary',arguments:{event_ids}});assert.ok(!response.isError);let s=response.structuredContent;
  assert.equal(s.event_count,3);assert.equal(s.counts.draft,1);assert.equal(s.posted.income_cny,'0.25');assert.equal(s.by_currency[0].pending_expense,'125.10');assert.equal((await pool.query('SELECT count(*) FROM cfo_entries')).rows[0].count,before);
  await reviseAndPost(pool,draft.id,{revision:draft.revision,payload:{...draft.payload,settlement:'cash',account_id:a.id}});
  response=await client.callTool({name:'cfo_batch_summary',arguments:{event_ids}});assert.ok(!response.isError);s=response.structuredContent;assert.equal(s.counts.draft,0);assert.equal(s.counts.posted,3);assert.equal(s.posted.expense_cny,'125.10');assert.equal(s.posted.net_cny,'-124.85');assert.equal(s.by_currency[0].pending_expense,'0.00');
  const missing=await client.callTool({name:'cfo_batch_summary',arguments:{event_ids:[first.id,randomUUID()]}});assert.equal(missing.isError,true);
 }finally{await client.close();await server.close();}
});
test('explicit screenshot currency conflicting with an account stays draft',async()=>{
 await reset();const a=await account('synthetic SGD bank','bank','SGD');const r=await record({kind:'expense',account_id:a.id,currency:'CNY',amount:'5',fx_rate:'5',fx_source:'synthetic test quote'});assert.equal(r.event.status,'draft');assert.match(r.event.issues.join(),/币种不符/);
});
test('MCP field coverage is read-only, paginated, provenance-aware and keeps evidence distinct from transactions',async()=>{
 await reset();const a=await account('synthetic coverage bank');
 const posted=(await record({kind:'income',amount:'0.21',account_id:a.id,date:'2026-11-05'})).event;
 const draft=(await record({kind:'expense',amount:'15.40',currency:'CNY',date:undefined})).event;
 const supporting=await docs.saveBytes({file_name:'synthetic-support.png'},{bytes:png,mime:'image/png'});
 await pool.query('INSERT INTO cfo_event_sources(document_id,source_ref,event_id) VALUES($1,$2,$3)',[supporting.id,'page1:row1',posted.id]);
 await docs.saveBytes({file_name:'synthetic-unlinked.pdf'},{bytes:Buffer.from('synthetic opaque PDF marker; not a parsing test'),mime:'application/pdf'});
 async function snapshot(){return JSON.stringify({events:(await pool.query('SELECT id,payload,status,revision FROM cfo_events ORDER BY id')).rows,counts:(await pool.query('SELECT (SELECT count(*) FROM cfo_entries) AS entries,(SELECT count(*) FROM cfo_lines) AS lines,(SELECT count(*) FROM cfo_audit) AS audit,(SELECT count(*) FROM cfo_documents) AS documents')).rows});}
 const before=await snapshot(),server=financeMcp(pool,docs),client=new Client({name:'field-coverage-check',version:'1'});const [ct,st]=InMemoryTransport.createLinkedPair();
 try{
  await server.connect(st);await client.connect(ct);
  const tools=await client.listTools();assert.equal(tools.tools.find(t=>t.name==='cfo_field_coverage').annotations.readOnlyHint,true);
  let r=await client.callTool({name:'cfo_field_coverage',arguments:{limit:1}});assert.ok(!r.isError,JSON.stringify(r.structuredContent));let s=r.structuredContent;
  assert.equal(s.scope.total_matching_transactions,2);assert.equal(s.scope.returned,1);assert.equal(s.scope.has_more,true);assert.equal(s.scope.complete_for_scope,false);assert.equal(s.document_summary.total_stored_documents,4);assert.equal(s.document_summary.without_transaction_links,1);assert.equal(s.originals_read,false);assert.equal(s.financial_transaction_posted,false);
  const firstId=s.transactions[0].transaction_id;r=await client.callTool({name:'cfo_field_coverage',arguments:{limit:1,offset:s.scope.next_offset}});assert.ok(!r.isError);assert.notEqual(r.structuredContent.transactions[0].transaction_id,firstId);
  r=await client.callTool({name:'cfo_field_coverage',arguments:{event_ids:[posted.id,posted.id.toUpperCase(),draft.id]}});assert.ok(!r.isError);s=r.structuredContent;assert.equal(s.scope.complete_for_scope,true);
  const p=s.transactions.find(t=>t.transaction_id===posted.id),d=s.transactions.find(t=>t.transaction_id===draft.id);
  assert.equal(p.fields.find(f=>f.key==='document_ids').value.length,2);assert.equal(p.fields.find(f=>f.key==='financial_category').origin,'journal');assert.equal(p.fields.find(f=>f.key==='financial_category').value[0].key,'income.other');assert.equal(p.fields.find(f=>f.key==='occurred_on').field_evidence_status,'not_tracked');assert.equal(d.fields.find(f=>f.key==='occurred_on').state,'not_recorded');assert.equal(d.fields.find(f=>f.key==='meal_type').state,'not_recorded');
  const missing=randomUUID();r=await client.callTool({name:'cfo_field_coverage',arguments:{event_ids:[posted.id,missing]}});assert.ok(!r.isError);assert.deepEqual(r.structuredContent.scope.missing_requested_ids,[missing]);assert.equal(r.structuredContent.scope.complete_for_scope,false);
  assert.equal(await snapshot(),before);
 }finally{await client.close();await server.close();}
});
