import {cents,baseCents,validDate,CURRENCIES} from './money.mjs';
import {FIELD_CATALOG,FIELD_CATALOG_VERSION} from './field-catalog.mjs';
const kinds=['income','expense','transfer','reimbursement_advance','reimbursement_received','valuation_gain','valuation_loss','opening'];
const dual=['transfer','reimbursement_advance','reimbursement_received'];
const has=value=>value!==undefined&&value!==null&&!(typeof value==='string'&&!value.trim())&&!(Array.isArray(value)&&!value.length);
function cell(key,value,{origin='stored_input',required=false,valid=true,applicable=true,conflicting=false,missing='not_recorded'}={}){
 const definition=FIELD_CATALOG.find(f=>f.key===key);
 const state=definition.implementation==='planned'?'not_supported':!applicable?'not_applicable':conflicting?'conflicting':!has(value)?missing:valid?'present':'invalid';
 return{key,value:value??null,state,origin:has(value)?origin:null,required_for_current_posting:required,field_evidence_status:definition.group==='system'||origin==='journal'?'not_applicable':'not_tracked',original_review_needed:['not_recorded','invalid','conflicting'].includes(state),schema_gap:state==='not_supported'};
}
export function inspectEventFields(row,{sources=[],journals=[],categories=[]}={}){
 const p=row.payload||{},a=row.account,b=row.counter_account,posted=['posted','reversed'].includes(row.status);
 const categoryCandidates=categories.filter(c=>c.system_key===p.category),group=p.kind==='income'?'income':p.kind==='expense'?'expense':null;
 const actualCategories=group?[...new Map(journals.filter(j=>j.account_group===group&&j.system_key).map(j=>[j.system_key,{key:j.system_key,name:j.name}])).values()]:[];
 const category=posted?actualCategories:p.category?categoryCandidates.map(c=>({key:c.system_key,name:c.name})):null;
 let amountValid=true;try{const n=cents(p.amount,p.kind==='opening');if(n===0&&p.kind!=='opening')amountValid=false;}catch{amountValid=false;}
 const explicitCurrency=p.currency,accountCurrency=a?.currency,currency=explicitCurrency||accountCurrency||null;
 const postingCurrency=accountCurrency||explicitCurrency||null;
 const foreign=CURRENCIES.includes(postingCurrency)&&postingCurrency!=='CNY',cross=dual.includes(p.kind)&&!!a&&!!b&&a.currency!==b.currency;
 let rateValid=true,otherRateValid=true,otherAmountValid=true;
 try{if(foreign)baseCents(1,p.fx_rate,postingCurrency);}catch{rateValid=false;}
 try{if(cross&&b.currency!=='CNY')baseCents(1,p.counter_fx_rate,b.currency);}catch{otherRateValid=false;}
 try{if(cross&&cents(p.counter_amount)<=0)otherAmountValid=false;}catch{otherAmountValid=false;}
 const fields=[
  cell('transaction_id',row.id,{origin:'system'}),
  cell('document_ids',[...new Set(sources.map(s=>s.document_id))],{origin:'source_links',required:true}),
  cell('source_refs',sources.map(s=>({document_id:s.document_id,source_ref:s.source_ref})),{origin:'source_links'}),
  cell('business_kind',p.kind,{required:true,valid:kinds.includes(p.kind)}),
  cell('flow_direction',null),cell('amount',p.amount,{required:true,valid:amountValid}),
  cell('currency',currency,{origin:explicitCurrency?'stored_input':'linked_account',required:true,valid:CURRENCIES.includes(currency),conflicting:!!(explicitCurrency&&accountCurrency&&explicitCurrency!==accountCurrency)}),
  cell('fx_rate',p.fx_rate,{required:foreign,applicable:postingCurrency!=='CNY',valid:rateValid}),
  cell('fx_source',p.fx_source,{required:foreign||(cross&&b.currency!=='CNY'),applicable:postingCurrency!=='CNY'||(cross&&b.currency!=='CNY')}),
  cell('occurred_on',p.date,{required:true,valid:validDate(p.date)}),cell('occurred_time',null),cell('time_precision',null),
  cell('account',a?{id:a.id,name:a.name,currency:a.currency,kind:a.kind}:p.account_id?{id:p.account_id}:null,{origin:'linked_account',required:true,valid:!!a}),
  cell('counter_account',b?{id:b.id,name:b.name,currency:b.currency,kind:b.kind}:p.counter_account_id?{id:p.counter_account_id}:null,{origin:'linked_account',required:dual.includes(p.kind),applicable:dual.includes(p.kind),valid:!!b&&a?.id!==b?.id}),
  cell('counter_amount',p.counter_amount,{required:cross,applicable:cross,valid:otherAmountValid}),
  cell('counter_fx_rate',p.counter_fx_rate,{required:cross&&b.currency!=='CNY',applicable:cross&&b.currency!=='CNY',valid:otherRateValid}),
  cell('account_hint',p.account_hint),
  cell('financial_category',category,{origin:posted?'journal':'stored_input',applicable:!!group,valid:posted?actualCategories.length>0:!p.category||categoryCandidates.some(c=>c.account_group===group)}),
  cell('financial_category_path',null),cell('analysis_category_path',null),cell('merchant',p.merchant),cell('description',p.description),cell('external_id',p.external_id),
  cell('payment_channel',null),cell('meal_type',null),cell('items',null),cell('field_observations',null),
  cell('posting_date',[...new Set(journals.map(j=>j.entry_date))],{origin:'journal',applicable:posted,required:posted}),
  cell('status',row.status,{origin:'system'})
 ];
 // Retain an invalid category candidate in the audit rather than hiding it as blank.
 const categoryCell=fields.find(f=>f.key==='financial_category');
 if(!posted&&group&&p.category&&categoryCandidates.length===0){categoryCell.value=p.category;categoryCell.state='invalid';categoryCell.origin='stored_input';categoryCell.original_review_needed=true;}
 const reviewMethods=[...new Set(sources.map(s=>['image/png','image/jpeg'].includes(s.mime_type)?'cfo_read_document':s.mime_type==='application/pdf'?'original_pdf_review_required':'original_context_review_required'))];
 return{transaction_id:row.id,status:row.status,revision:row.revision,existing_issues:row.issues||[],sources,original_review_methods:reviewMethods,originals_read:false,fields,
  missing_posting_fields:fields.filter(f=>f.required_for_current_posting&&!['present','not_applicable'].includes(f.state)).map(f=>f.key),
  note:'present只表示已保存或可从关联数据读取，未证明原件包含该事实；not_recorded不等于原件缺失；not_supported是程序尚未采集。此检查不重新判定交易或修改入账状态。'};
}
export async function fieldCoverage(pool,{event_ids,limit=20,offset=0}={}){
 if(!Number.isInteger(limit)||limit<1||limit>50||!Number.isInteger(offset)||offset<0)throw new Error('字段检查分页参数无效');
 if(event_ids&&(!Array.isArray(event_ids)||!event_ids.length||event_ids.length>50||offset!==0))throw new Error('按交易ID检查最多50笔，不能同时偏移分页');
 const ids=event_ids?[...new Set(event_ids.map(id=>id.toLowerCase()))]:null,c=await pool.connect();
 try{
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const count=Number((await c.query('SELECT count(*)::int AS count FROM cfo_events WHERE ($1::uuid[] IS NULL OR id=ANY($1))',[ids])).rows[0].count);
  const rows=(await c.query(`SELECT e.id,e.status,e.revision,e.payload,e.issues,
   CASE WHEN a.id IS NOT NULL AND a.system_key IS NULL THEN jsonb_build_object('id',a.id,'name',a.name,'currency',a.currency,'kind',a.kind) END AS account,
   CASE WHEN b.id IS NOT NULL AND b.system_key IS NULL THEN jsonb_build_object('id',b.id,'name',b.name,'currency',b.currency,'kind',b.kind) END AS counter_account
   FROM cfo_events e LEFT JOIN cfo_accounts a ON a.id::text=e.payload->>'account_id' LEFT JOIN cfo_accounts b ON b.id::text=e.payload->>'counter_account_id'
   WHERE ($1::uuid[] IS NULL OR e.id=ANY($1)) ORDER BY e.created_at DESC,e.id LIMIT $2 OFFSET $3`,[ids,ids?ids.length:limit,offset])).rows;
  const selected=rows.map(r=>r.id);
  const sources=(await c.query(`SELECT s.event_id,s.document_id,s.source_ref,d.filename,d.mime_type FROM cfo_event_sources s JOIN cfo_documents d ON d.id=s.document_id WHERE s.event_id=ANY($1::uuid[])
   UNION SELECT e.id,e.document_id,e.source_ref,d.filename,d.mime_type FROM cfo_events e JOIN cfo_documents d ON d.id=e.document_id WHERE e.id=ANY($1::uuid[]) ORDER BY event_id,document_id,source_ref`,[selected])).rows;
  const journals=(await c.query(`SELECT DISTINCT j.event_id,j.entry_date::text,a.system_key,a.name,a.account_group FROM cfo_entries j LEFT JOIN cfo_lines l ON l.entry_id=j.id LEFT JOIN cfo_accounts a ON a.id=l.account_id WHERE j.event_id=ANY($1::uuid[]) AND j.reverses_id IS NULL`,[selected])).rows;
  const categories=(await c.query('SELECT system_key,name,account_group FROM cfo_accounts WHERE system_key IS NOT NULL')).rows;
  const documentCounts=(await c.query(`SELECT count(*)::int AS total_stored_documents,
   count(*) FILTER(WHERE NOT EXISTS(SELECT 1 FROM cfo_event_sources s WHERE s.document_id=d.id) AND NOT EXISTS(SELECT 1 FROM cfo_events e WHERE e.document_id=d.id))::int AS without_transaction_links FROM cfo_documents d`)).rows[0];
  await c.query('COMMIT');
  const transactions=rows.map(r=>inspectEventFields(r,{sources:sources.filter(s=>s.event_id===r.id),journals:journals.filter(j=>j.event_id===r.id),categories}));
  const summaries=FIELD_CATALOG.map(f=>({key:f.key,label:f.label,group:f.group,counts:transactions.reduce((counts,t)=>{const state=t.fields.find(c=>c.key===f.key).state;counts[state]=(counts[state]||0)+1;return counts;},{})}));
  const found=new Set(selected),missing_requested_ids=ids?ids.filter(id=>!found.has(id)):[],has_more=!ids&&offset+rows.length<count;
  return{schema:'cfo_field_coverage/v1',catalog_version:FIELD_CATALOG_VERSION,read_only:true,financial_transaction_posted:false,originals_read:false,
   scope:{mode:ids?'selected_transactions':'recent_transactions',total_matching_transactions:count,returned:rows.length,offset,limit:ids?ids.length:limit,has_more,next_offset:has_more?offset+rows.length:null,missing_requested_ids,complete_for_scope:ids?missing_requested_ids.length===0:offset===0&&!has_more},
   document_summary:{scope:'whole_ledger',...documentCounts},field_catalog:FIELD_CATALOG,field_summary_scope:'returned_transactions_only',field_summary:summaries,transactions,
   note:'存量字段覆盖审计，不是原件重新识别或数据库迁移；未读取文件字节。已保存值的字段级证据尚未跟踪；计划中的分析字段不阻塞已明确交易。凭证数与交易数分别统计，分页未完成不能声称检查了全库。'};
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}
