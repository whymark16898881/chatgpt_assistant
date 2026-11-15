import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {connectDatabase} from '../lib/db.mjs';
import {accountResultHash,validateAccountResults,saveAccountResults,accountResultOverview} from '../lib/account-results.mjs';
const sample=JSON.parse(await readFile(new URL('./fixtures/account-results.sample.json',import.meta.url),'utf8'));
if(!process.env.DATABASE_URL)process.env.DATABASE_URL=(await readFile('.env.test','utf8')).trim().split('DATABASE_URL=')[1];
if(!new URL(process.env.DATABASE_URL).pathname.endsWith('_test'))throw new Error('Isolated test database required');
const pool=await connectDatabase();after(async()=>{await pool.query('TRUNCATE cfo_account_results');await pool.end();});
const now=()=>Date.parse('2026-11-15T18:00:00+08:00');
function seal(d){for(const r of d.results)r.content_hash=accountResultHash(r);return d;}
function live(){const d=structuredClone(sample);d.status='live';d.producer='synthetic-test-fixture';return seal(d);}
const validate=d=>validateAccountResults(d,{now});
test('actual supplied sample validates offline only, including gross shorts and explicitly unknown profit',async()=>{
 const d=validateAccountResults(sample,{allowSample:true});assert.equal(d.sample,true);assert.equal(d.rows.length,5);assert.equal(d.financial_transaction_posted,false);assert.equal(d.rows[0].payload.liabilities.short_market_value,'50000.00');assert.equal(d.rows[2].payload.assets_total,null);
 assert.throws(()=>validate(sample),e=>e.code==='TEST_DATA_REJECTED');await assert.rejects(saveAccountResults(pool,d),e=>e.code==='TEST_DATA_REJECTED');
});
test('production hash must be real; placeholder and tampered content are rejected',()=>{
 const d=live();d.results[0].net_assets='1';assert.throws(()=>validate(d),e=>e.code==='ACCOUNT_RESULTS_HASH_MISMATCH');const f=live();f.results[0].content_hash=sample.results[0].content_hash;assert.throws(()=>validate(f),e=>e.code==='ACCOUNT_RESULTS_HASH_MISMATCH');
});
test('identity is independently recomputed; a producer passed flag cannot conceal imbalance or omitted short liabilities',()=>{
 const d=live();d.results[0].net_assets='750001.00';assert.throws(()=>validate(seal(d)),e=>e.code==='ACCOUNT_RESULTS_IDENTITY_FAILED');const f=live();f.results[0].liabilities.short_market_value='0';assert.throws(()=>validate(seal(f)),e=>e.code==='ACCOUNT_RESULTS_IDENTITY_FAILED');
});
test('period cash-only NAV change is reference, never verified profit when securities transfers are unknown',()=>{
 const d=live();const r=validate(d);assert.equal(r.rows[3].status,'reference');assert.equal(r.rows[3].payload.net_securities_in_fv,null);assert.equal(r.rows[4].status,'unavailable');assert.equal(r.rows[4].payload.total_pnl,null);d.results[3].auto_postable=true;assert.throws(()=>validate(seal(d)),e=>e.code==='ACCOUNT_RESULTS_INCOMPLETE');
});
test('unavailable cannot be changed to zero and logical identity cannot disagree with source scope',()=>{
 const d=live();d.results[4].total_pnl='0';assert.throws(()=>validate(seal(d)),e=>e.code==='INVALID_ACCOUNT_RESULTS');const f=live();f.results[0].logical_key.account_scope=['tiger'];assert.throws(()=>validate(seal(f)),e=>e.code==='INVALID_ACCOUNT_RESULTS');
});
test('overlapping periods for an intersecting account scope are rejected instead of summed',()=>{
 const d=live(),r=structuredClone(d.results[3]);r.period_start='2026-10-02';r.logical_key.period_start=r.period_start;d.results.push(r);assert.throws(()=>validate(seal(d)),e=>e.code==='INVALID_ACCOUNT_RESULTS');
});
test('same-batch NAV/time and manifest identity must match independently trusted source',()=>{
 const d=live();const risk={ts:'2026-11-15 17:46:11',brokers:Object.fromEntries(d.results.filter(r=>r.kind==='balance').map(r=>[r.account_scope[0],{broker:{total_assets:r.net_assets,cash:r.assets?(r.assets.cash_positive!=='0.00'?r.assets.cash_positive:'-'+r.liabilities.margin_debit):'0',long_mv:r.assets?.long_market_value,short_mv:r.liabilities?'-'+r.liabilities.short_market_value:undefined}}]))};const manifest={export_id:d.export_batch.export_id,exported_at:'2026-11-15T17:51:27+08:00'};
 assert.equal(validateAccountResults(d,{risk,manifest,now}).rows.length,5);risk.brokers.moomoo.broker.total_assets='750002';assert.throws(()=>validateAccountResults(d,{risk,manifest,now}),e=>e.code==='ACCOUNT_RESULTS_SOURCE_MISMATCH');
});
test('readonly result revisions are idempotent, conflict atomically, preserve the latest version and never post journals',async()=>{
 await pool.query('TRUNCATE cfo_account_results');const before=(await pool.query('SELECT count(*) FROM cfo_entries')).rows[0].count,d=live();
 assert.equal((await saveAccountResults(pool,validate(d))).inserted,5);assert.equal((await saveAccountResults(pool,validate(d))).reused,true);
 const changed=live();changed.results[0].assets_total='1000010.00';changed.results[0].assets.long_market_value='1000010.00';changed.results[0].net_assets='750010.00';seal(changed);
 await assert.rejects(saveAccountResults(pool,validate(changed)),e=>e.code==='ACCOUNT_RESULTS_REVISION_CONFLICT');assert.equal((await pool.query('SELECT count(*) FROM cfo_account_results')).rows[0].count,'5');
 changed.results[0].revision=1;seal(changed);assert.equal((await saveAccountResults(pool,validate(changed))).inserted,1);const v=await accountResultOverview(pool,{month:'2026-10'});assert.equal(v.balances.find(b=>b.account_scope[0]==='moomoo').net_assets,'750010.00');assert.equal(v.balances[0].liabilities_complete,false);assert.equal(v.periods.find(p=>p.account_scope.includes('tiger')).status,'reference');assert.equal((await accountResultOverview(pool,{month:'2026-11'})).periods.length,0);assert.equal((await pool.query('SELECT count(*) FROM cfo_entries')).rows[0].count,before);
});

