// Only independently verified opening facts and explicitly reconciled periods
// may enter the ledger. Current NAV changes alone never imply income.
import {createHash} from 'node:crypto';
import {parse} from 'csv-parse/sync';
import {verifyManifestIdentity} from './portfolio-manifest.mjs';
import D from 'decimal.js';
import {transaction} from './db.mjs';
import {START,validDate,cents,baseCents,yuan} from './money.mjs';
import {accountResultKey,validateAccountResults} from './account-results.mjs';
const brokers=['moomoo','tiger','futubull'],names={moomoo:'moomoo',tiger:'Tiger',futubull:'富途'};
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const money=x=>new D(x).toFixed(2);
const day=x=>new Date(Date.parse(x)+8*3600000).toISOString().slice(0,10);
const reason=(code,message)=>({code,message});
function number(x){if(typeof x!=='string'||!/^[-+]?\d+(\.\d+)?$/.test(x))throw new Error('历史金额格式无效');const n=new D(x);if(!n.isFinite()||n.abs().gt('90000000000'))throw new Error('历史金额超限');return n;}
export function parseBrokerHistory(text){
 let rows;try{rows=parse(text,{columns:true,skip_empty_lines:true,bom:true,max_record_size:65536});}catch{return{rows:[],headers:[],issue:'HISTORY_PARSE_FAILED'};}
 const headers=rows.length?Object.keys(rows[0]):[];
 // Recognized column names describe a layout, never infer an amount from a
 // similarly named market-value or strategy field.
 const time=['ts','timestamp','dt','datetime','date'].find(k=>headers.includes(k));
 const field=['field','key','metric'].find(k=>headers.includes(k));const section=['section','source','group'].find(k=>headers.includes(k));
 const value=['value','val'].find(k=>headers.includes(k));
 if(!time||!headers.includes('broker')||(!headers.includes('total_assets')&&!(field&&value)))return{rows:[],headers,issue:'HISTORY_SCHEMA_UNSUPPORTED'};
 const groups=new Map();
 for(const r of rows){if(!brokers.includes(r.broker))continue;if(field&&section&&r[section]&&r[section]!=='broker'&&!String(r[field]).startsWith('broker.'))continue;const raw=r[time];if(!/^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:[+-]\d{2}:\d{2}|Z)?)?$/.test(raw||''))continue;
  const normalized=raw.length===10?raw+'T23:59:59+08:00':raw.replace(' ','T')+(/(?:Z|[+-]\d{2}:\d{2})$/.test(raw)?'':'+08:00');
  if(!Number.isFinite(Date.parse(normalized)))continue;const key=r.broker+':'+normalized,entry=groups.get(key)||{broker:r.broker,as_of:normalized,values:{},conflict:false};
  const assign=(key,v)=>{if(!['total_assets','cash','long_mv','short_mv'].includes(key)||v==null||v==='')return;if(entry.values[key]!==undefined&&entry.values[key]!==v)entry.conflict=true;entry.values[key]=v;};
  if(field&&value)assign(r[field].replace(/^broker\./,''),r[value]);else for(const k of ['total_assets','cash','long_mv','short_mv'])assign(k,r[k]);groups.set(key,entry);
 }
 const result=[];for(const r of groups.values()){if(r.conflict||r.values.total_assets===undefined)continue;try{const values={total_assets:number(r.values.total_assets).toFixed()};for(const k of ['cash','long_mv','short_mv'])if(r.values[k]!==undefined)try{values[k]=number(r.values[k]).toFixed();}catch{}result.push({...r,values});}catch{}}
 return{rows:result,headers,section_names:section?[...new Set(rows.map(r=>r[section]).filter(x=>/^[a-zA-Z_.]{1,60}$/.test(x)))].sort():[],field_names:field?[...new Set(rows.map(r=>r[field]).filter(x=>/^[a-zA-Z_.]{1,60}$/.test(x)))].sort():[],issue:result.length?null:'HISTORY_NO_VALID_BALANCES'};
}
export function historyAt(history,date){
 const found=[];for(const broker of brokers){const row=history.rows.filter(r=>r.broker===broker&&day(r.as_of)===date).sort((a,b)=>Date.parse(b.as_of)-Date.parse(a.as_of))[0];if(row)found.push(row);}return found;
}
export function periodClosingHistory(history,p,generatedAt){
 const observation=p.closing_as_of||p.period_end,limit=new Date(Date.parse(p.period_end)+86400000).toISOString().slice(0,10);
 if(validDate(observation)){if(observation<p.period_start||observation>limit||observation>day(generatedAt))return[];return historyAt(history,observation);}
 if(typeof observation!=='string'||!/(?:Z|[+-]\d{2}:\d{2})$/.test(observation)||!Number.isFinite(Date.parse(observation))||Date.parse(observation)>Date.parse(generatedAt))return[];
 const date=day(observation);if(date<p.period_start||date>limit)return[];
 return brokers.map(b=>history.rows.filter(r=>r.broker===b&&day(r.as_of)===date&&Date.parse(r.as_of)<=Date.parse(observation)).sort((a,b)=>Date.parse(b.as_of)-Date.parse(a.as_of))[0]).filter(Boolean);
}
function targets(row){
 const v=row.values,n=number(v.total_assets);let decomposable=false,a=n,l=new D(0);
 if(['cash','long_mv','short_mv'].every(k=>v[k]!==undefined)){const cash=number(v.cash),long=number(v.long_mv),short=number(v.short_mv);if(long.gte(0)&&short.lte(0)&&cash.plus(long).plus(short).minus(n).abs().lte('0.01')){a=D.max(cash,0).plus(long);l=D.max(cash.negated(),0).plus(short.abs());decomposable=true;}}
 const aa=money(a),ll=money(l),nn=money(n),rounding=new D(nn).minus(aa).plus(ll).toFixed(2);
 return{asset:aa,liability:ll,rounding,net:nn,decomposable};
}
export async function fetchHistoricalBrokerFx(date,{fetcher=fetch}={}){
 if(!validDate(date))throw new Error('历史汇率日期无效');const url='https://api.frankfurter.dev/v1/'+date+'?base=USD&symbols=CNY';const res=await fetcher(url,{signal:AbortSignal.timeout(10000),redirect:'error'});if(!res.ok)throw new Error('历史汇率暂不可用');const d=await res.json();
 if(d.base!=='USD'||d.amount!==1||!validDate(d.date)||d.date>date||(Date.parse(date)-Date.parse(d.date))/86400000>7||typeof d.rates?.CNY!=='number'||!Number.isFinite(d.rates.CNY)||d.rates.CNY<=0)throw new Error('历史汇率来源或日期无效');return{date:d.date,rate: new D(d.rates.CNY).toFixed(12),source:'ECB / Frankfurter '+d.date+'（USD兑CNY）',url};
}
async function account(c,broker,role){
 const old=(await c.query('SELECT a.* FROM cfo_broker_accounts b JOIN cfo_accounts a ON a.id=b.account_id WHERE b.broker=$1 AND b.role=$2',[broker,role])).rows[0];if(old)return old;
 const name=names[broker]+({asset:' · 券商投资资产',liability:' · 券商已报告负债',rounding:' · 券商分位尾差'}[role]);
 const collision=(await c.query('SELECT id FROM cfo_accounts WHERE name=$1 AND currency=\'USD\'',[name])).rows[0];if(collision)throw new Error('已有同名券商账户待核对，未自动重复创建');
 const a=(await c.query('INSERT INTO cfo_accounts(name,kind,account_group,currency,is_cash) VALUES($1,$2,$3,\'USD\',false) RETURNING *',[name,role==='liability'?'other_liability':'investment',role==='liability'?'liability':'asset'])).rows[0];await c.query('INSERT INTO cfo_broker_accounts(broker,role,account_id) VALUES($1,$2,$3)',[broker,role,a.id]);return a;
}
async function system(c,key){const a=(await c.query('SELECT * FROM cfo_accounts WHERE system_key=$1',[key])).rows[0];if(!a)throw new Error('缺少系统科目');return a;}
async function write(c,{key,sourceHash,revision,scope,date,kind,payload,lines,documentId,exportId,details}){
 const description=payload.description;const event=(await c.query("INSERT INTO cfo_events(document_id,source_ref,request_key,payload,status) VALUES($1,$2,$2,$3,'posted') RETURNING *",[documentId,'broker:'+key+':'+sourceHash,JSON.stringify({...payload,managed_investment:true,source_export_id:exportId})])).rows[0];
 await c.query('INSERT INTO cfo_event_sources(document_id,source_ref,event_id) VALUES($1,$2,$3)',[documentId,key,event.id]);
 const j=(await c.query('INSERT INTO cfo_entries(event_id,entry_date,description,kind,cash_flow_bucket) VALUES($1,$2,$3,$4,$5) RETURNING id',[event.id,date,description,kind,payload.cash_flow_bucket||(kind==='opening'?'opening':'noncash')])).rows[0];
 for(const l of lines)await c.query('INSERT INTO cfo_lines(entry_id,account_id,native_cents,cny_cents,fx_rate,fx_source) VALUES($1,$2,$3,$4,$5,$6)',[j.id,l.account.id,l.native,l.base,l.fx?.rate||'1',l.fx?.source||'CNY']);
 await c.query('INSERT INTO cfo_broker_postings(source_key,source_hash,source_revision,account_scope,kind,through_date,event_id,source_export_id,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(source_key) DO UPDATE SET source_hash=excluded.source_hash,source_revision=excluded.source_revision,event_id=excluded.event_id,source_export_id=excluded.source_export_id,details=excluded.details',[key,sourceHash,revision,JSON.stringify(scope),kind,date,event.id,exportId,JSON.stringify(details)]);
 await c.query("INSERT INTO cfo_audit(action,entity_id,details) VALUES('broker_result_posted',$1,$2)",[event.id,JSON.stringify({source_key:key,export_id:exportId,kind})]);return event;
}
async function current(c,a,date){return(await c.query('SELECT COALESCE(sum(l.native_cents),0)::text AS native,COALESCE(sum(l.cny_cents),0)::text AS base FROM cfo_lines l JOIN cfo_entries j ON j.id=l.entry_id WHERE l.account_id=$1 AND j.entry_date<=$2',[a.id,date])).rows[0];}
function targetLine(account,amount,fx,old={native:'0',base:'0'}){const signed=account.account_group==='liability'?-cents(amount):cents(amount,true);return{account,native:String(BigInt(signed)-BigInt(old.native)),base:String(BigInt(baseCents(signed,fx.rate,'USD'))-BigInt(old.base)),fx};}
export async function reconcileBrokerLedger(pool,{files,documentId,fxForDate=fetchHistoricalBrokerFx,now=()=>Date.now()}={}){
 if(!files?.['account_results.json']||!documentId)return{status:'pending',reasons:[reason('RESULTS_REQUIRED','尚无已验证账户结果或来源归档')],posted_count:0};
 const manifest=verifyManifestIdentity(files),risk=JSON.parse(files['account_risk_latest.json']);
 const validated=validateAccountResults(JSON.parse(files['account_results.json']),{manifest,risk,now});
 if(validated.has_unavailable_balances)return{status:'pending',reasons:[reason('BALANCE_UNAVAILABLE','券商余额不完整，保留已有账本')],posted_count:0};
 const history=parseBrokerHistory(files['account_risk_history.csv']||''),openingRows=historyAt(history,'2026-10-31');
 const fxCache=new Map(),fx=async date=>{if(!fxCache.has(date))fxCache.set(date,await fxForDate(date));return fxCache.get(date);};
 const summary={status:'ready',posted_count:0,opening_count:0,period_count:0,reasons:[],history_headers:history.headers,history_fields:history.field_names||[],history_sections:history.section_names||[],export_id:validated.export_id};
 let openingFx;try{const oldFx=(await pool.query("SELECT details->'fx' AS fx FROM cfo_broker_postings WHERE kind='opening' ORDER BY created_at LIMIT 1")).rows[0]?.fx;openingFx=oldFx||await fx('2026-10-31');}catch{summary.reasons.push(reason('OPENING_FX_UNAVAILABLE','开账日历史汇率暂不可用，未使用今日汇率替代'));}
 const periods=validated.rows.filter(r=>r.kind==='period'&&r.period_start>=START).sort((a,b)=>a.period_start.localeCompare(b.period_start));
 for(const period of periods)if(period.payload.auto_postable===true&&!(await pool.query('SELECT 1 FROM cfo_broker_postings WHERE source_key=$1',['period:'+accountResultKey(period.payload)])).rowCount)try{await fx(period.period_end);}catch{summary.reasons.push(reason('PERIOD_FX_UNAVAILABLE','已核对期间的历史汇率暂不可用'));}
 await transaction(pool,async c=>{
  await c.query('SELECT pg_advisory_xact_lock(20261102)');
  const suspect=(await c.query("SELECT a.id FROM cfo_accounts a WHERE a.system_key IS NULL AND a.kind='investment' AND NOT EXISTS(SELECT 1 FROM cfo_broker_accounts b WHERE b.account_id=a.id) AND NOT EXISTS(SELECT 1 FROM cfo_broker_exclusions x WHERE x.account_id=a.id) AND EXISTS(SELECT 1 FROM cfo_lines l JOIN cfo_entries j ON j.id=l.entry_id WHERE l.account_id=a.id AND (a.currency='USD' OR j.cash_flow_bucket='opening')) LIMIT 1")).rows;
  if(suspect.length){summary.reasons.push(reason('EXISTING_INVESTMENT_MAPPING_REQUIRED','已有手工投资期初或美元投资账目需核对归属，未重复叠加券商资产'));return;}
  // A user deletion/reversal is a stop instruction. Never recreate it on sync.
  const removed=(await c.query("SELECT id FROM cfo_events WHERE payload->>'managed_investment'='true' AND (deleted_at IS NOT NULL OR status<>'posted') LIMIT 1")).rows;
  if(removed.length){summary.reasons.push(reason('USER_CORRECTION_PAUSED','券商自动分录已被删除或冲销，自动入账暂停；请先恢复记录'));return;}
  for(const broker of brokers){
   const row=openingRows.find(r=>r.broker===broker),key='opening:'+broker+':'+START,old=(await c.query('SELECT * FROM cfo_broker_postings WHERE source_key=$1',[key])).rows[0];
   if(!row){summary.reasons.push(reason(history.issue||'OPENING_HISTORY_MISSING',names[broker]+'缺少10月31日有效历史快照，期初未填0'));continue;}
   const t=targets(row),sourceHash=hash({as_of:new Date(Date.parse(row.as_of)).toISOString(),values:row.values});
   if(old){summary.opening_count++;if(old.source_hash!==sourceHash)summary.reasons.push(reason('OPENING_SOURCE_REVISED','历史期初来源发生变化，保留原分录，需核实修订'));continue;}
   if(!openingFx)continue;
   const entries=[];for(const role of ['asset','liability','rounding']){const a=await account(c,broker,role);entries.push(targetLine(a,t[role],openingFx));await c.query('UPDATE cfo_accounts SET opening_confirmed=$2 WHERE id=$1',[a.id,role==='liability'?t.decomposable:true]);}
   const targetNet=BigInt(baseCents(cents(t.net,true),openingFx.rate,'USD')),rawTotal=entries.reduce((n,l)=>n+BigInt(l.base),0n);entries[2].base=String(BigInt(entries[2].base)+targetNet-rawTotal);const total=targetNet,equity=await system(c,'equity.opening');entries.push({account:equity,native:String(-total),base:String(-total)});
   await write(c,{key,sourceHash,revision:0,scope:[broker],date:START,kind:'opening',payload:{kind:'opening',date:START,currency:'USD',amount:t.net,account_id:entries[0].account.id,fx_rate:openingFx.rate,fx_source:openingFx.source,description:names[broker]+'券商期初（10月31日最后有效快照）'},lines:entries,documentId,exportId:validated.export_id,details:{as_of:row.as_of,decomposable:t.decomposable,net_assets:t.net,fx:openingFx,source_fields:row.values}});summary.posted_count++;summary.opening_count++;
  }
  for(const r of periods){if(summary.reasons.some(x=>['OPENING_SOURCE_REVISED','PERIOD_REVISION_REVIEW'].includes(x.code)))break;const p=r.payload,key='period:'+accountResultKey(p),old=(await c.query('SELECT * FROM cfo_broker_postings WHERE source_key=$1',[key])).rows[0];
   if(old){if(old.source_hash!==r.payload_hash)summary.reasons.push(reason('PERIOD_REVISION_REVIEW','已入账期间发生修订，未覆盖原分录'));else summary.period_count++;continue;}
   if(p.period_status==='in_progress'){summary.reasons.push(reason('CURRENT_PERIOD_REFERENCE_ONLY','本月进行中结果已接收，仅作参考；资金及证券转仓未核对前不计正式利润'));continue;}
   if(p.auto_postable!==true){summary.reasons.push(reason('PNL_NOT_RECONCILED','期间损益尚未完成资金及股票转仓核对，未当作收入'));continue;}
   if(!new D(p.net_securities_in_fv).isZero()){summary.reasons.push(reason('SECURITIES_TRANSFER_MAPPING_REQUIRED','期间有实物证券转仓，需要明确对方资产归属'));continue;}
   if(!fxCache.has(r.period_end)){summary.reasons.push(reason('PERIOD_FX_UNAVAILABLE','缺少期间历史汇率'));continue;}
   const through=periodClosingHistory(history,p,validated.generated_at).filter(x=>p.account_scope.includes(x.broker));
   if(through.length!==p.account_scope.length||new D(through.reduce((sum,x)=>sum.plus(x.values.total_assets),new D(0))).minus(p.closing_net_assets).abs().gt('0.01')){summary.reasons.push(reason('PERIOD_CLOSING_MISMATCH','期间末快照与已核对损益净值不符'));continue;}
   let gap=false;for(const broker of p.account_scope){const last=(await c.query("SELECT max(through_date)::text AS through FROM cfo_broker_postings WHERE kind='investment_settlement' AND account_scope @> $1::jsonb",[JSON.stringify([broker])])).rows[0].through;const expected=last?new Date(Date.parse(last)+86400000).toISOString().slice(0,10):START;if(r.period_start!==expected)gap=true;}if(gap){summary.reasons.push(reason('PERIOD_GAP','已核对期间之间有缺口，未跨期拼接'));continue;}
   const startBefore=new Date(Date.parse(r.period_start)-86400000).toISOString().slice(0,10),openingDate=r.period_start===START?START:startBefore,allAccounts=[];let openingNet=new D(0),missing=false;
   for(const broker of p.account_scope){if(!(await c.query('SELECT 1 FROM cfo_broker_postings WHERE source_key=$1',['opening:'+broker+':'+START])).rowCount){missing=true;continue;}for(const role of ['asset','liability','rounding']){const a=await account(c,broker,role);allAccounts.push({broker,role,account:a});
     const q=r.period_start===START?(await c.query("SELECT COALESCE(sum(l.native_cents),0)::text AS native FROM cfo_lines l JOIN cfo_entries j ON j.id=l.entry_id WHERE l.account_id=$1 AND j.entry_date=$2 AND j.cash_flow_bucket='opening'",[a.id,START])).rows[0]:await current(c,a,openingDate);openingNet=openingNet.plus(q.native);}}
   if(missing||openingNet.div(100).minus(p.opening_net_assets).abs().gt('0.01')){summary.reasons.push(reason('PERIOD_OPENING_MISMATCH','期间期初与正式账本不衔接，未跳过缺失期间'));continue;}
   const manualPnl=(await c.query("SELECT 1 FROM cfo_events e LEFT JOIN cfo_accounts a ON a.id::text=e.payload->>'account_id' WHERE e.status='posted' AND e.deleted_at IS NULL AND COALESCE(e.payload->>'managed_investment','false')<>'true' AND COALESCE(e.payload->>'currency',a.currency)='USD' AND e.payload->>'category' IN ('income.investment_total','expense.investment_total','income.investment_realized','expense.investment_realized','expense.interest','expense.financing_fees') AND e.payload->>'date' BETWEEN $1 AND $2 LIMIT 1",[r.period_start,r.period_end])).rows;if(manualPnl.length){summary.reasons.push(reason('MANUAL_PNL_OVERLAP','期间已有手工美元投资损益或融资费用，未自动重复入账'));continue;}
   const intervening=(await c.query("SELECT 1 FROM cfo_lines l JOIN cfo_entries j ON j.id=l.entry_id WHERE l.account_id=ANY($1::uuid[]) AND j.entry_date BETWEEN $2 AND $3 AND j.cash_flow_bucket<>'opening' LIMIT 1",[allAccounts.map(a=>a.account.id),r.period_start,r.period_end])).rows;
   if(intervening.length){summary.reasons.push(reason('PERIOD_EXISTING_ENTRIES','期间已有券商分录，需核对重叠，未重复入账'));continue;}
   const quote=fxCache.get(r.period_end),lines=[];for(const a of allAccounts){const t=targets(through.find(x=>x.broker===a.broker));lines.push(targetLine(a.account,t[a.role],quote,await current(c,a.account,r.period_end)));}
   const funding=cents(money(p.net_cash_in),true),pnl=cents(money(p.total_pnl),true);
   // Funding is a personal internal transfer, never a second salary or income.
   const cash=(await c.query("INSERT INTO cfo_accounts(name,kind,account_group,currency,is_cash,summary_kind) VALUES('综合现金 · USD','cash','asset','USD',true,'cash') ON CONFLICT(currency,summary_kind) WHERE summary_kind IS NOT NULL DO UPDATE SET name=cfo_accounts.name RETURNING *")).rows[0];
   lines.push({account:cash,native:String(-funding),base:String(-baseCents(funding,quote.rate,'USD')),fx:quote});
   const bridge=await system(c,'equity.investment_bridge'),assetChange=lines.reduce((n,l)=>n+BigInt(l.base),0n),profitBase=BigInt(baseCents(pnl,quote.rate,'USD')),fxDifference=assetChange-profitBase;
   lines.push({account:bridge,native:String(-assetChange),base:String(-assetChange)});
   const common={revision:r.revision,scope:p.account_scope,date:r.period_end,documentId,exportId:validated.export_id};
   const sourceDetails={period_start:r.period_start,period_end:r.period_end,fx:quote,result:p};
   await write(c,{...common,key,sourceHash:r.payload_hash,kind:'investment_settlement',payload:{kind:'investment_settlement',date:r.period_end,currency:'USD',amount:'0.00',account_id:allAccounts[0].account.id,fx_rate:quote.rate,fx_source:quote.source,cash_flow_bucket:funding?'investing':'noncash',description:'已核对券商期末资产负债与本人净转入'},lines,details:sourceDetails});summary.posted_count++;
   for(const part of [{name:'profit',value:profitBase,positive:'income.investment_total',negative:'expense.investment_total',description:'已核对券商期间总损益（不重复扣除内含利息）'},{name:'fx',value:fxDifference,positive:'income.fx',negative:'expense.fx',description:'券商历史汇率及分位折算差额'}]){
    if(part.value===0n)continue;const cat=part.value>0n?part.positive:part.negative,nominal=await system(c,cat),group=part.value>0n?'income':'expense';
    await write(c,{...common,key:key+':'+part.name,sourceHash:r.payload_hash,kind:'investment_result',payload:{kind:group,date:r.period_end,currency:'CNY',amount:yuan(part.value<0n?-part.value:part.value),account_id:bridge.id,category:cat,description:part.description,source_amount_usd:part.name==='profit'?p.total_pnl:null},lines:[{account:bridge,native:String(part.value),base:String(part.value)},{account:nominal,native:String(-part.value),base:String(-part.value)}],details:{...sourceDetails,parent_source_key:key}});summary.posted_count++;
   }
   summary.period_count++;

  }
 });
 if(!periods.length)summary.reasons.push(reason('NO_CURRENT_PERIOD_RESULTS','尚无11月起已核对的期间损益，不能用净值变化替代收益'));
 summary.status=summary.reasons.length?'pending':'ready';await pool.query('INSERT INTO cfo_broker_bridge_runs(status,summary) VALUES($1,$2)',[summary.status,JSON.stringify(summary)]);return summary;
}
export async function brokerLedgerStatus(pool){
 const run=(await pool.query('SELECT status,summary,at FROM cfo_broker_bridge_runs ORDER BY id DESC LIMIT 1')).rows[0];
 const accounts=(await pool.query('SELECT b.broker,b.role,a.id,a.name,a.opening_confirmed FROM cfo_broker_accounts b JOIN cfo_accounts a ON a.id=b.account_id ORDER BY b.broker,b.role')).rows;
 const unmapped_accounts=(await pool.query("SELECT a.id,a.name,a.currency FROM cfo_accounts a WHERE a.kind='investment' AND a.system_key IS NULL AND NOT EXISTS(SELECT 1 FROM cfo_broker_accounts b WHERE b.account_id=a.id) AND NOT EXISTS(SELECT 1 FROM cfo_broker_exclusions x WHERE x.account_id=a.id) AND EXISTS(SELECT 1 FROM cfo_lines l JOIN cfo_entries j ON j.id=l.entry_id WHERE l.account_id=a.id AND (a.currency='USD' OR j.cash_flow_bucket='opening'))")).rows;
 const postings=(await pool.query("SELECT p.source_key,p.kind,p.through_date,p.account_scope,p.event_id,p.source_revision,p.source_export_id,(e.status='posted' AND e.deleted_at IS NULL) AS active FROM cfo_broker_postings p JOIN cfo_events e ON e.id=p.event_id ORDER BY p.through_date,p.source_key")).rows;
 return{status:run?.status||'not_started',last_checked:run?.at||null,summary:run?{...run.summary,opening_count:postings.filter(p=>p.kind==='opening'&&p.active).length,period_count:postings.filter(p=>p.kind==='investment_settlement'&&p.active).length}:null,accounts,unmapped_accounts,postings,note:'仅已验证期初及已核对期间生成分录；当前净值与账面差额仍需资金及转仓核对。'};
}

export async function excludeNonBrokerAccounts(pool,ids){
 if(!Array.isArray(ids)||!ids.length||ids.length>250||ids.some(id=>typeof id!=='string'||!/^[a-f0-9-]{36}$/i.test(id)))throw new Error('请选择已有投资归类');
 return transaction(pool,async c=>{await c.query('SELECT pg_advisory_xact_lock(20261102)');for(const id of new Set(ids)){const a=(await c.query("SELECT a.id FROM cfo_accounts a WHERE a.id=$1 AND a.kind='investment' AND a.system_key IS NULL AND NOT EXISTS(SELECT 1 FROM cfo_broker_accounts b WHERE b.account_id=a.id)",[id])).rows[0];if(!a)throw new Error('该归类不能标为券商范围外');await c.query('INSERT INTO cfo_broker_exclusions(account_id) VALUES($1) ON CONFLICT DO NOTHING',[id]);await c.query("INSERT INTO cfo_audit(action,entity_id,details) VALUES('non_broker_investment_confirmed',$1,$2)",[id,JSON.stringify({brokers_excluded:brokers})]);}return{count:new Set(ids).size,financial_transaction_posted:false};});
}
