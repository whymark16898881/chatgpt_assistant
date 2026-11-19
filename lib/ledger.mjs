import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { transaction } from './db.mjs';
import {recognitionSchema} from './recognition-contract.mjs';
import {saveRecognitionTx} from './recognition.mjs';
import {journalChain,reverseJournal} from './journal-chain.mjs';
import {bindSummaryAccount,ordinary} from './settlement.mjs';
import { START, CURRENCIES, validDate, cents, baseCents, yuan } from './money.mjs';

export const eventSchema = z.object({
  kind: z.enum(['income','expense','transfer','reimbursement_advance','reimbursement_received','valuation_gain','valuation_loss','opening']),
  balance_observation:z.object({amount:z.string().refine(v=>{try{cents(v,true);return true;}catch{return false;}}),currency:z.enum(CURRENCIES),as_of:z.string().refine(validDate).optional()}).strict().optional(),
  settlement:z.enum(['cash','credit','unknown']).optional(),
  currency: z.enum(CURRENCIES).optional(), date: z.string().max(20).optional(), amount: z.string().max(30).optional(),
  account_id: z.uuid().optional(), counter_account_id: z.uuid().optional(),
  counter_amount: z.string().max(30).optional(), fx_rate: z.string().max(30).optional(),
  counter_fx_rate: z.string().max(30).optional(), fx_source: z.string().max(150).optional(),
  category: z.string().max(80).optional(), description: z.string().max(500).default(''),
  merchant: z.string().max(150).optional(), external_id: z.string().max(150).optional(),
  account_hint: z.string().max(150).optional(), region: z.string().max(80).optional(),
  recognition:recognitionSchema.optional(), recognition_revision:z.number().int().min(0).optional(),
  needs_review: z.array(z.string().max(300)).max(20).default([])
}).strict();
export const accountSchema=z.object({name:z.string().trim().min(1).max(100),currency:z.enum(CURRENCIES),
  kind:z.enum(['bank','cash','investment','receivable','credit_card','loan','other_asset','other_liability'])}).strict();
