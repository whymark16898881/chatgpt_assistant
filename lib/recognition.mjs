// Versioned extraction facts, separate from immutable ledger amounts.
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {transaction} from './db.mjs';
import {cents,yuan} from './money.mjs';
import {recognitionSchema} from './recognition-contract.mjs';
function fail(code,message){throw Object.assign(new Error(message),{code});}
function canonical(v){if(Array.isArray(v))return v.map(canonical);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])]));return v;}
const hash=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
export async function saveRecognition(pool,eventId,expectedRevision,input,{allowSample=false}={}){
 eventId=z.uuid().parse(eventId).toLowerCase();expectedRevision=z.number().int().min(0).parse(expectedRevision);
 const data=recognitionSchema.parse(input);
 if(data.observations.some(o=>o.file_index!==undefined))fail('UNRESOLVED_EVIDENCE','文件下标须先由归档工具解析为真实原件ID');
 if(data.data_type==='sample'&&!allowSample)fail('TEST_DATA_REJECTED','样例识别禁止保存为真实凭证事实');
 return transaction(pool,c=>saveRecognitionTx(c,eventId,expectedRevision,data,{allowSample}));
}
export async function saveRecognitionTx(c,eventId,expectedRevision,input,{allowSample=false}={}){
 const data=recognitionSchema.parse(input);
 if(data.observations.some(o=>o.file_index!==undefined))fail('UNRESOLVED_EVIDENCE','文件下标须先由归档工具解析为真实原件ID');
 if(data.data_type==='sample'&&!allowSample)fail('TEST_DATA_REJECTED','样例禁止进入真实识别链路');
  await c.query('SELECT pg_advisory_xact_lock(20261102)');
  if(data.data_type==='sample'&&!(await c.query('SELECT current_database() AS name')).rows[0].name.endsWith('_test'))fail('TEST_DATA_REJECTED','样例只允许保存到专用_test数据库');
  const e=(await c.query('SELECT * FROM cfo_events WHERE id=$1 FOR UPDATE',[eventId])).rows[0];
  if(!e)fail('EVENT_NOT_FOUND','原业务交易不存在');
  if(e.deleted_at||!['draft','posted'].includes(e.status))fail('EVENT_NOT_ACTIVE','只给有效交易添加识别事实');
  const old=(await c.query('SELECT * FROM cfo_recognition_versions WHERE event_id=$1 ORDER BY revision DESC LIMIT 1',[eventId])).rows[0];

  const p=e.payload,account=p.account_id?(await c.query('SELECT currency FROM cfo_accounts WHERE id::text=$1 AND system_key IS NULL',[p.account_id])).rows[0]:null;
  const currency=p.currency&&account?.currency&&p.currency!==account.currency?null:p.currency||account?.currency||null;
  const basisHash=recognitionBasis(p,currency),contentHash=hash({data,basisHash});
  if(old?.content_hash===contentHash)return{id:old.id,revision:old.revision,reused:true,financial_transaction_posted:false};
  if((old?.revision||0)!==expectedRevision)fail('RECOGNITION_CONFLICT','识别事实已更新，请读取最新版本后补充');
  let total=null;try{total=cents(p.amount);}catch{}
  const monetary=['income','expense'].includes(p.kind);
  if(!monetary&&(data.items.length||data.category_code||data.allocation_status!=='not_itemized'))fail('UNSUPPORTED_ANALYSIS','当前金额分项仅用于收入或费用，不将转账/借还本金当收支');
  const itemInputs=data.allocation_status==='not_itemized'?(monetary?[{item_ref:'__event_total__',description:p.description,amount:p.amount,currency,category_code:data.category_code,merchant:data.merchant||p.merchant,meal_type:data.meal_type}]:[]):data.items;
  const nodes=(await c.query("SELECT code,business_group FROM cfo_classification_nodes WHERE tree='analysis'")).rows;
  const byCode=new Map(nodes.map(n=>[n.code,n]));
  for(const it of itemInputs){
   const code=it.category_code||data.category_code;
   if(code&&byCode.get(code)?.business_group!==p.kind)fail('INVALID_CLASSIFICATION','分析分类不存在或与收入/费用类型冲突');
   if(it.currency&&currency&&it.currency!==currency)fail('CURRENCY_CONFLICT','分项币种与交易已知币种冲突');
  }
  if(data.allocation_status==='complete'){
   if(total===null||total<=0||!currency||data.items.some(it=>it.amount===undefined))fail('INCOMPLETE_ALLOCATION','完整分项必须有总额、币种及每项金额');
   const sum=data.items.reduce((s,it)=>s+BigInt(cents(it.amount)),0n);
   if(sum!==BigInt(total))fail('ALLOCATION_MISMATCH','分项合计与交易总额不一致，未保存完整分摊');
  }
  const docIds=[...new Set(data.observations.flatMap(o=>o.document_id?[o.document_id.toLowerCase()]:[]))];
  if(docIds.length&&(await c.query('SELECT id FROM cfo_documents WHERE id=ANY($1::uuid[]) AND trashed_at IS NULL AND purge_requested_at IS NULL',[docIds])).rowCount!==docIds.length)fail('EVIDENCE_NOT_FOUND','字段来源必须是已归档原件');
  const version=(await c.query(`INSERT INTO cfo_recognition_versions(event_id,revision,content_hash,core_basis_hash,allocation_status,merchant,occurred_time,time_precision,timezone,payment_channel,raw_payload)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id,revision`,[eventId,expectedRevision+1,contentHash,basisHash,data.allocation_status,data.merchant||null,data.occurred_time||null,data.time_precision,data.timezone||null,data.payment_channel||null,JSON.stringify(data)])).rows[0];
  const itemIds=new Map();
  for(let i=0;i<itemInputs.length;i++){
   const it=itemInputs[i];
   const inserted=(await c.query('INSERT INTO cfo_recognition_item_keys(event_id,item_ref) VALUES($1,$2) ON CONFLICT(event_id,item_ref) DO NOTHING RETURNING id',[eventId,it.item_ref])).rows[0];
   const key=inserted||(await c.query('SELECT id FROM cfo_recognition_item_keys WHERE event_id=$1 AND item_ref=$2',[eventId,it.item_ref])).rows[0];
   itemIds.set(it.item_ref,key.id);let amount=null;try{amount=cents(it.amount);}catch{}
   await c.query(`INSERT INTO cfo_recognition_items(recognition_id,event_id,item_id,item_ref,ordinal,description,amount_minor,currency,category_code,merchant,meal_type,basis)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[version.id,eventId,key.id,it.item_ref,i,it.description||null,amount,it.currency||currency,it.category_code||data.category_code||null,it.merchant||data.merchant||null,it.meal_type||data.meal_type||null,data.allocation_status==='not_itemized'?'transaction_total':'explicit_item']);
  }
  for(const o of data.observations)await c.query(`INSERT INTO cfo_field_observations(recognition_id,event_id,item_id,field_name,observed_value,value_status,origin,verification,document_id,source_ref,page,bounding_box,raw_text,reason)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,[version.id,eventId,o.item_ref?itemIds.get(o.item_ref):null,o.field_name,JSON.stringify(o.value),o.value_status,o.origin,o.verification,o.document_id||null,o.source_ref||null,o.page||null,o.bounding_box?JSON.stringify(o.bounding_box):null,o.raw_text||null,o.reason||null]);
  await c.query("INSERT INTO cfo_audit(action,entity_id,details) VALUES('recognition_facts_saved',$1,$2)",[eventId,JSON.stringify({recognition_id:version.id,revision:version.revision,financial_transaction_posted:false})]);
  return{...version,reused:false,financial_transaction_posted:false,allocation_status:data.allocation_status};
}
export function recognitionBasis(p,currency){return hash({kind:p.kind,date:p.date??null,amount:p.amount??null,account_id:p.account_id??null,currency:currency??null,merchant:p.merchant??null});}
export async function readRecognition(pool,eventId){
 const c=await pool.connect();try{await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const result=await loadRecognition(c,eventId);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}
export async function loadRecognition(c,eventId){
 const event=(await c.query("SELECT e.*,a.currency AS account_currency FROM cfo_events e LEFT JOIN cfo_accounts a ON a.id::text=e.payload->>'account_id' AND a.system_key IS NULL WHERE e.id=$1",[eventId])).rows[0];
 if(!event)fail('EVENT_NOT_FOUND','业务交易不存在');
 const versions=(await c.query('SELECT * FROM cfo_recognition_versions WHERE event_id=$1 ORDER BY revision DESC',[eventId])).rows;
 if(!versions.length)return{event_id:eventId,recognition_recorded:false,revision:0,items:[],observations:[],financial_transaction_posted:false};
 const latest=versions[0],items=(await c.query('SELECT item_id,item_ref,ordinal,description,amount_minor::text,currency,category_code,merchant,meal_type,basis FROM cfo_recognition_items WHERE recognition_id=$1 ORDER BY ordinal',[latest.id])).rows;
 const observations=(await c.query('SELECT item_id,field_name,observed_value,value_status,origin,verification,document_id,source_ref,page,bounding_box,raw_text,reason FROM cfo_field_observations WHERE recognition_id=$1 ORDER BY id',[latest.id])).rows;
 const p=event.payload,currency=p.currency&&event.account_currency&&p.currency!==event.account_currency?null:p.currency||event.account_currency||null;
 return{event_id:eventId,recognition_recorded:true,revision:latest.revision,history_count:versions.length,stale_for_transaction:latest.core_basis_hash!==recognitionBasis(p,currency),allocation_status:latest.allocation_status,merchant:latest.merchant,occurred_time:latest.time_precision==='minute'?latest.occurred_time?.slice(0,5):latest.occurred_time,time_precision:latest.time_precision,timezone:latest.timezone,payment_channel:latest.payment_channel,category_code:latest.raw_payload.category_code??null,meal_type:latest.raw_payload.meal_type??null,
  items:items.map(it=>({...it,amount:it.amount_minor===null?null:yuan(it.amount_minor)})),observations,financial_transaction_posted:false};
}
