import {displayLedger} from './display-ledger.mjs';
import {createHash} from 'node:crypto';import {z} from 'zod';import {transaction} from './db.mjs';import {yuan} from './money.mjs';import {journalChain,reverseJournal} from './journal-chain.mjs';
export const transactionActionSchema=z.object({action:z.enum(['delete','restore']),event_ids:z.array(z.uuid()).min(1).max(500),currency:z.enum(['CNY','USD','SGD']).default('CNY'),rate_id:z.uuid().optional()}).strict();
export const transactionApplySchema=transactionActionSchema.extend({confirmation_token:z.string().regex(/^[a-f0-9]{64}$/),allow_possible_duplicate:z.boolean().default(false)});
function fail(message){throw Object.assign(new Error(message),{code:'TRANSACTION_ACTION_CONFLICT'});}
async function facts(c,input,presentation={}){
 const read=displayLedger(c,presentation);
 let ids=[...new Set(input.event_ids.map(id=>id.toLowerCase()))].sort();const requested_count=ids.length;
 const groups=(await c.query("SELECT COALESCE(details->>'parent_source_key',source_key) AS key FROM cfo_broker_postings WHERE event_id=ANY($1::uuid[]) AND kind<>'opening'",[ids])).rows.map(r=>r.key);
 if(groups.length){const related=(await c.query("SELECT e.id FROM cfo_broker_postings p JOIN cfo_events e ON e.id=p.event_id WHERE (p.source_key=ANY($1::text[]) OR p.details->>'parent_source_key'=ANY($1::text[])) AND (e.deleted_at IS NOT NULL)=$2",[groups,input.action==='restore'])).rows;ids=[...new Set([...ids,...related.map(r=>r.id)])].sort();}
 const rows=(await c.query('SELECT * FROM cfo_events WHERE id=ANY($1::uuid[]) ORDER BY id',[ids])).rows;
 if(rows.length!==ids.length||rows.some(e=>input.action==='delete'?!!e.deleted_at:!e.deleted_at))fail('记录状态已变化，请刷新后重新选择');
 const effects={income:0n,expense:0n,cash:0n,asset:0n,liability:0n},fingerprints=[],duplicateIds=new Set();
 for(const e of rows){
  const chain=await journalChain(c,e.id),root=chain[0],leaf=chain.at(-1),financial=input.action==='delete'?e.status==='posted':e.deleted_status==='posted';
  if(financial){
   if(!root||!leaf)fail('已入账记录缺少原分录，请核对账本');
   if(input.action==='restore'&&leaf.id!==e.deleted_reversal_id)fail('删除后的分录已变化，请核对后再恢复');
   const lines=(await read.query('SELECT l.cny_cents::text,a.account_group,a.is_cash FROM cfo_lines l JOIN cfo_accounts a ON a.id=l.account_id WHERE l.entry_id=$1',[root.id])).rows;
   if(lines.length<2||lines.reduce((s,l)=>s+BigInt(l.cny_cents),0n)!==0n)fail('原分录未通过金额校验');
   for(const l of lines){const n=BigInt(l.cny_cents)*(input.action==='delete'?-1n:1n);if(l.account_group==='income')effects.income-=n;if(l.account_group==='expense')effects.expense+=n;if(l.account_group==='asset')effects.asset+=n;if(l.account_group==='liability')effects.liability-=n;if(l.is_cash)effects.cash+=n;}
   if(input.action==='restore'){
    if(e.payload.kind==='opening'&&(await c.query("SELECT id FROM cfo_events WHERE id<>$1 AND status='posted' AND payload->>'kind'='opening' AND payload->>'account_id'=$2",[e.id,e.payload.account_id])).rowCount)fail('该资产或负债已有新的期初记录，不能重复恢复旧期初');
    if(e.payload.kind!=='opening'&&e.payload.account_id&&e.payload.date&&e.payload.amount){const dup=(await c.query(`SELECT id FROM cfo_events WHERE NOT(id=ANY($1::uuid[])) AND status='posted' AND deleted_at IS NULL AND payload->>'account_id'=$2 AND (( $3::text IS NOT NULL AND payload->>'external_id'=$3) OR (payload->>'kind'=$4 AND payload->>'date'=$5 AND (payload->>'amount')::numeric=$6::numeric)) ORDER BY id`,[ids,e.payload.account_id,e.payload.external_id||null,e.payload.kind,e.payload.date,e.payload.amount])).rows;for(const d of dup)duplicateIds.add(d.id);}
   }
  }
  fingerprints.push([e.id,e.revision,e.status,e.deleted_at,e.deleted_status,e.deleted_reversal_id,leaf?.id||null]);
 }
 const duplicate_ids=[...duplicateIds].sort(),confirmation_token=createHash('sha256').update(JSON.stringify({action:input.action,currency:presentation.currency||'CNY',rate:presentation.rate||'1',fingerprints,duplicate_ids})).digest('hex');
 return{rows,linked_event_count:ids.length-requested_count,confirmation_token,duplicate_ids,effects:{income_cny:yuan(effects.income),expense_cny:yuan(effects.expense),profit_cny:yuan(effects.income-effects.expense),cash_cny:yuan(effects.cash),assets_cny:yuan(effects.asset),liabilities_cny:yuan(effects.liability)}};
}
export async function previewTransactionAction(pool,input,presentation={}){
 const q=transactionActionSchema.parse(input),c=await pool.connect();try{await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const f=await facts(c,q,presentation);await c.query('COMMIT');return{rate_id:presentation.snapshot?.id,currency:presentation.currency||'CNY',action:q.action,event_count:f.rows.length,linked_event_count:f.linked_event_count,posted_count:f.rows.filter(e=>q.action==='delete'?e.status==='posted':e.deleted_status==='posted').length,draft_count:f.rows.filter(e=>q.action==='delete'?e.status==='draft':e.deleted_status==='draft').length,effects:f.effects,duplicate_candidate_count:f.duplicate_ids.length,confirmation_token:f.confirmation_token,sample:f.rows.slice(0,6).map(e=>({id:e.id,description:e.payload.description||e.payload.kind,date:e.payload.date||null,amount:e.payload.amount||null,currency:e.payload.currency||null})),original_files_changed:false};}catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}
