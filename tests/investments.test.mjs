import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {connectDatabase} from '../lib/db.mjs';
import {importInvestmentSnapshot,investmentOverview} from '../lib/investments.mjs';
if(!process.env.DATABASE_URL)process.env.DATABASE_URL=(await readFile('.env.test','utf8')).trim().split('DATABASE_URL=')[1];
if(!new URL(process.env.DATABASE_URL).pathname.endsWith('_test'))throw new Error('Use an isolated *_test database');
const pool=await connectDatabase();after(()=>pool.end());
const now=()=>Date.parse('2026-11-15T00:00:00Z');
const reset=()=>pool.query('TRUNCATE cfo_investment_snapshots');
// All fixtures below are synthetic and only used in the guarded test database.
function snapshot(overrides={}){return{schema_version:1,source:'synthetic-test-source',snapshot_id:'close-20261114',revision:1,data_type:'live',as_of:'2026-11-14T20:00:00Z',generated_at:'2026-11-14T20:10:00Z',complete:true,
 accounts:[{account_id:'test-account',broker:'synthetic-broker',name:'测试券商',valuation_currency:'USD',net_liquidation_value:'1000.00',cash_balances:[{currency:'USD',amount:'100'}],positions:[{security_id:'US.TEST',symbol:'TEST',instrument_type:'etf',currency:'USD',quantity:'1.23456789',market_value:'900',cost_value:'800',reported_unrealized_pnl:'100'}]}],fx_rates:[{currency:'USD',rate_to_cny:'7',as_of:'2026-11-14T20:00:00Z',source:'synthetic-test-rate'}],...overrides};}
test('snapshot import is concurrent/idempotent and never creates financial entries',async()=>{
 await reset();const before=(await pool.query('SELECT count(*) FROM cfo_entries')).rows[0].count;
 const results=await Promise.all(Array.from({length:5},()=>importInvestmentSnapshot(pool,snapshot(),{now})));
 assert.equal(new Set(results.map(r=>r.id)).size,1);assert.equal(results.filter(r=>!r.reused).length,1);assert.ok(results.every(r=>!r.financial_transaction_posted));assert.equal((await pool.query('SELECT count(*) FROM cfo_entries')).rows[0].count,before);
});
test('reported account NAV is converted once; cash and positions are not added twice',async()=>{
 await reset();await importInvestmentSnapshot(pool,snapshot(),{now});const v=await investmentOverview(pool,{now});assert.equal(v.reported_net_assets_cny,'7000.00');assert.equal(v.sources[0].accounts[0].positions[0].quantity,'1.23456789');assert.equal(v.sources[0].accounts[0].cny_net_liquidation_value,'7000.00');assert.equal(v.account_mapping_complete,false);
});
test('conflicting revision cannot overwrite accepted source facts',async()=>{
 await reset();await importInvestmentSnapshot(pool,snapshot(),{now});const changed=snapshot();changed.accounts[0].net_liquidation_value='2000';await assert.rejects(importInvestmentSnapshot(pool,changed,{now}),e=>e.code==='SOURCE_CONFLICT');assert.equal((await investmentOverview(pool,{now})).reported_net_assets_cny,'7000.00');changed.revision=2;await importInvestmentSnapshot(pool,changed,{now});assert.equal((await investmentOverview(pool,{now})).reported_net_assets_cny,'14000.00');
});
test('incomplete and dropped-account snapshots do not erase previous holdings',async()=>{
 await reset();const p=snapshot();p.accounts.push({...structuredClone(p.accounts[0]),account_id:'second-test-account'});await importInvestmentSnapshot(pool,p,{now});await assert.rejects(importInvestmentSnapshot(pool,snapshot({complete:false}),{now}));await assert.rejects(importInvestmentSnapshot(pool,snapshot({snapshot_id:'new',as_of:'2026-11-14T21:00:00Z',generated_at:'2026-11-14T21:10:00Z'}),{now}),e=>e.code==='INCOMPLETE_COVERAGE');assert.equal((await investmentOverview(pool,{now})).sources[0].accounts.length,2);
});
test('late historical snapshots are preserved without replacing current state',async()=>{
 await reset();await importInvestmentSnapshot(pool,snapshot(),{now});const r=await importInvestmentSnapshot(pool,snapshot({snapshot_id:'older',as_of:'2026-11-13T20:00:00Z',generated_at:'2026-11-13T20:10:00Z',fx_rates:[]}),{now});assert.equal(r.is_latest,false);assert.equal((await investmentOverview(pool,{now})).sources[0].snapshot_id,'close-20261114');
});
test('actual complete empty-position account can represent a cleared portfolio',async()=>{
 await reset();await importInvestmentSnapshot(pool,snapshot(),{now});const p=snapshot({revision:2});p.accounts[0].positions=[];p.accounts[0].net_liquidation_value='100';await importInvestmentSnapshot(pool,p,{now});const v=await investmentOverview(pool,{now});assert.equal(v.sources[0].accounts[0].positions.length,0);assert.equal(v.reported_net_assets_cny,'700.00');
});
test('missing FX/NAV and old quotes are disclosed, not replaced by invented values',async()=>{
 await reset();const p=snapshot({fx_rates:[]});await importInvestmentSnapshot(pool,p,{now});let v=await investmentOverview(pool,{now});assert.equal(v.reported_net_assets_cny,null);assert.equal(v.sources[0].accounts[0].cny_net_liquidation_value,null);assert.equal(v.conversion_complete,false);v=await investmentOverview(pool,{now:()=>now()+48*3600000});assert.equal(v.sources[0].stale,true);assert.equal(v.sources[0].accounts[0].net_liquidation_value,'1000.00');assert.ok(v.sources[0].warnings.some(w=>w.includes('保留')));
});
test('test data is rejected by default and excluded from live overview',async()=>{
 await reset();await assert.rejects(importInvestmentSnapshot(pool,snapshot({data_type:'test'}),{now}),e=>e.code==='TEST_DATA_REJECTED');await importInvestmentSnapshot(pool,snapshot({data_type:'test'}),{now,allowTest:true});assert.equal((await investmentOverview(pool,{now})).connected,false);
});
test('future dates, duplicate account keys, invalid money and dishonest CNY FX are rejected',async()=>{
 await reset();await assert.rejects(importInvestmentSnapshot(pool,snapshot({as_of:'2027-01-01T00:00:00Z',generated_at:'2027-01-01T01:00:00Z'}),{now}));const dup=snapshot();dup.accounts.push(structuredClone(dup.accounts[0]));await assert.rejects(importInvestmentSnapshot(pool,dup,{now}));const bad=snapshot();bad.accounts[0].net_liquidation_value=1000;await assert.rejects(importInvestmentSnapshot(pool,bad,{now}));await assert.rejects(importInvestmentSnapshot(pool,snapshot({fx_rates:[{currency:'CNY',rate_to_cny:'7',as_of:'2026-11-14T20:00:00Z',source:'fake'}]}),{now}));assert.equal((await pool.query('SELECT count(*) FROM cfo_investment_snapshots')).rows[0].count,'0');
});
test('multiple sources cannot produce a misleading undeduplicated personal total',async()=>{
 await reset();await importInvestmentSnapshot(pool,snapshot(),{now});await importInvestmentSnapshot(pool,snapshot({source:'other-synthetic-source'}),{now});const v=await investmentOverview(pool,{now});assert.equal(v.sources.length,2);assert.equal(v.reported_net_assets_cny,null);assert.equal(v.account_mapping_complete,false);
});