test('period identity cannot change per observation and malformed reconciliation dates never authorize posting',()=>{
 const d=live();const p=d.results[3];p.as_of=d.generated_at;p.logical_key.as_of=p.as_of;assert.throws(()=>validate(seal(d)),e=>e.code==='INVALID_ACCOUNT_RESULTS');
 const f=live(),r=f.results[3];r.net_securities_in_fv='0';r.coverage_through=r.period_end;r.securities_transfer_coverage.covered=true;r.auto_postable=true;
 for(const b of r.account_scope)r.flow_coverage[b]={reconciled:true,reconciliation_basis:'synthetic evidence',reconciled_through:'zzzz'};
 assert.throws(()=>validate(seal(f)),e=>e.code==='ACCOUNT_RESULTS_INCOMPLETE');
});

test('overlapping periods arriving in later batches are rejected transactionally, not just within one file',async()=>{
 await pool.query('TRUNCATE cfo_account_results');const d=live();await saveAccountResults(pool,validate(d));const next=live();next.results[3].period_start='2026-10-02';next.results[3].logical_key.period_start='2026-10-02';
 await assert.rejects(saveAccountResults(pool,validate(seal(next))),e=>e.code==='ACCOUNT_RESULTS_PERIOD_OVERLAP');assert.equal((await pool.query('SELECT count(*) FROM cfo_account_results')).rows[0].count,'5');
});

test('the five producer-supplied cross-language hashes match JS byte for byte',()=>{
 const expected=['f91b533cab5d201045926f3d1f730b0100eab9797aa37ba3b6270cdef61de7b4','257eab699985d928708ed55f7d786af6d3006258df80f68a959e07fc78e081de','b2178fbac38e42747617c44f8cf504395cfb5bcc470cb7116959f2fba84e8a33','ccdb928e0c50f8011544ab08a49f91059130f634f43727ed0698898c6b6248a9','c2af6d3aa088c3418d90d742c6533ebbb4dde1d73d5cf7e50a6b501a5b399704'];
 assert.deepEqual(sample.results.map(accountResultHash),expected.map(h=>'sha256:'+h));
});
function unavailable(d){const r=d.results.find(r=>r.kind==='balance'&&r.account_scope[0]==='tiger');Object.assign(r,{status:'unavailable',net_assets:null,decomposable:false,decomposition_basis:null,assets_total:null,liabilities_total:null,assets:null,liabilities:null,identity_check:null,unavailable_reason:['Broker request timed out']});return seal(d);}
test('an explicit unavailable balance is accepted as a missing fact, not zero or a replacement snapshot',async()=>{
 const d=unavailable(live()),v=validate(d);assert.equal(v.has_unavailable_balances,true);assert.equal(v.rows.find(r=>r.kind==='balance'&&r.payload.account_scope[0]==='tiger').payload.net_assets,null);await assert.rejects(saveAccountResults(pool,v),e=>e.code==='ACCOUNT_RESULTS_INCOMPLETE');
});
test('unavailable balance must have null amounts, a reason and matching same-batch source failure',()=>{
 const d=unavailable(live());delete d.results[2].unavailable_reason;assert.throws(()=>validate(seal(d)),e=>e.code==='INVALID_ACCOUNT_RESULTS');const f=unavailable(live());f.results[2].net_assets='0';assert.throws(()=>validate(seal(f)),e=>e.code==='INVALID_ACCOUNT_RESULTS');
 const g=unavailable(live());const risk={ts:'2026-11-15 17:46:11',brokers:{moomoo:{broker:{total_assets:'750000',cash:'-200000',long_mv:'1000000',short_mv:'-50000'}},futubull:{broker:{total_assets:'55000',cash:'40000',long_mv:'20000',short_mv:'-5000'}},tiger:{broker:{total_assets:'95000'}}}};
 assert.throws(()=>validateAccountResults(g,{risk,now}),e=>e.code==='ACCOUNT_RESULTS_SOURCE_MISMATCH');risk.brokers.tiger={_err:'timeout'};assert.equal(validateAccountResults(g,{risk,now}).has_unavailable_balances,true);
});