export async function applyTransactionAction(pool,input,presentation={}){
 const q=transactionApplySchema.parse(input);return transaction(pool,async c=>{
  await c.query('SELECT pg_advisory_xact_lock(20261102)');const f=await facts(c,q,presentation);if(f.confirmation_token!==q.confirmation_token)fail('记录或关联账目已更新，请重新确认');if(f.duplicate_ids.length&&!q.allow_possible_duplicate)fail('恢复后可能重复，请先确认这些是独立记录');
  for(const e of f.rows){
   if(q.action==='delete'){
    let reversal=null;if(e.status==='posted'){const chain=await journalChain(c,e.id);reversal=await reverseJournal(c,chain.at(-1),chain[0].entry_date,'删除记录：'+(e.payload.description||e.payload.kind));if(e.payload.kind==='opening')await c.query('UPDATE cfo_accounts SET opening_confirmed=false WHERE id=$1',[e.payload.account_id]);}
    await c.query("UPDATE cfo_events SET deleted_at=now(),deleted_status=status,deleted_reversal_id=$2,status=CASE WHEN status='posted' THEN 'reversed' WHEN status='draft' THEN 'discarded' ELSE status END,revision=revision+1,updated_at=now() WHERE id=$1",[e.id,reversal?.id||null]);
   }else{
    if(e.deleted_status==='posted'){const chain=await journalChain(c,e.id);await reverseJournal(c,chain.at(-1),chain[0].entry_date,'恢复已删除记录：'+(e.payload.description||e.payload.kind));if(e.payload.kind==='opening')await c.query('UPDATE cfo_accounts SET opening_confirmed=true WHERE id=$1',[e.payload.account_id]);}
    await c.query('UPDATE cfo_events SET status=deleted_status,deleted_at=NULL,deleted_status=NULL,deleted_reversal_id=NULL,revision=revision+1,updated_at=now() WHERE id=$1',[e.id]);
   }
   await c.query('INSERT INTO cfo_audit(action,entity_id,details) VALUES($1,$2,$3)',['transaction_'+q.action,e.id,JSON.stringify({source:'web',effects:f.effects,duplicate_override:q.allow_possible_duplicate})]);
  }
  return{action:q.action,event_count:f.rows.length,effects:f.effects,original_files_changed:false,financial_statements_updated:true};
 });
}
