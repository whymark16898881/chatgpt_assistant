import {test} from 'node:test';
import assert from 'node:assert/strict';
import {summarizeBatchRows} from '../lib/batch-summary.mjs';
const row=(id,status,kind,amount,extra={})=>({id,status,payload:{kind,amount,currency:'CNY'},entry_count:status==='posted'?1:0,income_cents:kind==='income'?String(Math.round(Number(amount)*100)):'0',expense_cents:kind==='expense'?String(Math.round(Number(amount)*100)):'0',...extra});
test('batch receipt separates identified, posted and pending totals and deduplicates repeated groups',()=>{
 const rows=[row('a','posted','income','0.12'),row('b','posted','income','0.13'),row('c','draft','expense','125.10'),row('d','draft','expense','20.02'),row('e','draft','expense','3.45'),row('f','draft','income','0.07')];
 const s=summarizeBatchRows([...rows,rows[0],rows[2]]);assert.equal(s.event_count,6);assert.equal(s.counts.draft,4);assert.deepEqual(s.posted,{income_cny:'0.25',expense_cny:'0.00',net_cny:'0.25'});assert.deepEqual(s.by_currency,[{currency:'CNY',posted_income:'0.25',posted_expense:'0.00',pending_income:'0.07',pending_expense:'148.57',identified_income:'0.32',identified_expense:'148.57'}]);assert.equal(s.pending.length,4);assert.equal(s.financial_transaction_posted,false);
});
test('unknown currency and malformed or absent amounts remain unknown; currencies are never mixed',()=>{
 const s=summarizeBatchRows([row('a','draft','expense','2.00',{payload:{kind:'expense',amount:'2.00'}}),row('b','draft','expense','broken'),row('c','draft','income','1.00',{payload:{kind:'income',amount:'1.00',currency:'SGD'}}),row('d','draft','income',undefined)]);
 assert.deepEqual(s.unknown,{currency:1,amount:2});assert.equal(s.by_currency.length,1);assert.equal(s.by_currency[0].currency,'SGD');assert.equal(s.by_currency[0].identified_income,'1.00');
});
test('internal transfers, principal, opening and valuation adjustments do not inflate income or expense',()=>{
 const s=summarizeBatchRows(['transfer','reimbursement_received','reimbursement_advance','opening','valuation_gain','valuation_loss'].map((kind,i)=>row(String(i),'posted',kind,'100')));assert.equal(s.excluded_non_income_expense_count,6);assert.deepEqual(s.by_currency,[]);assert.equal(s.posted.income_cny,'0.00');assert.equal(s.posted.expense_cny,'0.00');
});
test('posted CNY totals come from actual ledger cents, while native currencies stay separate',()=>{
 const s=summarizeBatchRows([row('a','posted','income','10',{account_currency:'USD',payload:{kind:'income',amount:'10',currency:'USD'},income_cents:'7123',expense_cents:'0'}),row('b','posted','expense','2',{account_currency:'SGD',payload:{kind:'expense',amount:'2'},income_cents:'0',expense_cents:'1066'})]);assert.deepEqual(s.posted,{income_cny:'71.23',expense_cny:'10.66',net_cny:'60.57'});assert.deepEqual(s.by_currency.map(x=>x.currency),['SGD','USD']);
});
test('reversed and discarded records are excluded; a missing journal cannot masquerade as a zero posting',()=>{
 const s=summarizeBatchRows([row('a','reversed','income','99'),row('b','discarded','expense','99')]);assert.equal(s.by_currency.length,0);assert.equal(s.counts.reversed,1);assert.throws(()=>summarizeBatchRows([row('c','posted','income','3',{entry_count:0,income_cents:null})]),/缺少完整分录/);
});
test('a draft with conflicting evidence and account currency cannot be counted in either currency',()=>{
 const s=summarizeBatchRows([row('a','draft','expense','5',{account_currency:'SGD',payload:{kind:'expense',amount:'5',currency:'CNY'}})]);assert.equal(s.unknown.currency,1);assert.equal(s.by_currency.length,0);assert.equal(s.pending[0].currency,null);
});
