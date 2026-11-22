// The inbox asks once per line. Ten Gojek charges become ten identical
// questions, and answering the tenth teaches the system nothing. A
// clarification is the question underneath them: ask it once, settle it with a
// rule, re-run the backlog, and the list gets shorter every time it is used.
//
// Ranking is by money at stake, not by how often something repeats: one S$2,400
// line nobody can file matters more than ten S$5 ones.
import Decimal from 'decimal.js';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {CURRENCIES,START,validDate} from './money.mjs';
import {convertReference} from './presentation-fx.mjs';
import {matchRule,listRules,addRule,recordHit} from './rules.mjs';
import {reviseAndPost} from './ledger.mjs';
import {previewTransactionAction,applyTransactionAction} from './transaction-lifecycle.mjs';
import {ordinary} from './settlement.mjs';

// Corporate and channel boilerplate carries no meaning for filing, and a bare
// reference number differs on every line of the same merchant.
const NOISE=new Set(['pte','ptd','ltd','inc','llc','llp','co','corp','corporation','company','limited','sdn','bhd','gmbh',
 'sg','sgp','singapore','cn','china','hk','hkg','my','usa','us','intl','international','holdings','group','store','online',
 'pay','payment','payments','paylah','paynow','purchase','pos','txn','trx','ref','card','debit','credit','visa','mastercard','the','and','for','of','to']);
// Each token is a contiguous slice of the original text, so a token is always a
// substring of every member of its group. The proposed rule pattern therefore
// matches them all — a pattern assembled from pieces would silently match none.
export function merchantTokens(raw){
 return String(raw??'').toLowerCase().replace(/[^0-9a-z㐀-鿿぀-ヿ]+/g,' ').split(' ')
  .filter(t=>t&&!/^\d+$/.test(t)&&!NOISE.has(t));
}
export function merchantKey(raw){
 const tokens=merchantTokens(raw);if(!tokens.length)return null;
 const head=tokens[0];
 // A single character names nothing, and a rule pattern that short would match
 // half the ledger. Such a line stays in the per-transaction inbox.
 return head.length<2?null:head;
}
const sha12=s=>createHash('sha256').update(s).digest('hex').slice(0,12);
const displayKey=key=>/[^\x00-\x7F]/.test(key)?key:key.toUpperCase();
// Mirrors how capture judges a candidate, so a question disappears for exactly
// the same reason the rule would have kept it out in the first place.
export const ruleSubject=p=>({kind:p.kind,merchant:p.merchant,description:p.description,memo:p.account_hint,
 account_name:p.platform_name,platform_name:p.platform_name,amount:p.amount,currency:p.currency});
const magnitude=p=>{const v=p.amount;return typeof v==='string'&&/^-?\d+(\.\d{1,2})?$/.test(v)?v.replace('-',''):null;};
const sourceLabel=row=>row.payload?.platform_name||row.payload?.account_hint||row.filename||'未标注来源';
const kindWord=k=>k==='income'?'收入':'支出';

const FIELDS=[
 {field:'currency',label:'币种',
  // plan() refuses to default a missing currency to CNY, and it should not: the
  // same statement can hold three.
  applies:p=>ordinary(p)&&!p.currency&&!p.account_id,
  title:(n,scope)=>`${scope} 的 ${n} 笔没有币种`,
  question:'这些交易统一是哪种货币？',
  options:CURRENCIES.map(c=>({value:c,label:c}))},
 {field:'settlement',label:'结算方式',
  applies:p=>ordinary(p)&&p.settlement==='unknown'&&!p.account_id,
  title:(n,scope)=>`${scope} 的 ${n} 笔说不清是已付还是赊欠`,
  question:'这些交易统一按哪种结算处理？',
  options:[{value:'cash',label:'已收已付（计入综合现金）'},{value:'credit',label:'赊购 / 信用卡欠款（计入综合应付款）'}]},
 {field:'date',label:'交易日期',
  applies:p=>p.kind!=='opening'&&!validDate(p.date),
  title:(n,scope)=>`${scope} 的 ${n} 笔缺交易日期`,
  question:'这些交易统一记在哪一天？',
  options:null},
];