const cashKinds=['bank','cash'];
const signFor = a => a.account_group==='liability' ? -1 : 1;
export async function listAccounts(pool) {
  return (await pool.query(`SELECT a.*,COALESCE(sum(l.native_cents),0)::text AS debit_native_cents,
    COALESCE(sum(l.cny_cents),0)::text AS debit_cny_cents FROM cfo_accounts a LEFT JOIN cfo_lines l ON l.account_id=a.id
    WHERE a.system_key IS NULL GROUP BY a.id ORDER BY a.created_at`)).rows.map(a=>({...a,balance:yuan(BigInt(a.debit_native_cents)*BigInt(signFor(a))),cny_balance:yuan(BigInt(a.debit_cny_cents)*BigInt(signFor(a)))}));
}
export async function createAccount(pool,input) {
  const a=accountSchema.parse(input);const group=['credit_card','loan','other_liability'].includes(a.kind)?'liability':'asset';
  return transaction(pool,async c=>{
    const r=await c.query(`INSERT INTO cfo_accounts(name,kind,account_group,currency,is_cash) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(name,currency) DO NOTHING RETURNING *`,[a.name,a.kind,group,a.currency,cashKinds.includes(a.kind)]);
    const row=r.rows[0]||(await c.query('SELECT * FROM cfo_accounts WHERE name=$1 AND currency=$2',[a.name,a.currency])).rows[0];
    if(row.kind!==a.kind)throw new Error('同名同币种账户已经存在，类型不同');
    if(r.rowCount)await audit(c,'account_created',row.id,{name:a.name,currency:a.currency});
    return row;
  });
}
async function audit(c,action,id,details={}) { await c.query('INSERT INTO cfo_audit(action,entity_id,details) VALUES($1,$2,$3)',[action,id,JSON.stringify(details)]); }
function dateToday(){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());}
async function plan(c,e) {
  const issues=[...e.needs_review];if(e.account_id&&(await c.query('SELECT 1 FROM cfo_broker_accounts WHERE account_id=$1',[e.account_id])).rowCount)issues.push('此账户由已核对券商来源自动入账，请勿重复手工记账');const records=(await c.query('SELECT * FROM cfo_accounts')).rows;
  const a=records.find(a=>a.id===e.account_id && !a.system_key);
  const b=records.find(a=>a.id===e.counter_account_id && !a.system_key);
  if(ordinary(e)&&e.settlement==='unknown')issues.push('需确认这笔收支已收已付还是尚未结算，不需要具体支付账户');
  if(e.kind==='income'&&e.settlement==='credit')issues.push('应收收入请核对应收处理，不能按现金或应付款入账');
  if(ordinary(e)&&!a&&!e.currency)issues.push('缺少明确币种，不能默认人民币');
  if(!a&&!(ordinary(e)&&!e.account_id))issues.push('请选择已建立的账户');
  if(ordinary(e)&&a&&e.settlement==='credit'&&a.account_group!=='liability')issues.push('赊购必须计入负债，不能当作已付现金');
  if(ordinary(e)&&a&&e.settlement==='cash'&&!a.is_cash)issues.push('已收已付需要现金资产，不能当作负债或证券估值');
  if(a&&e.currency&&a.currency!==e.currency)issues.push('凭证币种与账户币种不符，请核对账户');
  if(!validDate(e.date))issues.push('缺少有效交易日期');
  else if(e.date<START || e.date>dateToday())issues.push('交易日期必须在2026-11-01至今天之间；历史材料请用于期初余额');
  if(e.kind==='opening' && e.date!==START)issues.push('期初余额日期必须为2026-11-01');
  if(e.kind==='opening' && a?.opening_confirmed)issues.push('此账户的期初余额已确认，请通过冲销处理错误');
  let n,base,other,otherBase;
  try {n=cents(e.amount,e.kind==='opening');if(n===0 && e.kind!=='opening')throw new Error('交易金额必须大于0');}catch(error){issues.push(error.message);}
  if(a && n!==undefined)try{base=baseCents(n,e.fx_rate,a.currency);}catch(error){issues.push(error.message);}
  if(a && a.currency!=='CNY' && !e.fx_source?.trim())issues.push('请提供汇率来源，不能猜测汇率');
  const dual=['transfer','reimbursement_advance','reimbursement_received'].includes(e.kind);
  if(dual){
    if(!b)issues.push('请选择对方账户');
    if(a?.id===b?.id)issues.push('转账双方不能是同一账户');
    if(a && b){
      if(e.kind==='reimbursement_advance' && (!a.is_cash || b.kind!=='receivable'))issues.push('垫付需要现金账户及应收报销账户');
      if(e.kind==='reimbursement_received' && (a.kind!=='receivable' || !b.is_cash))issues.push('报销到账需要应收账户及现金账户');
      if(e.kind!=='transfer' && a.currency!==b.currency)issues.push('第一版报销冲销要求同币种；跨币种请先核对金额');
      try {other=a.currency===b.currency?n:cents(e.counter_amount);if(other<=0)throw new Error('对方金额必须大于0');otherBase=baseCents(other,a.currency===b.currency?e.fx_rate:e.counter_fx_rate,b.currency);}catch(error){issues.push(error.message);}
      if(b.currency!=='CNY' && !e.fx_source?.trim())issues.push('请提供汇率来源');
    }
  }
  if(['valuation_gain','valuation_loss'].includes(e.kind) && a?.kind!=='investment')issues.push('估值调整仅适用于投资总额账户');
  if(e.kind==='income' && a && a.account_group!=='asset')issues.push('收入需要资产账户');
  const category=e.category||(e.kind==='income'?'income.other':'expense.other');
  if(['income','expense'].includes(e.kind) && (!records.some(a=>a.system_key===category) || !category.startsWith(e.kind+'.') || ['income.fx','income.unrealized','expense.fx','expense.unrealized'].includes(category)))issues.push('交易分类不正确');
  if(!a&&!issues.length)issues.push('缺少可用的结算归类');
  const lines=[];let bucket='operating';
  const add=(account,native,value,rate=e.fx_rate||'1')=>lines.push({account_id:account.id,native_cents:native,cny_cents:value,fx_rate:account.currency==='CNY'?'1':rate,fx_source:account.currency==='CNY'?'CNY':e.fx_source});
  const nominal=(key,native)=>{const account=records.find(a=>a.system_key===key);if(!account)throw new Error('未知分类');add(account,native,native,'1');};
  if(!issues.length){
    if(e.kind==='opening') {add(a,n*signFor(a),base*signFor(a));nominal('equity.opening',-base*signFor(a));bucket='opening';}
    else if(e.kind==='income'){add(a,n,base);const cat=e.category||'income.other';if(!cat.startsWith('income.') || ['income.fx','income.unrealized'].includes(cat))issues.push('收入分类不正确');else nominal(cat,-base);}
    else if(e.kind==='expense'){const cat=e.category||'expense.other';if(!cat.startsWith('expense.') || ['expense.fx','expense.unrealized'].includes(cat))issues.push('费用分类不正确');else nominal(cat,base);add(a,-n,-base);}
    else if(dual){
      add(a,-n,-base);add(b,other,otherBase,a.currency===b.currency?(e.fx_rate||'1'):(e.counter_fx_rate||'1'));
      const diff=otherBase-base;if(diff>0)nominal('income.fx',-diff);else if(diff<0)nominal('expense.fx',-diff);
      if(a.kind==='investment'||b.kind==='investment')bucket='investing';
      else if(a.kind==='loan'||b.kind==='loan')bucket='financing';
    }else{const gain=e.kind==='valuation_gain';add(a,gain?n:-n,gain?base:-base);nominal(gain?'income.unrealized':'expense.unrealized',gain?-base:base);bucket='noncash';}
  }
  return {issues:[...new Set(issues)],lines,bucket};
}
async function duplicateCandidates(c,e,exceptId) {
  if(!e.account_id || !e.date || !e.amount || e.kind==='opening')return[];
  return (await c.query(`SELECT id,payload->>'description' AS description FROM cfo_events WHERE id<>$1 AND status='posted'
    AND payload->>'account_id'=$2 AND (
      ($3::text IS NOT NULL AND payload->>'external_id'=$3) OR
      (payload->>'kind'=$4 AND payload->>'date'=$5 AND (payload->>'amount')::numeric=$6::numeric)
    ) ORDER BY created_at DESC LIMIT 5`,[exceptId,e.account_id,e.external_id||null,e.kind,e.date,e.amount])).rows;
}
async function post(c,event,{allowPossibleDuplicate=false}={}) {
  if(event.status!=='draft')return event;
  const p=await plan(c,event.payload);
  // One finance write at a time prevents concurrent screenshot/statement imports racing dedup checks.
  const duplicates=p.issues.length?[]:await duplicateCandidates(c,event.payload,event.id);
  if(duplicates.length && !allowPossibleDuplicate)p.issues.push('可能重复，请核对已有交易后再确认');
  if(p.issues.length){return(await c.query('UPDATE cfo_events SET issues=$2,updated_at=now() WHERE id=$1 RETURNING *',[event.id,JSON.stringify(p.issues)])).rows[0];}
  const entry=(await c.query('INSERT INTO cfo_entries(event_id,entry_date,description,kind,cash_flow_bucket) VALUES($1,$2,$3,$4,$5) RETURNING id',[event.id,event.payload.date,event.payload.description,event.payload.kind,p.bucket])).rows[0];
  for(const line of p.lines)await c.query('INSERT INTO cfo_lines(entry_id,account_id,native_cents,cny_cents,fx_rate,fx_source) VALUES($1,$2,$3,$4,$5,$6)',[entry.id,line.account_id,line.native_cents,line.cny_cents,line.fx_rate,line.fx_source]);
  if(event.payload.kind==='opening')await c.query('UPDATE cfo_accounts SET opening_confirmed=true WHERE id=$1',[event.payload.account_id]);
  const row=(await c.query("UPDATE cfo_events SET status='posted',issues='[]',revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *",[event.id])).rows[0];
  await audit(c,'event_posted',event.id,{entry_id:entry.id,duplicate_override:allowPossibleDuplicate});return row;
}
export async function recordEvent(pool,{document_id,source_ref,request_key,payload,auto_post=true}) {
  const {recognition,recognition_revision,...input}=eventSchema.parse(payload);
  if(!source_ref?.trim() || source_ref.length>200 || !request_key?.trim() || request_key.length>200)throw new Error('需要稳定的来源位置和幂等键');
  return transaction(pool,async c=>{
    await c.query('SELECT pg_advisory_xact_lock(20261102)');
    const attach=async(event,reused)=>{const recognition_result=recognition?await saveRecognitionTx(c,event.id,recognition_revision??0,recognition):null;return{event,reused,...(recognition_result?{recognition_result}:{})};};
    let e=input;
    if(document_id){const d=(await c.query('SELECT trashed_at,purge_requested_at FROM cfo_documents WHERE id=$1',[document_id])).rows[0];if(!d||d.trashed_at||d.purge_requested_at)throw new Error('来源凭证已移入回收站或删除，请先恢复或重新上传');}
    const existing=(await c.query('SELECT e.* FROM cfo_events e LEFT JOIN cfo_event_sources s ON s.event_id=e.id WHERE e.request_key=$1 OR (e.document_id=$2 AND e.source_ref=$3) OR (s.document_id=$2 AND s.source_ref=$3) LIMIT 1',[request_key,document_id||null,source_ref])).rows[0];
    if(existing?.deleted_at)throw new Error('该来源交易已删除，请先在交易账本恢复，不重复记账');
    if(existing)return attach(existing,true);
    if(!document_id)throw new Error('候选交易需要已归档的来源凭证');
    e=await bindSummaryAccount(c,e);
    // Aggregation removes institution boundaries. Bare reference numbers are not
    // globally unique across banks/wallets; only source-scoped IDs may auto-link.
    const settlementNode=e.account_id?(await c.query('SELECT summary_kind FROM cfo_accounts WHERE id=$1',[e.account_id])).rows[0]:null;
    const scopedExternal=!settlementNode?.summary_kind||/^[A-Za-z][A-Za-z0-9_.-]{1,40}[:/]/.test(e.external_id||'');
    if(e.external_id && scopedExternal && e.account_id && e.date && e.amount) {
      let amount;try{amount=cents(e.amount);}catch{}
      if(amount!==undefined){
        const prior=(await c.query(`SELECT * FROM cfo_events WHERE status='posted' AND payload->>'account_id'=$1 AND payload->>'external_id'=$2 AND payload->>'date'=$3 AND payload->>'kind'=$4 AND (payload->>'amount')::numeric=$5::numeric LIMIT 1`,[e.account_id,e.external_id,e.date,e.kind,e.amount])).rows[0];
        if(prior){await c.query('INSERT INTO cfo_event_sources(document_id,source_ref,event_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[document_id,source_ref,prior.id]);await audit(c,'supporting_document_linked',prior.id,{document_id,source_ref});return attach(prior,true);}
      }
    }
    const row=(await c.query('INSERT INTO cfo_events(document_id,source_ref,request_key,payload) VALUES($1,$2,$3,$4) RETURNING *',[document_id,source_ref,request_key,JSON.stringify(e)])).rows[0];
    await c.query('INSERT INTO cfo_event_sources(document_id,source_ref,event_id) VALUES($1,$2,$3)',[document_id,source_ref,row.id]);
    await audit(c,'event_received',row.id,{document_id,source_ref});
    const result=await attach(row,false);return{...result,event:auto_post?await post(c,row):row};
  });
}
async function reviseDraftTx(c,id,{revision,payload,allow_possible_duplicate=false,auto_post=true}) {
    const row=(await c.query('SELECT * FROM cfo_events WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!row || row.deleted_at || row.status!=='draft')throw new Error('只能确认待处理交易');
    if(row.document_id){const d=(await c.query('SELECT trashed_at,purge_requested_at FROM cfo_documents WHERE id=$1',[row.document_id])).rows[0];if(d?.trashed_at||d?.purge_requested_at)throw new Error('来源凭证已移入回收站或删除，请先恢复或重新上传');}
    if(row.revision!==revision)throw new Error('交易已更新，请刷新后重试');
    const {recognition,recognition_revision,...input}=eventSchema.parse(payload);
    const next=await bindSummaryAccount(c,input);
    const updated=(await c.query('UPDATE cfo_events SET payload=$2,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *',[id,JSON.stringify(next)])).rows[0];
    await audit(c,'event_revised',id,{before:row.payload,after:next});const recognition_result=recognition?await saveRecognitionTx(c,id,recognition_revision??0,recognition):null;const checked=await plan(c,next);await c.query('UPDATE cfo_events SET issues=$2 WHERE id=$1',[id,JSON.stringify(checked.issues)]);updated.issues=checked.issues;const result=auto_post?await post(c,updated,{allowPossibleDuplicate:allow_possible_duplicate}):updated;return{...result,...(recognition_result?{recognition_result}:{})};
}
export async function reviseAndPost(pool,id,input) {
 return transaction(pool,async c=>{await c.query('SELECT pg_advisory_xact_lock(20261102)');return reviseDraftTx(c,id,input);});
}
const draftBatchSchema=z.object({action:z.enum(['save','confirm']),items:z.array(z.object({id:z.uuid(),revision:z.number().int().min(0),payload:eventSchema.optional(),allow_possible_duplicate:z.boolean().default(false)})).min(1).max(250)}).strict();
export async function processDraftBatch(pool,input){
 const {action,items}=draftBatchSchema.parse(input);
 if(new Set(items.map(x=>x.id)).size!==items.length)throw new Error('所选交易重复');
 return transaction(pool,async c=>{
  await c.query('SELECT pg_advisory_xact_lock(20261102)');const events=[];
  for(const item of items){
   const row=(await c.query('SELECT * FROM cfo_events WHERE id=$1 FOR UPDATE',[item.id])).rows[0];
   if(!row||row.deleted_at||row.status!=='draft')throw new Error('所选记录包含非草稿或已删除交易，请刷新后重试');
   if(action==='confirm'&&item.payload!==undefined)throw new Error('确认仅使用已保存资料，请先保存补充');
   if(action==='save'&&item.payload===undefined)throw new Error('补充资料不能为空');
   const result=await reviseDraftTx(c,item.id,{revision:item.revision,payload:action==='save'?item.payload:row.payload,auto_post:action==='confirm',allow_possible_duplicate:item.allow_possible_duplicate});
   if(action==='confirm'&&result.status!=='posted')throw new Error('未入账，整批保留草稿：'+(row.payload.description||'交易')+'；'+result.issues.join('；'));
   events.push(result);
  }
  return{action,count:events.length,events,financial_transaction_posted:action==='confirm'};
 });
}
export async function discardDraft(pool,id) {
  return transaction(pool,async c=>{await c.query('SELECT pg_advisory_xact_lock(20261102)');const row=(await c.query("UPDATE cfo_events SET status='discarded',revision=revision+1,updated_at=now() WHERE id=$1 AND status='draft' AND deleted_at IS NULL RETURNING *",[id])).rows[0];if(!row)throw new Error('只能忽略待处理记录');await audit(c,'event_discarded',id);return row;});
}
export async function reverseEvent(pool,id,{date,reason}) {
  if(!validDate(date)||date<START||date>dateToday()||!reason?.trim())throw new Error('需要有效冲销日期和原因');
  return transaction(pool,async c=>{
    await c.query('SELECT pg_advisory_xact_lock(20261102)');
    const event=(await c.query('SELECT * FROM cfo_events WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!event || event.deleted_at || !['posted','reversed'].includes(event.status))throw new Error('仅已入账交易可冲销');
    if(event.status==='reversed')return event;
    if(event.payload.managed_investment&&event.payload.kind!=='opening')throw new Error('券商期间分录需整组撤回，请在交易账本使用删除，系统会同时撤回关联结算与损益分录');
    if(event.payload.kind==='opening' && date!==START)throw new Error('期初余额的冲销日期必须为2026-11-01');
    const entry=(await journalChain(c,id)).at(-1);
    if(date<entry.entry_date)throw new Error('冲销日期不能早于原交易');
    const reversed=await reverseJournal(c,entry,date,'冲销：'+reason);
    const result=(await c.query("UPDATE cfo_events SET status='reversed',revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *",[id])).rows[0];
    if(event.payload.kind==='opening')await c.query('UPDATE cfo_accounts SET opening_confirmed=false WHERE id=$1',[event.payload.account_id]);
    await audit(c,'event_reversed',id,{date,reason,reversal_entry:reversed.id});return result;
  });
}
export async function listEvents(pool,{onlyDeleted=false}={}) {return(await pool.query(`SELECT e.*,d.filename,d.sha256,COALESCE((SELECT max(r.revision) FROM cfo_recognition_versions r WHERE r.event_id=e.id),0) AS recognition_revision FROM cfo_events e LEFT JOIN cfo_documents d ON d.id=e.document_id WHERE (e.deleted_at IS NOT NULL)=$1 ORDER BY e.created_at DESC LIMIT 250`,[onlyDeleted])).rows;}
export async function eventPage(pool,input={}){
 const q=z.object({status:z.enum(['all','draft','posted','reversed','discarded','deleted']).default('all'),search:z.string().max(500).default(''),include_zero:z.boolean().default(false),limit:z.number().int().min(1).max(100).default(20),offset:z.number().int().min(0).max(10000000).default(0)}).parse(input);
 const where=`(e.deleted_at IS NOT NULL)=$1 AND ($2='all' OR $2='deleted' OR e.status=$2) AND ($3='' OR strpos(lower(concat_ws(' ',e.payload->>'description',e.payload->>'merchant',e.payload->>'kind',a.name,d.filename)),lower($3))>0) AND ($4 OR CASE WHEN e.payload->>'amount' ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (e.payload->>'amount')::numeric<>0 ELSE true END)`;
 const args=[q.status==='deleted',q.status,q.search,q.include_zero];
 return transaction(pool,async c=>{await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');const join='FROM cfo_events e LEFT JOIN cfo_documents d ON d.id=e.document_id LEFT JOIN cfo_accounts a ON a.id::text=e.payload->>\'account_id\'';const count=(await c.query('SELECT count(*)::int AS total '+join+' WHERE '+where,args)).rows[0].total;const events=(await c.query('SELECT e.*,d.filename '+join+' WHERE '+where+' ORDER BY e.created_at DESC,e.id DESC LIMIT $5 OFFSET $6',[...args,q.limit,q.offset])).rows;return{events,total:count,limit:q.limit,offset:q.offset};});
}
export async function categories(pool){return(await pool.query("SELECT system_key AS key,name,account_group FROM cfo_accounts WHERE account_group IN ('income','expense') ORDER BY system_key")).rows;}
export function requestKey(documentId,sourceRef){return createHash('sha256').update(documentId+':'+sourceRef).digest('hex');}
