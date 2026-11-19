import {createHash} from 'node:crypto';
import {z} from 'zod';
import {parse} from 'csv-parse/sync';
import DecimalBase from 'decimal.js';
import {transaction} from './db.mjs';
import {portfolioFreshness,portfolioRefreshPolicy} from './portfolio-freshness.mjs';
import {validateAccountResults,saveAccountResults} from './account-results.mjs';
import {readVerifiedPortfolioExport,verifyManifestIdentity} from './portfolio-manifest.mjs';
import {importInvestmentSnapshot,investmentSnapshotHash} from './investments.mjs';
const D=DecimalBase.clone({precision:60});
const BROKERS=['moomoo','tiger','futubull'];
const REQUIRED=['account_risk_latest.json','positions_latest.json'];
const OPTIONAL=['official_marks_history.csv','account_risk_history.csv','assets_history.csv','trades.csv','nontrade_live.csv','nontrade_tiger.csv','nontrade_futubull.csv','moomoo_fees.csv','external_flows.csv','corporate_actions.csv','fx_cache.csv'];
const hash=s=>createHash('sha256').update(s).digest('hex');
function error(code,message){throw Object.assign(new Error(message),{code});}
function sgtStamp(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value))error('INVALID_SOURCE','账户快照缺少有效SGT时点');const out=value.replace(' ','T')+'+08:00';if(!z.iso.datetime({offset:true}).safeParse(out).success)error('INVALID_SOURCE','账户时点无效');return out;}
function money(value){if((typeof value!=='number'&&typeof value!=='string')||value===''||!new D(value).isFinite())error('INVALID_SOURCE','来源金额无效');return new D(value).toFixed();}
function csvRows(text){const rows=parse(text,{columns:true,bom:true,skip_empty_lines:true,relax_column_count:false});return rows.filter(row=>!Object.entries(row).every(([key,value])=>key===value));}
export async function readPortfolioFiles(root){return readVerifiedPortfolioExport(root);}
export function inspectPortfolioFiles(files,{now=()=>Date.now(),fxQuote=null,refreshPolicy=portfolioRefreshPolicy()}={}){
 const manifest=verifyManifestIdentity(files);
 const positions=JSON.parse(files['positions_latest.json'].replace(/^\uFEFF/,'')),risk=JSON.parse(files['account_risk_latest.json'].replace(/^\uFEFF/,''));
 if(positions.schema!=='positions_latest/v1')error('INVALID_SOURCE','不支持的上游持仓格式');
 const generated=positions.generated_at;if(!z.iso.datetime({offset:true}).safeParse(generated).success)error('INVALID_SOURCE','持仓快照缺少带时区时点');
 const riskTime=sgtStamp(risk.ts);const issues=[],warnings=[];
 let account_results=null;
 if(files['account_results.json']!==undefined){let body;try{body=JSON.parse(files['account_results.json'].replace(/^\uFEFF/,''));}catch{error('INVALID_ACCOUNT_RESULTS','账户结果不是有效JSON');}account_results=validateAccountResults(body,{manifest,risk,now});}
 if(account_results?.has_unavailable_balances)issues.push('本轮存在券商余额不可用，保留上次已验证余额，不更新合计');
 if(Date.parse(manifest.exported_at)>now()+300000)issues.push('导出完成时间在未来');
 if(Date.parse(manifest.exported_at)<Date.parse(riskTime))issues.push('导出完成时间早于账户观测');
 if(positions.generated_at_epoch!==undefined&&(!Number.isFinite(positions.generated_at_epoch)||Math.abs(positions.generated_at_epoch*1000-Date.parse(generated))>1000))issues.push('来源文字时间与epoch不一致');
 if(Date.parse(generated)>now()+300000 || Date.parse(riskTime)>now()+300000)issues.push('来源时间在未来');
 const positionFreshness=portfolioFreshness(generated,manifest.exported_at,{now,policy:refreshPolicy});
 const accountFreshness=portfolioFreshness(riskTime,manifest.exported_at,{now,policy:refreshPolicy});
 if(refreshPolicy==='hourly'){
  if(positionFreshness.stale)issues.push('持仓观测超过90分钟未更新');
  if(accountFreshness.stale)issues.push('账户观测超过90分钟未更新，不能用导出时间冒充新余额');
 }else{
  if(positionFreshness.capture_stale)issues.push('导出时持仓观测已过期，不能用新导出时间掩盖旧数据');
  if(accountFreshness.capture_stale)issues.push('导出时账户观测已超过90分钟或时间不符');
  if(positionFreshness.delivery_stale||accountFreshness.delivery_stale)issues.push('已超过下一发布窗口及30分钟宽限，尚未收到更新');
 }

 if(Math.abs(Date.parse(generated)-Date.parse(riskTime))>10*60000)warnings.push('账户与持仓是不同时间的观测，分别显示，不作同刻盈亏对账');
 const confirmedEmpty=positions.complete===true&&Array.isArray(positions.stocks)&&Array.isArray(positions.options)&&positions.stocks.length===0&&positions.options.length===0&&BROKERS.every(b=>positions.coverage?.[b]?.ok===true&&positions.coverage[b].n_stk===0&&positions.coverage[b].n_opt===0);
 if(positions.stale!==false&&!confirmedEmpty)issues.push('来源标记过期或失败');
 if(positions.stale===true&&confirmedEmpty)warnings.push('正常空仓由三家成功覆盖与零持仓计数确认，未用旧stale空列表判据当作失败');
 if(positions.complete!==true || typeof positions.snapshot_id!=='string'||!positions.snapshot_id.trim())issues.push('上游缺少完整批次complete/snapshot_id证明，暂不更新资产');
 for(const broker of BROKERS){if(positions.coverage?.[broker]?.ok!==true)issues.push(broker+'尚未证明本轮成功覆盖');if(!risk.brokers?.[broker]?.broker)issues.push(broker+'账户快照缺失');}
 const accounts=[];
 for(const broker of BROKERS){const b=risk.brokers?.[broker]?.broker;if(!b)continue;
  // Source contract says these aggregate values are already normalized to USD.
  if(b.total_assets===undefined||b.cash===undefined){issues.push(broker+'缺少券商净资产或现金原报');continue;}
  const cash=money(b.cash);
  accounts.push({account_id:broker,broker,name:broker+'投资账户',valuation_currency:'USD',net_liquidation_value:money(b.total_assets),cash_balances:[{currency:'USD',amount:cash}],positions_complete:false,positions:[]});
 }
 const rows={};const conflicts=[];
 for(const name of OPTIONAL){if(files[name]!==undefined)rows[name]=csvRows(files[name]);}
 const trades=(rows['trades.csv']||[]).filter(r=>BROKERS.includes(r.broker));
 const seen=new Map();for(const r of trades){if(!r.deal_id){issues.push('存在无成交ID记录');continue;}const key=r.broker+':'+r.deal_id;const fp=hash(JSON.stringify(r));if(seen.has(key)&&seen.get(key)!==fp)conflicts.push(key);seen.set(key,fp);}
 if(conflicts.length)issues.push('稳定成交ID内容冲突，等待对账');
 const cashCandidates=(rows['external_flows.csv']||[]).filter(r=>BROKERS.includes(r.broker)&&r.type!=='已核对无流水');
 // Preserve multiplicity. Identical date/amount rows are NOT collapsed or posted.
 const occurrence=new Map();const cashReview=cashCandidates.map(r=>{const fp=hash(JSON.stringify(r));const n=(occurrence.get(fp)||0)+1;occurrence.set(fp,n);return{...r,source_row_hash:fp,occurrence:n,needs_review:true};});
 const currentStocks=Array.isArray(positions.stocks)?positions.stocks:[];
 const currentOptions=Array.isArray(positions.options)?positions.options:[];
 if(!Array.isArray(positions.stocks)||!Array.isArray(positions.options))issues.push('持仓列表格式不完整');
 const metadata={refresh_policy:refreshPolicy,next_expected_by:accountFreshness.next_expected_by,source:'portfolio-automation',generated_at:generated,risk_as_of:riskTime,export_id:manifest.export_id,exported_at:manifest.exported_at,manifest_verified:true,file_source_mtimes:Object.fromEntries(manifest.files.map(f=>[f.name,f.source_mtime])),warnings,expected_brokers:BROKERS,observed_brokers:accounts.map(a=>a.broker),
  stocks_count:currentStocks.length,options_count:currentOptions.length,trade_count:trades.length,trade_conflict_count:conflicts.length,cash_candidates_count:cashReview.length,
  cash_candidates:cashReview,aggregate_positions:[...currentStocks.map(p=>({security_id:'merged-stock:'+p.ticker,symbol:p.ticker,instrument_type:'stock',quantity:p.stock_qty==null?null:money(p.stock_qty),market_value:p.value==null?null:money(p.value),valuation_basis:'rounded_source_usd',currency:'USD'})),...currentOptions.map(p=>({security_id:'merged-option:'+p.display,symbol:p.display,instrument_type:'option',quantity:p.qty==null?null:money(p.qty),market_value:null,reported_unrealized_pnl:p.pnl==null?null:money(p.pnl),currency:'USD'}))],filename_counts:Object.fromEntries(Object.entries(rows).map(([n,v])=>[n,v.length])),
  limitations:['三家账户净资产是已折算USD的券商汇总，不再加现金和证券市值','合并持仓没有券商归属；逐券商股数和成本缺失，不能按日级市值表制造当前完整持仓','期权使用券商市值；不从报价乘合约数推算','来源成本按average_cost，不使用net_cost抵减后再累计权利金收益','IBKR已停用；不读取其残留快照、strategy.targets、场外储备或已停更official_pnl','上游归一USD不等于保留了原币，不能反推原币成交额','无稳定ID的资金流仅进确认队列；派生汇总不与逐笔收入/费用相加']};
 const signature=hash(JSON.stringify(Object.keys(files).sort().map(n=>[n,hash(files[n])])));
 const snapshot={schema_version:1,source:'portfolio-automation',snapshot_id:'account-risk:'+riskTime,revision:1,data_type:'live',as_of:riskTime,generated_at:manifest.exported_at,complete:true,accounts,
  fx_rates:fxQuote?[{currency:'USD',rate_to_cny:fxQuote.rate_to_cny,as_of:fxQuote.as_of,source:fxQuote.source}]:[]};
 return{account_results,fingerprint:signature,status:issues.length?'quarantined':'ready',issues:[...new Set(issues)],metadata,snapshot,raw_files:files};
}
export async function syncPortfolioSource(pool,root,{now=()=>Date.now(),fxQuote=null,refreshPolicy=portfolioRefreshPolicy()}={}){
 let inspected;
 try{inspected=inspectPortfolioFiles(await readPortfolioFiles(root),{now,fxQuote,refreshPolicy});}
 catch(e){await pool.query("INSERT INTO cfo_portfolio_sync_attempts(status,code) VALUES('failed',$1)",[e.code||'INVALID_SOURCE']).catch(()=>{});throw e;}
 const saved=await transaction(pool,async c=>{
  await c.query('SELECT pg_advisory_xact_lock(20261104)');
  const old=(await c.query('SELECT id FROM cfo_portfolio_ingests WHERE fingerprint=$1',[inspected.fingerprint])).rows[0];if(old){await c.query('UPDATE cfo_portfolio_ingests SET status=$2,issues=$3,metadata=$4 WHERE id=$1',[old.id,inspected.status,JSON.stringify(inspected.issues),JSON.stringify(inspected.metadata)]);return{id:old.id,reused:true};}
  const row=(await c.query('INSERT INTO cfo_portfolio_ingests(fingerprint,status,generated_at,issues,metadata,raw_files) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[inspected.fingerprint,inspected.status,inspected.metadata.generated_at,JSON.stringify(inspected.issues),JSON.stringify(inspected.metadata),JSON.stringify(inspected.raw_files)])).rows[0];return{id:row.id,reused:false};
 });
 let accepted=null;
 if(inspected.status==='ready'){
  try{
   if(inspected.account_results)await saveAccountResults(pool,inspected.account_results);
   const latest=(await pool.query('SELECT revision,payload_hash FROM cfo_investment_snapshots WHERE source=$1 AND snapshot_key=$2 ORDER BY revision DESC LIMIT 1',[inspected.snapshot.source,inspected.snapshot.snapshot_id])).rows[0];
   if(latest){inspected.snapshot.revision=latest.revision;if(investmentSnapshotHash(inspected.snapshot)!==latest.payload_hash)inspected.snapshot.revision++;}
   accepted=await importInvestmentSnapshot(pool,inspected.snapshot,{now});
  }
  catch(e){if(!['SOURCE_CONFLICT','INCOMPLETE_COVERAGE'].includes(e.code)){await pool.query("UPDATE cfo_portfolio_ingests SET status='quarantined',issues=$2 WHERE id=$1",[saved.id,JSON.stringify(['账户结果验证或保存失败，未生成投资分录'])]).catch(()=>{});await pool.query("INSERT INTO cfo_portfolio_sync_attempts(status,code) VALUES('failed',$1)",[e.code||'INVALID_SOURCE']).catch(()=>{});throw e;}inspected.status='quarantined';inspected.issues.push(e.message);await pool.query('UPDATE cfo_portfolio_ingests SET status=$2,issues=$3 WHERE id=$1',[saved.id,inspected.status,JSON.stringify(inspected.issues)]);}
 }
 await pool.query('INSERT INTO cfo_portfolio_sync_attempts(status,code,export_id) VALUES($1,$2,$3)',[inspected.status,inspected.status==='ready'?'VERIFIED':'NEEDS_REVIEW',inspected.metadata.export_id]);
 return{...saved,verified_files:inspected.raw_files,status:inspected.status,issues:inspected.issues,accepted_snapshot:accepted,financial_transaction_posted:false,
  summary:{refresh_policy:inspected.metadata.refresh_policy,next_expected_by:inspected.metadata.next_expected_by,unavailable_balance_count:inspected.account_results?.rows.filter(r=>r.kind==='balance'&&r.status==='unavailable').length||0,account_results_count:inspected.account_results?.rows.length||0,account_results_saved:!!inspected.account_results&&inspected.status==='ready',manifest_verified:true,export_id:inspected.metadata.export_id,account_as_of:inspected.metadata.risk_as_of,positions_as_of:inspected.metadata.generated_at,accounts:inspected.metadata.observed_brokers,stocks:inspected.metadata.stocks_count,options:inspected.metadata.options_count,cash_candidates:inspected.metadata.cash_candidates_count}};
}
export async function portfolioSourceStatus(pool,{now=()=>Date.now()}={}){
 const attempt=(await pool.query('SELECT at,status,code,export_id FROM cfo_portfolio_sync_attempts ORDER BY id DESC LIMIT 1')).rows[0]||null;
 const row=(await pool.query("SELECT id,status,generated_at,issues,metadata,imported_at FROM cfo_portfolio_ingests WHERE ($1::text IS NULL OR metadata->>'export_id'=$1) ORDER BY imported_at DESC LIMIT 1",[attempt?.export_id||null])).rows[0];
 if(!row)return{connected:false,last_attempt:attempt};
 const pf=portfolioFreshness(row.generated_at,row.metadata.exported_at,{now}),af=portfolioFreshness(row.metadata.risk_as_of,row.metadata.exported_at,{now});
 const positions_stale=pf.stale,account_stale=af.stale;
 return{connected:true,...row,refresh_policy:af.policy,next_expected_by:af.next_expected_by,last_attempt:attempt,stale:positions_stale||account_stale,positions_stale,account_stale,metadata:{...row.metadata,cash_candidates:undefined}};
}
