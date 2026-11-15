import {z} from 'zod';
import DecimalBase from 'decimal.js';
import {createHash} from 'node:crypto';
import {transaction} from './db.mjs';
const D=DecimalBase.clone({precision:60}),tol=new D('0.01');
const brokers=['moomoo','tiger','futubull'];
const stamp=z.iso.datetime({offset:true});
const day=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s=>!Number.isNaN(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s);
const decimal=z.string().regex(/^-?\d{1,18}(\.\d{1,12})?$/);
const scope=z.array(z.enum(brokers)).min(1).max(3).refine(a=>new Set(a).size===a.length);
const keySchema=z.object({account_scope:scope,kind:z.enum(['balance','period']),as_of:stamp.nullable(),period_start:day.nullable(),period_end:day.nullable()});
const common=z.object({result_id:z.string().min(1).max(240),logical_key:keySchema,content_hash:z.string().regex(/^sha256:[a-f0-9]{64}$/),revision:z.number().int().min(0),kind:z.enum(['balance','period']),account_scope:scope,currency:z.literal('USD'),normalized:z.literal(true)}).passthrough();
const balance=common.extend({kind:z.literal('balance'),as_of:stamp,status:z.enum(['available','unavailable']).optional(),unavailable_reason:z.union([z.string().trim().min(1).max(2000),z.array(z.string().trim().min(1).max(2000)).min(1).max(20)]).optional(),decomposable:z.boolean(),decomposition_basis:z.string().nullable(),assets_total:decimal.nullable(),liabilities_total:decimal.nullable(),net_assets:decimal.nullable(),assets:z.object({cash_positive:decimal,long_market_value:decimal}).nullable(),liabilities:z.object({margin_debit:decimal,short_market_value:decimal}).nullable(),identity_check:z.object({tolerance:decimal,residual:decimal,passed:z.boolean()}).passthrough().nullable(),liabilities_completeness:z.object({covers:z.array(z.string()),excludes:z.array(z.string()),complete:z.boolean().optional()}).passthrough().optional()}).passthrough();
const period=common.extend({kind:z.literal('period'),as_of:stamp.nullable().optional(),period_start:day,period_end:day,coverage_through:day.nullable(),opening_net_assets:decimal.nullable(),closing_net_assets:decimal.nullable(),net_cash_in:decimal.nullable(),net_securities_in_fv:decimal.nullable(),total_pnl:decimal.nullable(),auto_postable:z.boolean().optional(),status:z.string().optional()}).passthrough();
const dataset=z.object({schema:z.literal('account_results/v1'),status:z.string(),generated_at:stamp,currency:z.literal('USD'),normalized:z.literal(true),producer:z.string().optional(),export_batch:z.object({export_id:z.string().min(1)}).passthrough(),results:z.array(z.discriminatedUnion('kind',[balance,period])).min(3).max(2000)}).passthrough();
function fail(code,message){throw Object.assign(new Error(message),{code});}
function canonical(v){if(Array.isArray(v))return v.map(canonical);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])]));return v;}
const hash=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
export function accountResultHash(result){const{content_hash,...body}=result;return 'sha256:'+hash(body);}
function logicalKey(r){return{account_scope:[...r.account_scope].sort(),kind:r.kind,as_of:r.as_of??null,period_start:r.kind==='period'?r.period_start:null,period_end:r.kind==='period'?r.period_end:null};}
export function accountResultKey(r){return hash(logicalKey(r));}
export function validateAccountResults(input,{allowSample=false,manifest=null,risk=null,now=()=>Date.now()}={}){
 let d;try{d=dataset.parse(input);}catch{fail('INVALID_ACCOUNT_RESULTS','账户结果结构或金额类型无效');}
 const sample=/sample|test|虚构/i.test(d.status)||/尚未实现/.test(d.producer||'');
 if(sample&&!allowSample)fail('TEST_DATA_REJECTED','虚构账户结果禁止进入真实数据链路');
 if(!sample&&d.status!=='live')fail('INVALID_ACCOUNT_RESULTS','正式账户结果必须明确status=live');
 if(!sample&&Date.parse(d.generated_at)>now()+300000)fail('INVALID_ACCOUNT_RESULTS','账户结果生成时间在未来');
 if(manifest&&(d.export_batch.export_id!==manifest.export_id||Date.parse(d.generated_at)>Date.parse(manifest.exported_at)))fail('ACCOUNT_RESULTS_SOURCE_MISMATCH','账户结果导出批次或生成时间不符');
 const keys=new Set(),balanceBrokers=new Set(),rows=[];
 for(let i=0;i<d.results.length;i++){
  const r=d.results[i],raw=input.results[i],key=accountResultKey(r);
  if(hash({...r.logical_key,account_scope:[...r.logical_key.account_scope].sort()})!==hash(logicalKey(r)))fail('INVALID_ACCOUNT_RESULTS','账户结果逻辑键与内容不一致');
  if(keys.has(key))fail('INVALID_ACCOUNT_RESULTS','同批账户结果逻辑键重复');keys.add(key);
  if(!sample&&accountResultHash(raw)!==r.content_hash)fail('ACCOUNT_RESULTS_HASH_MISMATCH','账户结果内容哈希不符');
  let state;
  if(r.kind==='balance'){
   if(r.account_scope.length!==1||balanceBrokers.has(r.account_scope[0]))fail('INVALID_ACCOUNT_RESULTS','账户余额必须逐券商唯一');balanceBrokers.add(r.account_scope[0]);
   if(Date.parse(r.as_of)>Date.parse(d.generated_at)||(!sample&&Date.parse(r.as_of)>now()+300000))fail('INVALID_ACCOUNT_RESULTS','账户余额时间不符');
   if(r.status==='unavailable'){
    if(r.net_assets!==null||r.decomposable!==false||r.decomposition_basis!==null||[r.assets_total,r.liabilities_total,r.assets,r.liabilities,r.identity_check].some(x=>x!==null)||!r.unavailable_reason)fail('INVALID_ACCOUNT_RESULTS','不可用余额必须明确缺失原因且金额全部为null');
    if(risk){const b=risk.brokers?.[r.account_scope[0]];
     if(Date.parse(r.as_of)!==Date.parse(risk.ts?.replace(' ','T')+'+08:00')||b?.broker?.total_assets!=null)fail('ACCOUNT_RESULTS_SOURCE_MISMATCH','不可用余额的时点或源数据状态不一致');
    }
    state='unavailable';
   }else{
    if(r.net_assets===null)fail('INVALID_ACCOUNT_RESULTS','可用余额必须有净资产，不能静默缺失');
   if(r.decomposable){
    if(r.decomposition_basis!=='gross_assets_liabilities'||r.assets_total===null||r.liabilities_total===null||!r.assets||!r.liabilities||!r.identity_check||!r.liabilities_completeness)fail('INVALID_ACCOUNT_RESULTS','毛额拆分缺少必要字段');
    const a=new D(r.assets_total),l=new D(r.liabilities_total),n=new D(r.net_assets);
    const components=[...Object.values(r.assets),...Object.values(r.liabilities)];
    if(a.lt(0)||l.lt(0)||components.some(x=>new D(x).lt(0))||new D(r.identity_check.tolerance).lt(0)||new D(r.identity_check.tolerance).gt(tol)||r.identity_check.passed!==true||a.minus(l).minus(n).abs().gt(tol)||a.minus(r.assets.cash_positive).minus(r.assets.long_market_value).abs().gt(tol)||l.minus(r.liabilities.margin_debit).minus(r.liabilities.short_market_value).abs().gt(tol)||a.minus(l).minus(n).minus(r.identity_check.residual).abs().gt(tol))fail('ACCOUNT_RESULTS_IDENTITY_FAILED','账户资产负债数值或分项不满足恒等式');
   }else if([r.assets_total,r.liabilities_total,r.assets,r.liabilities,r.identity_check].some(x=>x!==null))fail('INVALID_ACCOUNT_RESULTS','不可拆账户不得填入资产负债分解');
   if(risk){const broker=r.account_scope[0],riskTime=risk.ts?.replace(' ','T')+'+08:00',n=risk.brokers?.[broker]?.broker?.total_assets;
    if(Date.parse(r.as_of)!==Date.parse(riskTime)||n==null||new D(r.net_assets).minus(n).abs().gt(tol))fail('ACCOUNT_RESULTS_SOURCE_MISMATCH','账户结果与同批风控余额或时点不一致');
    if(r.decomposable){const b=risk.brokers[broker].broker;
     if([b.cash,b.long_mv,b.short_mv].some(x=>x==null))fail('ACCOUNT_RESULTS_SOURCE_MISMATCH','毛额结果缺少同批风控多空及现金验证字段');
     const cash=new D(b.cash),long=new D(b.long_mv),short=new D(b.short_mv);
     if(short.gt(0)||long.lt(0)||new D(r.assets.cash_positive).minus(D.max(cash,0)).abs().gt(tol)||new D(r.liabilities.margin_debit).minus(D.max(cash.negated(),0)).abs().gt(tol)||new D(r.assets.long_market_value).minus(long).abs().gt(tol)||new D(r.liabilities.short_market_value).minus(short.abs()).abs().gt(tol))fail('ACCOUNT_RESULTS_SOURCE_MISMATCH','账户拆分与同批现金或多空市值不符');
    }
   }
   state='balance';
   }
  }else{
   if(r.as_of!=null||r.period_start>r.period_end||r.period_end>new Date(Date.parse(d.generated_at)+8*3600000).toISOString().slice(0,10)||r.coverage_through!==null&&r.coverage_through>r.period_end)fail('INVALID_ACCOUNT_RESULTS','期间结果日期范围无效');
   const amounts=['opening_net_assets','closing_net_assets','net_cash_in','net_securities_in_fv','total_pnl'];
   if(r.status==='unavailable'){
    if(amounts.some(k=>r[k]!==null)||r.auto_postable===true)fail('INVALID_ACCOUNT_RESULTS','不可用损益必须保留null且不可自动入账');state='unavailable';
   }else{
    const allKnown=amounts.every(k=>r[k]!==null);
    if(allKnown&&new D(r.closing_net_assets).minus(r.opening_net_assets).minus(r.net_cash_in).minus(r.net_securities_in_fv).minus(r.total_pnl).abs().gt(tol))fail('ACCOUNT_RESULTS_IDENTITY_FAILED','期间结果数值不满足净值桥接恒等式');
    const reconciled=r.account_scope.every(b=>r.flow_coverage?.[b]?.reconciled===true&&day.safeParse(r.flow_coverage[b].reconciled_through).success&&r.flow_coverage[b].reconciled_through>=r.period_end&&typeof r.flow_coverage[b].reconciliation_basis==='string'&&r.flow_coverage[b].reconciliation_basis.trim());
    const eligible=allKnown&&r.coverage_through>=r.period_end&&reconciled&&r.securities_transfer_coverage?.covered===true;
    if(r.auto_postable===true&&!eligible)fail('ACCOUNT_RESULTS_INCOMPLETE','期间结果不满足核对覆盖，禁止声明可自动入账');
    state=r.auto_postable===true?'pending_account_mapping':'reference';
   }
  }
  rows.push({logical_key:key,payload_hash:r.content_hash,revision:r.revision,kind:r.kind,as_of:r.kind==='balance'?r.as_of:null,period_start:r.kind==='period'?r.period_start:null,period_end:r.kind==='period'?r.period_end:null,status:sample?'sample':state,payload:r});
 }
 if(brokers.some(b=>!balanceBrokers.has(b)))fail('ACCOUNT_RESULTS_INCOMPLETE','账户结果缺少三家必要余额');
 const periods=rows.filter(r=>r.kind==='period');
 for(let i=0;i<periods.length;i++)for(let j=i+1;j<periods.length;j++){
  const a=periods[i],b=periods[j];if(a.payload.account_scope.some(s=>b.payload.account_scope.includes(s))&&a.period_start<=b.period_end&&b.period_start<=a.period_end)fail('INVALID_ACCOUNT_RESULTS','同账户期间结果重叠，不能重复累计');
 }
 return{sample,has_unavailable_balances:rows.some(r=>r.kind==='balance'&&r.status==='unavailable'),generated_at:d.generated_at,export_id:d.export_batch.export_id,rows,financial_transaction_posted:false};
}
export async function saveAccountResults(pool,validated){
 if(validated.has_unavailable_balances)fail('ACCOUNT_RESULTS_INCOMPLETE','不完整余额只能隔离存档，不覆盖已接受余额');
 if(validated.sample)fail('TEST_DATA_REJECTED','样例结果只用于离线验证，不保存为真实结果');
 return transaction(pool,async c=>{
  await c.query('SELECT pg_advisory_xact_lock(20261106)');let inserted=0;
  for(const r of validated.rows){
   const old=(await c.query('SELECT payload_hash FROM cfo_account_results WHERE logical_key=$1 AND revision=$2',[r.logical_key,r.revision])).rows[0];
   if(old){if(old.payload_hash!==r.payload_hash)fail('ACCOUNT_RESULTS_REVISION_CONFLICT','同一账户结果同版本内容冲突，未覆盖历史');continue;}
   if(r.kind==='period'){
    const overlaps=(await c.query("SELECT payload FROM cfo_account_results WHERE kind='period' AND logical_key<>$1 AND period_start<=$2 AND period_end>=$3",[r.logical_key,r.period_end,r.period_start])).rows;
    if(overlaps.some(old=>old.payload.account_scope.some(b=>r.payload.account_scope.includes(b))))fail('ACCOUNT_RESULTS_PERIOD_OVERLAP','新期间与已保存的同账户结果重叠，未重复累计');
   }
   await c.query('INSERT INTO cfo_account_results(logical_key,revision,payload_hash,kind,as_of,period_start,period_end,status,payload,export_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[r.logical_key,r.revision,r.payload_hash,r.kind,r.as_of,r.period_start,r.period_end,r.status,JSON.stringify(r.payload),validated.export_id]);inserted++;
  }
  return{inserted,reused:inserted===0,financial_transaction_posted:false};
 });
}
export async function accountResultOverview(pool,{month}={}){
 const rows=(await pool.query('SELECT DISTINCT ON(logical_key) * FROM cfo_account_results ORDER BY logical_key,revision DESC')).rows;
 const balances=[];for(const broker of brokers){const r=rows.filter(r=>r.kind==='balance'&&r.payload.account_scope[0]===broker).sort((a,b)=>Date.parse(b.as_of)-Date.parse(a.as_of))[0];if(r)balances.push({account_id:broker,as_of:r.as_of,revision:r.revision,...r.payload,liabilities_complete:r.payload.liabilities_completeness?.complete===true&&r.payload.liabilities_completeness.excludes.length===0});}
 const periods=rows.filter(r=>r.kind==='period'&&(!month||r.period_start<=month+'-31'&&r.period_end>=month+'-01')).map(r=>({...r.payload,status:r.status,financial_transaction_posted:false}));
 return{connected:balances.length>0,balances,periods,financial_transaction_posted:false};
}