export function buildClarifications({drafts=[],posted=[],rules=[],convert=()=>null,currency='CNY',rate_date=null}={}){
 const enabled=rules.filter(r=>r.enabled!==false),groups=new Map();
 const amountOf=p=>{const raw=magnitude(p);return raw===null?null:convert(raw,p.currency||null);};
 const push=(id,init,row,state)=>{
  if(!groups.has(id))groups.set(id,{id,...init,draft_count:0,posted_count:0,amount_unknown_count:0,total:new Decimal(0),
   variants:new Map(),backlog:[],samples:[]});
  const g=groups.get(id),p=row.payload||{},value=amountOf(p);
  if(value===null)g.amount_unknown_count++;else g.total=g.total.plus(value);
  if(state==='draft'){
   g.draft_count++;g.backlog.push({event_id:row.id,revision:row.revision});
   if(g.samples.length<6)g.samples.push({event_id:row.id,description:p.description||'',merchant:p.merchant||null,
    date:p.date||null,amount:p.amount??null,currency:p.currency||null,filename:row.filename||null,
    issues:Array.isArray(row.issues)?row.issues.slice(0,2):[]});
  }else g.posted_count++;
  const label=(p.merchant||p.description||'').trim();
  if(label)g.variants.set(label,(g.variants.get(label)||0)+1);
 };
 const gaps=p=>FIELDS.filter(f=>f.applies(p));
 for(const [rows,state] of [[drafts,'draft'],[posted,'posted']])for(const row of rows){
  const p=row.payload||{};
  if(!['income','expense'].includes(p.kind))continue;
  if(matchRule(enabled,ruleSubject(p)))continue; // already settled once, never asked again
  // A line whose currency or date is still missing cannot be filed by choosing a
  // category, so it belongs to that question instead of being asked about twice.
  // Once the field is answered it either posts or comes back as a merchant
  // question of its own.
  if(state==='draft'&&gaps(p).length)continue;
  const key=merchantKey(p.merchant||p.description);
  if(!key)continue;
  push(`merchant:${p.kind}:${sha12(key)}`,{type:'merchant',kind:p.kind,field:null,match_key:key,
   suggested_pattern:key,question:`这类${kindWord(p.kind)}该归到哪个科目？`},row,state);
 }
 for(const row of drafts){
  const p=row.payload||{};
  for(const spec of FIELDS){
   if(!spec.applies(p))continue;
   const scope=sourceLabel(row);
   push(`field:${spec.field}:${sha12(scope)}`,{type:'field',kind:null,field:spec.field,field_label:spec.label,
    scope_label:scope,options:spec.options,question:spec.question},row,'draft');
  }
 }
 const finish=g=>{
  const {total,variants,...rest}=g;
  const list=[...variants.entries()].sort((a,b)=>b[1]-a[1]).slice(0,8).map(([merchant,count])=>({merchant,count}));
  const spec=g.type==='field'?FIELDS.find(f=>f.field===g.field):null;
  return{...rest,variants:list,impact_amount:total.toFixed(2),impact_currency:currency,
   blocking:g.draft_count>0,
   // Name the question after what the rule will key on, not after one of the
   // spellings: picking a single receipt's wording invites answering for it alone.
   title:spec?spec.title(g.draft_count,g.scope_label)
    :`「${list.length===1?list[0].merchant:displayKey(g.match_key)}」这类${kindWord(g.kind)}算什么科目`};
 };
 const order=(a,b)=>{const x=new Decimal(a.impact_amount),y=new Decimal(b.impact_amount);
  return !x.eq(y)?y.cmp(x):a.draft_count!==b.draft_count?b.draft_count-a.draft_count:a.id<b.id?-1:1;};
 const all=[...groups.values()].map(finish);
 return{
  schema:'cfo_clarifications/v1',currency,rate_date,
  blocking:all.filter(q=>q.blocking).sort(order),
  // Nothing is stuck yet, but the same question is coming back: a merchant seen
  // more than once with no rule will be asked about on every future statement.
  preventive:all.filter(q=>!q.blocking&&q.posted_count>1).sort(order),
  totals:{draft_count:drafts.length,blocking_count:all.filter(q=>q.blocking).length,active_rules:enabled.length},
  note:'影响金额按所选展示币种折算；币种未知的交易计入「金额待定」，不折算也不按零处理。已入账交易不会因新规则改写，规则只作用于待处理交易与今后的新材料。',
 };
}

export async function clarifications(pool,{currency='CNY',rates={CNY:'1'},rate_date=null}={}){
 const [draftRows,postedRows,rules]=await Promise.all([
  pool.query(`SELECT e.id,e.revision,e.payload,e.issues,d.filename FROM cfo_events e LEFT JOIN cfo_documents d ON d.id=e.document_id
   WHERE e.status='draft' AND e.deleted_at IS NULL ORDER BY e.created_at DESC LIMIT 1000`),
  pool.query(`SELECT e.id,e.payload FROM cfo_events e WHERE e.status='posted' AND e.deleted_at IS NULL
   AND e.payload->>'kind' IN ('income','expense') ORDER BY e.created_at DESC LIMIT 2000`),
  listRules(pool)]);
 return{...buildClarifications({drafts:draftRows.rows,posted:postedRows.rows,rules,currency,rate_date,
  convert:(amount,from)=>from?convertReference(amount,from,currency,rates):null}),rules};
}

