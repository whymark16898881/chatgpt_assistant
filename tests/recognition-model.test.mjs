// Staged data model tests. No runtime MCP tool or production migration imports this yet.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {connectDatabase} from '../lib/db.mjs';
import {documentService} from '../lib/documents.mjs';
import {createAccount,recordEvent} from '../lib/ledger.mjs';
import {recognitionSchema} from '../prototypes/recognition/contract.mjs';
import {applyRecognitionPrototype,classificationTree,saveRecognition,readRecognition} from '../prototypes/recognition/store.mjs';
if(!process.env.DATABASE_URL)process.env.DATABASE_URL=(await readFile('.env.test','utf8')).trim().split('DATABASE_URL=')[1];
if(!new URL(process.env.DATABASE_URL).pathname.endsWith('_test'))throw new Error('Staged models require an isolated *_test database');
const pool=await connectDatabase(),dir=await mkdtemp(path.join(tmpdir(),'cfo-recognition-model-')),documents=documentService(pool,dir);
await applyRecognitionPrototype(pool);
after(async()=>{await pool.end();await rm(dir,{recursive:true,force:true});});
async function seed(){
 const a=await createAccount(pool,{name:'Synthetic model '+randomUUID(),kind:'bank',currency:'CNY'});
 const doc=await documents.saveBytes({file_name:'synthetic-model.json'},{bytes:Buffer.from(randomUUID()),mime:'application/json'});
 const event=(await recordEvent(pool,{document_id:doc.id,source_ref:'row:1',request_key:randomUUID(),payload:{kind:'expense',date:'2026-11-06',account_id:a.id,amount:'30.00',category:'expense.food',description:'Synthetic staged model'}})).event;
 return{a,doc,event};
}
const input=overrides=>({schema:'cfo_recognition/v1',data_type:'live',...overrides});
async function financialSnapshot(event){return JSON.stringify({events:(await pool.query('SELECT id,payload,status,revision FROM cfo_events WHERE id=$1',[event.id])).rows,lines:(await pool.query('SELECT l.* FROM cfo_lines l JOIN cfo_entries j ON j.id=l.entry_id WHERE j.event_id=$1 ORDER BY l.id',[event.id])).rows,entries:(await pool.query('SELECT * FROM cfo_entries WHERE event_id=$1',[event.id])).rows});}
test('draft migration refuses production names before issuing DDL; reapplication preserves all financial records',async()=>{
 let calls=0;await assert.rejects(applyRecognitionPrototype({query:async()=>{calls++;return{rows:[{name:'cfo'}]};}}),e=>e.code==='ISOLATED_DATABASE_REQUIRED');assert.equal(calls,1);
 const {event}=await seed(),before=await financialSnapshot(event);await applyRecognitionPrototype(pool);assert.equal(await financialSnapshot(event),before);
 const nodes=await classificationTree(pool);assert.deepEqual(nodes.find(n=>n.tree==='analysis'&&n.code==='expense.food.dining').path.map(n=>n.name),['消费及费用','餐饮','外食']);assert.equal(nodes.find(n=>n.tree==='financial'&&n.code==='expense.food').path[1].code,'expense.living');
});
test('time precision, absent values and evidence provenance cannot be invented by the contract',()=>{
 assert.equal(recognitionSchema.parse(input()).occurred_time,undefined);
 for(const bad of [input({occurred_time:'12:00'}),input({time_precision:'minute'}),input({occurred_time:'12:00:00',time_precision:'minute'}),input({observations:[{field_name:'occurred_on',value:'2026-11-06',value_status:'found',origin:'original'}]}),input({observations:[{field_name:'amount',value:'12.333',value_status:'found',origin:'user_provided'}]}),input({observations:[{field_name:'occurred_on',value:'2026-02-30',value_status:'found',origin:'user_provided'}]})])assert.throws(()=>recognitionSchema.parse(bad));
 const parsed=recognitionSchema.parse(input({observations:[{field_name:'occurred_time',value:null,value_status:'missing',origin:'user_provided',reason:'not supplied'}]}));assert.equal(parsed.observations[0].value,null);
});
test('normalized recognition revisions retain stable item IDs and never change journal entries or transaction payload',async()=>{
 const {doc,event}=await seed(),before=await financialSnapshot(event);
 const v1=input({allocation_status:'complete',occurred_time:'12:15',time_precision:'minute',items:[{item_ref:'row1',amount:'20.00',category_code:'expense.food.dining',meal_type:'lunch'},{item_ref:'row2',amount:'10.00',category_code:'expense.food.dining'}],observations:[{item_ref:'row1',field_name:'amount',value:'20.00',value_status:'found',origin:'original',document_id:doc.id,source_ref:'row1'}]});
 const first=await saveRecognition(pool,event.id,0,v1);assert.equal(first.revision,1);assert.equal(first.financial_transaction_posted,false);const stored1=await readRecognition(pool,event.id);assert.equal(stored1.items.length,2);assert.equal(stored1.occurred_time,'12:15');assert.equal(stored1.time_precision,'minute');assert.equal(stored1.timezone,null);
 const second=await saveRecognition(pool,event.id,1,{...v1,items:v1.items.map(i=>({...i,merchant:'Synthetic dining'}))});assert.equal(second.revision,2);const stored2=await readRecognition(pool,event.id);assert.deepEqual(stored2.items.map(i=>i.item_id),stored1.items.map(i=>i.item_id));assert.equal(stored2.history_count,2);assert.equal(await financialSnapshot(event),before);
});
test('same content is idempotent, stale competing revisions are rejected, historical facts are append-only',async()=>{
 const {event}=await seed(),v=input({merchant:'Synthetic A'});const first=await saveRecognition(pool,event.id,0,v),retry=await saveRecognition(pool,event.id,0,v);assert.equal(retry.reused,true);assert.equal(retry.id,first.id);
 await assert.rejects(saveRecognition(pool,event.id,0,input({merchant:'Synthetic B'})),e=>e.code==='RECOGNITION_CONFLICT');
 await assert.rejects(pool.query("UPDATE cfo_recognition_versions SET merchant='changed' WHERE id=$1",[first.id]),/immutable/);
});
test('complete allocations require an exact total; partial data keeps unknown fields null',async()=>{
 const {event}=await seed();await assert.rejects(saveRecognition(pool,event.id,0,input({allocation_status:'complete',items:[{item_ref:'a',amount:'29.99'}]})),e=>e.code==='ALLOCATION_MISMATCH');assert.equal((await readRecognition(pool,event.id)).recognition_recorded,false);
 await saveRecognition(pool,event.id,0,input({allocation_status:'partial',items:[{item_ref:'a',description:'Synthetic unknown amount'}]}));const r=await readRecognition(pool,event.id);assert.equal(r.items[0].amount,null);assert.equal(r.items[0].category_code,null);assert.equal(r.items[0].meal_type,null);assert.equal(r.allocation_status,'partial');
});
test('wrong currency, incompatible category, missing evidence and sample data cannot pollute real records',async()=>{
 const {event}=await seed();
 await assert.rejects(saveRecognition(pool,event.id,0,input({allocation_status:'complete',items:[{item_ref:'a',amount:'30',currency:'USD'}]})),e=>e.code==='CURRENCY_CONFLICT');
 await assert.rejects(saveRecognition(pool,event.id,0,input({category_code:'income.work'})),e=>e.code==='INVALID_CLASSIFICATION');
 await assert.rejects(saveRecognition(pool,event.id,0,input({observations:[{field_name:'merchant',value:'Synthetic A',value_status:'found',origin:'original',document_id:randomUUID()}]})),e=>e.code==='EVIDENCE_NOT_FOUND');
 await assert.rejects(saveRecognition(pool,event.id,0,{...input(),data_type:'sample'}),e=>e.code==='TEST_DATA_REJECTED');assert.equal((await readRecognition(pool,event.id)).recognition_recorded,false);
});
test('database tree rejects cross-group parents and cycles, independent of application validation',async()=>{
 await assert.rejects(pool.query("UPDATE cfo_classification_nodes SET parent_code='income' WHERE tree='analysis' AND code='expense.food'"),/different business group/);
 await assert.rejects(pool.query("UPDATE cfo_classification_nodes SET parent_code='expense.food.dining' WHERE tree='analysis' AND code='expense.food'"),/cycle/);
 await assert.rejects(pool.query("UPDATE cfo_classification_nodes SET business_group='income' WHERE tree='analysis' AND code='expense'"),/identity/);
});
