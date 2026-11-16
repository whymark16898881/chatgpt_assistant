import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inspectEventFields} from '../lib/field-coverage.mjs';
import {FIELD_CATALOG} from '../lib/field-catalog.mjs';
const account={id:'account-one',name:'synthetic cash',currency:'CNY',kind:'bank'};
const source={event_id:'event-one',document_id:'document-one',source_ref:'page1:row1',filename:'synthetic.png',mime_type:'image/png'};
const row={id:'event-one',status:'draft',revision:0,payload:{kind:'expense',date:'2026-11-06',amount:'12.30',account_id:account.id,merchant:'Synthetic merchant'},account,issues:[]};
const field=(report,key)=>report.fields.find(f=>f.key===key);
test('stored facts are distinct from original evidence and unimplemented analysis fields',()=>{
 const r=inspectEventFields(row,{sources:[source]});assert.equal(field(r,'occurred_on').state,'present');assert.equal(field(r,'occurred_on').field_evidence_status,'not_tracked');assert.equal(field(r,'currency').value,'CNY');assert.equal(field(r,'currency').origin,'linked_account');assert.equal(field(r,'meal_type').state,'not_recorded');assert.equal(field(r,'occurred_time').value,null);assert.equal(field(r,'meal_type').required_for_current_posting,false);assert.deepEqual(r.missing_posting_fields,[]);assert.equal(r.originals_read,false);assert.deepEqual(r.original_review_methods,['cfo_read_document']);
});
test('missing date remains unknown while ordinary payment-account identity is optional',()=>{
 const r=inspectEventFields({...row,account:null,payload:{kind:'expense',amount:'12.30',currency:'CNY'}});assert.equal(field(r,'occurred_on').state,'not_recorded');assert.equal(field(r,'occurred_on').original_review_needed,true);assert.equal(field(r,'account').state,'not_applicable');assert.equal(field(r,'currency').state,'present');assert.ok(r.missing_posting_fields.includes('occurred_on'));assert.ok(!r.missing_posting_fields.includes('account'));assert.equal(field(r,'meal_type').schema_gap,false);
});
test('currency conflicts, invalid money and dates, and dangling account references remain visible',()=>{
 const r=inspectEventFields({...row,payload:{...row.payload,currency:'SGD',amount:'not-money',date:'2026-02-30'}});assert.equal(field(r,'currency').state,'conflicting');assert.equal(field(r,'amount').state,'invalid');assert.equal(field(r,'occurred_on').state,'invalid');const dangling=inspectEventFields({...row,account:null});assert.equal(field(dangling,'account').state,'invalid');
});
test('actual posted category comes from journal data and cannot be mistaken for image-extracted text',()=>{
 const r=inspectEventFields({...row,status:'posted',payload:{...row.payload,category:'expense.other'}},{sources:[source],journals:[{entry_date:'2026-11-06',system_key:'expense.food',name:'Synthetic food',account_group:'expense'}]});assert.equal(field(r,'financial_category').origin,'journal');assert.deepEqual(field(r,'financial_category').value,[{key:'expense.food',name:'Synthetic food'}]);assert.equal(field(r,'financial_category_path').state,'not_recorded');assert.equal(field(r,'posting_date').state,'present');
});
test('multiple original links retain locations but unique document IDs and PDF capability limits',()=>{
 const r=inspectEventFields(row,{sources:[source,{...source,source_ref:'page2:row3'},{...source,document_id:'pdf-two',filename:'synthetic.pdf',mime_type:'application/pdf'}]});assert.equal(field(r,'document_ids').value.length,2);assert.equal(field(r,'source_refs').value.length,3);assert.ok(r.original_review_methods.includes('original_pdf_review_required'));assert.ok(r.fields.every(f=>!JSON.stringify(f).includes('stored_path')));
});
test('required counterparty is conditional, zero/negative openings are valid, category candidates are not silently dropped',()=>{
 assert.equal(field(inspectEventFields(row),'counter_account').state,'not_applicable');const transfer=inspectEventFields({...row,payload:{...row.payload,kind:'transfer'}});assert.equal(field(transfer,'counter_account').state,'not_recorded');assert.equal(field(transfer,'counter_account').required_for_current_posting,true);for(const amount of ['0','-3.25'])assert.equal(field(inspectEventFields({...row,payload:{...row.payload,kind:'opening',amount}}),'amount').state,'present');assert.equal(field(inspectEventFields({...row,payload:{...row.payload,category:'expense.unknown'}}),'financial_category').state,'invalid');assert.equal(new Set(FIELD_CATALOG.map(f=>f.key)).size,FIELD_CATALOG.length);
});
test('foreign currency and cross-currency transfers expose required exchange facts without inventing rates',()=>{
 const foreign={...account,currency:'USD'},r=inspectEventFields({...row,account:foreign});assert.equal(field(r,'fx_rate').state,'not_recorded');assert.equal(field(r,'fx_rate').required_for_current_posting,true);assert.equal(field(r,'fx_source').required_for_current_posting,true);assert.ok(r.missing_posting_fields.includes('fx_rate'));
 const cross=inspectEventFields({...row,account:foreign,counter_account:{...account,id:'other',currency:'SGD'},payload:{...row.payload,kind:'transfer',counter_account_id:'other',fx_rate:'7.1',fx_source:'synthetic source'}});assert.equal(field(cross,'counter_amount').required_for_current_posting,true);assert.equal(field(cross,'counter_fx_rate').required_for_current_posting,true);assert.equal(field(cross,'fx_rate').state,'present');
});