export const clarificationAnswerSchema=z.object({
 question_id:z.string().trim().min(3).max(120),
 rule:z.object({pattern:z.string().trim().min(2).max(120),action:z.enum(['categorize','skip']),
  category:z.string().trim().max(80).optional(),reason:z.string().trim().min(2).max(300),
  account_pattern:z.string().trim().min(1).max(200).optional(),priority:z.number().int().min(1).max(1000).optional(),
  min_amount:z.number().positive().max(100000000).optional(),amount_currency:z.enum(CURRENCIES).optional()}).strict().optional(),
 field:z.object({field:z.enum(['currency','settlement','date']),value:z.string().trim().min(1).max(20)}).strict().optional(),
}).strict().refine(v=>!!v.rule!==!!v.field,{message:'一次只回答一个问题'});

// Deleting a draft keeps the payload and can be restored from 交易账本; it is the
// reversible way to set a line aside. Discarding is not, and an answer given in
// one click must be takeable back in one.
async function setAside(pool,eventId){
 const preview=await previewTransactionAction(pool,{action:'delete',event_ids:[eventId]});
 await applyTransactionAction(pool,{action:'delete',event_ids:[eventId],confirmation_token:preview.confirmation_token});
}
const fieldValue={
 currency:v=>{if(!CURRENCIES.includes(v))throw new Error('币种不在支持范围');return v;},
 settlement:v=>{if(!['cash','credit'].includes(v))throw new Error('结算方式只能是已收已付或赊购');return v;},
 date:v=>{if(!validDate(v)||v<START)throw new Error('交易日期无效，记账自2026-11-01开始');return v;},
};

export async function answerClarification(pool,input){
 const answer=clarificationAnswerSchema.parse(input);
 const current=await clarifications(pool);
 const question=[...current.blocking,...current.preventive].find(q=>q.id===answer.question_id);
 if(!question)throw new Error('这条待澄清问题已经不在清单上，请刷新后重新确认');
 let rule=null,patch=null;
 if(answer.rule){
  if(question.type!=='merchant')throw new Error('这条问题不是商户归类问题');
  // The direction is the question's own: a refund from the same merchant is not
  // the expense the user just filed.
  rule=await addRule(pool,{...answer.rule,applies_to:question.kind});
 }else{
  if(question.type!=='field'||question.field!==answer.field.field)throw new Error('这条问题不是这个字段的统一指定');
  patch=fieldValue[answer.field.field](answer.field.value);
 }
 const rules=rule?await listRules(pool):[];
 const results=[];
 for(const member of question.backlog){
  const row=(await pool.query('SELECT id,revision,payload,status,deleted_at FROM cfo_events WHERE id=$1',[member.event_id])).rows[0];
  if(!row||row.status!=='draft'||row.deleted_at){results.push({event_id:member.event_id,outcome:'changed'});continue;}
  try{
   if(rule){
    const hit=matchRule(rules,ruleSubject(row.payload));
    // A pattern the user narrowed may no longer cover every line that raised the
    // question; those stay drafts and are reported, not quietly re-filed.
    if(!hit){results.push({event_id:row.id,outcome:'not_matched'});continue;}
    // Counted here as well as at the capture gate: a rule's hit count is how an
    // over-broad answer is found later.
    await recordHit(pool,hit.id);
    if(hit.action==='skip'){await setAside(pool,row.id);results.push({event_id:row.id,outcome:'set_aside'});continue;}
    const out=await reviseAndPost(pool,row.id,{revision:row.revision,payload:{...row.payload,category:hit.category}});
    results.push({event_id:row.id,outcome:out.status==='posted'?'posted':'still_draft',issues:out.issues||[]});
   }else{
    const out=await reviseAndPost(pool,row.id,{revision:row.revision,payload:{...row.payload,[answer.field.field]:patch}});
    results.push({event_id:row.id,outcome:out.status==='posted'?'posted':'still_draft',issues:out.issues||[]});
   }
  }catch(e){results.push({event_id:row.id,outcome:'failed',reason:e.message});}
 }
 const count=outcome=>results.filter(r=>r.outcome===outcome).length;
 return{question_id:question.id,rule,field:answer.field||null,
  applied:{total:results.length,posted:count('posted'),still_draft:count('still_draft'),set_aside:count('set_aside'),
   not_matched:count('not_matched'),failed:count('failed'),changed:count('changed')},
  results,financial_transaction_posted:count('posted')>0,posted_event_count:question.posted_count,
  note:'已入账交易不受新规则影响；仍未入账的交易保留为待处理，原因已逐笔列出。被搁置的交易可在交易账本的「已删除」中恢复。'};
}
