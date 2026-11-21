// Spending analysis dimensions: group by the paying account's platform, and sort line
// items by amount so the largest single charges surface instead of the most recent ones.
import {test,after} from 'node:test';import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';
import path from 'node:path';import {randomUUID} from 'node:crypto';
import {connectDatabase} from '../lib/db.mjs';
import {createAccount,recordEvent} from '../lib/ledger.mjs';
import {documentService} from '../lib/documents.mjs';
import {analysisOverview} from '../lib/analysis.mjs';

if(!process.env.DATABASE_URL)process.env.DATABASE_URL=(await readFile('.env.test','utf8')).trim().split('DATABASE_URL=')[1];
if(!new URL(process.env.DATABASE_URL).pathname.endsWith('_test'))throw new Error('Isolated test database required');
const pool=await connectDatabase(),dir=await mkdtemp(path.join(tmpdir(),'cfo-dimensions-')),docs=documentService(pool,dir);
after(async()=>{await pool.end();await rm(dir,{recursive:true,force:true});});
const reset=()=>pool.query('TRUNCATE cfo_audit,cfo_event_sources,cfo_lines,cfo_entries,cfo_events,cfo_documents RESTART IDENTITY CASCADE; DELETE FROM cfo_accounts WHERE system_key IS NULL');

async function spend(payload){
 const d=await docs.saveBytes({file_name:'synthetic-dimension.json'},{bytes:Buffer.from(randomUUID()),mime:'application/json'});
 const r=await recordEvent(pool,{document_id:d.id,source_ref:'row:1',request_key:randomUUID(),
  payload:{kind:'expense',currency:'CNY',category:'expense.food',...payload}});
 assert.equal(r.event.status,'posted',`未入账：${JSON.stringify(r.event.payload)}`);
 return r.event;
}
// Two cards on different platforms, one ordinary cash expense with no paying account.
async function scene(){
 await reset();
 const citi=await createAccount(pool,{platform_name:'Citi',name:'Citi Rewards 6780',currency:'CNY',kind:'credit_card'});
 const uob=await createAccount(pool,{platform_name:'UOB',name:'UOB Lady Solitaire 5024',currency:'CNY',kind:'credit_card'});
 await spend({date:'2026-11-02',amount:'100.25',account_id:citi.id,settlement:'credit'});
 await spend({date:'2026-11-05',amount:'300.50',account_id:citi.id,settlement:'credit'});
 await spend({date:'2026-11-03',amount:'200.00',account_id:uob.id,settlement:'credit'});
 await spend({date:'2026-11-04',amount:'50.10'});  // no account_id: lands on the built-in summary-cash node
 return {citi,uob};
}

test('grouping by platform merges every card of one issuer and ranks platforms by spend',async()=>{
 await scene();
 const r=await analysisOverview(pool,{month:'2026-11',group_by:'platform'});
 assert.deepEqual(r.groups.map(g=>g.label),['Citi','UOB','综合收支']);
 const citi=r.groups[0];
 assert.equal(citi.expense_cny,'400.75');          // 100.25 + 300.50, both cards' charges merged
 assert.equal(citi.transaction_count,2);
 assert.equal(r.groups[1].expense_cny,'200.00');
 assert.equal(r.groups[2].expense_cny,'50.10');    // charges with no card of their own
 assert.equal(r.totals.expense_cny,'650.85');      // grouping never drops or double-counts
});

test('a platform group drills down to its own charges, summary cash included',async()=>{
 await scene();
 const citi=await analysisOverview(pool,{month:'2026-11',group_by:'platform',platform:'Citi'});
 assert.equal(citi.totals.expense_cny,'400.75');
 assert.equal(citi.rows.length,2);
 assert.ok(citi.rows.every(i=>i.platform==='Citi'));
 const summary=await analysisOverview(pool,{month:'2026-11',group_by:'platform',platform:'综合收支'});
 assert.equal(summary.totals.expense_cny,'50.10');
 assert.equal(summary.rows.length,1);
 assert.equal(summary.rows[0].platform,'综合收支');
});

test('sorting line items by amount surfaces the largest charge, not the latest one',async()=>{
 await scene();
 const byDate=await analysisOverview(pool,{month:'2026-11'});
 assert.deepEqual(byDate.rows.map(i=>i.date),['2026-11-05','2026-11-04','2026-11-03','2026-11-02']);
 const byAmount=await analysisOverview(pool,{month:'2026-11',sort:'amount'});
 assert.deepEqual(byAmount.rows.map(i=>i.cny_amount),['300.50','200.00','100.25','50.10']);
 // Same rows either way: ordering must not filter anything out.
 assert.equal(byAmount.rows.length,byDate.rows.length);
 assert.equal(byAmount.totals.expense_cny,byDate.totals.expense_cny);
});

test('amount ordering survives paging, so page one really holds the biggest charges',async()=>{
 await scene();
 const top2=await analysisOverview(pool,{month:'2026-11',sort:'amount',limit:2});
 assert.deepEqual(top2.rows.map(i=>i.cny_amount),['300.50','200.00']);
 assert.equal(top2.scope.has_more,true);
 const next=await analysisOverview(pool,{month:'2026-11',sort:'amount',limit:2,offset:2});
 assert.deepEqual(next.rows.map(i=>i.cny_amount),['100.25','50.10']);
 assert.equal(next.scope.has_more,false);
});

test('platform of a charge follows the account platform, not the account name',async()=>{
 await reset();
 // Same issuer, two cards named differently: the platform label must collapse them.
 const a=await createAccount(pool,{platform_name:'Citi',name:'Citi Rewards 6780',currency:'CNY',kind:'credit_card'});
 const b=await createAccount(pool,{platform_name:'Citi',name:'Citi PremierMiles 1122',currency:'CNY',kind:'credit_card'});
 await spend({date:'2026-11-02',amount:'10.00',account_id:a.id,settlement:'credit'});
 await spend({date:'2026-11-03',amount:'20.00',account_id:b.id,settlement:'credit'});
 const r=await analysisOverview(pool,{month:'2026-11',group_by:'platform'});
 assert.equal(r.groups.length,1);
 assert.equal(r.groups[0].label,'Citi');
 assert.equal(r.groups[0].expense_cny,'30.00');
 assert.equal(r.groups[0].transaction_count,2);
});
