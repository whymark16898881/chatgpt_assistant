import {portfolioFreshness} from './portfolio-freshness.mjs';
import {z} from 'zod';
import DecimalBase from 'decimal.js';
const Decimal=DecimalBase.clone({precision:60,rounding:DecimalBase.ROUND_HALF_UP});
import {createHash} from 'node:crypto';
import {transaction} from './db.mjs';
import {CURRENCIES} from './money.mjs';

const decimal=z.string().regex(/^-?\d{1,18}(\.\d{1,12})?$/);
const positive=decimal.refine(s=>new Decimal(s).gt(0));
const id=z.string().trim().min(1).max(150);
const stamp=z.iso.datetime({offset:true});
const currency=z.enum(CURRENCIES);
const position=z.object({security_id:id,symbol:id,instrument_type:z.enum(['stock','etf','fund','bond','option','other']),currency,
 quantity:decimal.optional(),market_value:decimal.optional(),cost_value:decimal.optional(),reported_unrealized_pnl:decimal.optional(),price_as_of:stamp.optional()}).strict();
const account=z.object({account_id:id,broker:id,name:z.string().min(1).max(150),valuation_currency:currency,
 net_liquidation_value:decimal.optional(),cash_balances:z.array(z.object({currency,amount:decimal}).strict()).max(20),
 positions_complete:z.boolean().default(true),positions:z.array(position).max(10000)}).strict();
export const investmentSnapshotSchema=z.object({schema_version:z.literal(1),source:id,snapshot_id:id,revision:z.number().int().min(1),
 data_type:z.enum(['live','test']),as_of:stamp,generated_at:stamp,complete:z.literal(true),accounts:z.array(account).min(1).max(100),
 fx_rates:z.array(z.object({currency,rate_to_cny:positive,as_of:stamp,source:id}).strict()).max(20).default([])}).strict();
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));return value;}
export function investmentSnapshotHash(input){return createHash('sha256').update(JSON.stringify(canonical(investmentSnapshotSchema.parse(input)))).digest('hex');}
function fail(code,message){throw Object.assign(new Error(message),{code});}
function unique(items,key,label){const keys=items.map(key);if(new Set(keys).size!==keys.length)fail('INVALID_SNAPSHOT',label+'存在重复键');}
export async function importInvestmentSnapshot(pool,input,{allowTest=false,now=()=>Date.now()}={}){
 const payload=investmentSnapshotSchema.parse(input);
 if(payload.data_type==='test'&&!allowTest)fail('TEST_DATA_REJECTED','测试快照禁止导入真实环境');
 if(Date.parse(payload.as_of)>now()+300000 || Date.parse(payload.generated_at)>now()+300000)fail('INVALID_SNAPSHOT','快照时间不能在未来');
 if(Date.parse(payload.generated_at)<Date.parse(payload.as_of))fail('INVALID_SNAPSHOT','生成时间不能早于快照时间');
 unique(payload.accounts,a=>a.account_id,'账户');unique(payload.fx_rates,f=>f.currency,'汇率');
 for(const a of payload.accounts){unique(a.cash_balances,c=>c.currency,'现金币种');unique(a.positions,p=>p.security_id,'证券');if(a.positions_complete&&a.positions.some(p=>p.quantity===undefined||p.market_value===undefined))fail('INVALID_SNAPSHOT','完整持仓需数量和市值；不可填0代替缺失');}
 for(const f of payload.fx_rates){if(f.currency==='CNY'&&!new Decimal(f.rate_to_cny).eq(1))fail('INVALID_SNAPSHOT','人民币汇率必须为1');if(Date.parse(f.as_of)>Date.parse(payload.generated_at))fail('INVALID_SNAPSHOT','汇率时间不能晚于快照生成时间');}
 const hash=investmentSnapshotHash(payload);
 return transaction(pool,async c=>{
  await c.query('SELECT pg_advisory_xact_lock(20261103)');
  if(payload.data_type==='test'){const db=(await c.query('SELECT current_database() AS name')).rows[0].name;if(!db.endsWith('_test'))fail('TEST_DATA_REJECTED','测试快照只允许进入专用_test数据库');}
  const old=(await c.query('SELECT * FROM cfo_investment_snapshots WHERE source=$1 AND snapshot_key=$2 AND revision=$3',[payload.source,payload.snapshot_id,payload.revision])).rows[0];
  if(old){if(old.payload_hash!==hash)fail('SOURCE_CONFLICT','同一来源快照及修订号内容变化，请来源提供新修订号');return{id:old.id,reused:true,financial_transaction_posted:false};}
  const latest=(await c.query('SELECT * FROM cfo_investment_snapshots WHERE source=$1 AND data_type=$2 ORDER BY as_of DESC,revision DESC,imported_at DESC LIMIT 1',[payload.source,payload.data_type])).rows[0];
  const isNewer=!latest || Date.parse(payload.as_of)>Date.parse(latest.as_of) || (Date.parse(payload.as_of)===Date.parse(latest.as_of)&&payload.revision>latest.revision);
  if(latest && Date.parse(payload.as_of)===Date.parse(latest.as_of) && payload.snapshot_id!==latest.snapshot_key)fail('SOURCE_CONFLICT','同一来源同一时点应修订原快照，不创建竞争快照');
  if(isNewer && latest){for(const a of payload.accounts){const prior=latest.payload.accounts.find(x=>x.account_id===a.account_id);if(prior?.positions_complete && !a.positions_complete)fail('INCOMPLETE_COVERAGE','持仓完整性下降，保留原完整快照');}const keys=new Set(payload.accounts.map(a=>a.account_id));if(latest.payload.accounts.some(a=>!keys.has(a.account_id)))fail('INCOMPLETE_COVERAGE','新快照缺少已有账户，保留旧数据；真实销户需单独确认');}
  const row=(await c.query('INSERT INTO cfo_investment_snapshots(source,snapshot_key,revision,as_of,data_type,payload_hash,payload) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',[payload.source,payload.snapshot_id,payload.revision,payload.as_of,payload.data_type,hash,JSON.stringify(payload)])).rows[0];
  await c.query("INSERT INTO cfo_audit(action,entity_id,details) VALUES('investment_snapshot_imported',$1,$2)",[row.id,JSON.stringify({source:payload.source,snapshot_id:payload.snapshot_id,revision:payload.revision,is_latest:isNewer,data_type:payload.data_type})]);
  return{id:row.id,reused:false,is_latest:isNewer,financial_transaction_posted:false};
 });
}
export async function investmentOverview(pool,{now=()=>Date.now(),staleHours=24}={}){
 const rows=(await pool.query("SELECT DISTINCT ON(source) * FROM cfo_investment_snapshots WHERE data_type='live' ORDER BY source,as_of DESC,revision DESC,imported_at DESC")).rows;
 let total=new Decimal(0),complete=rows.length>0;const sources=[];
 for(const row of rows){
  const p=row.payload,freshness=p.source==='portfolio-automation'?portfolioFreshness(p.as_of,p.generated_at,{now}):null,stale=freshness?freshness.stale:now()-Date.parse(row.as_of)>staleHours*3600000;
  const warnings=['只读券商快照，尚未自动写入正式账本；不能仅凭持仓变化推算收益。'];
  if(stale)warnings.push('来源数据已过期，保留上次成功快照，不按零处理');
  const accounts=p.accounts.map(a=>{
   const fx=a.valuation_currency==='CNY'?{rate_to_cny:'1'}:p.fx_rates.find(f=>f.currency===a.valuation_currency);
   let cny=null;
   if(a.net_liquidation_value!==undefined&&fx){cny=new Decimal(a.net_liquidation_value).mul(fx.rate_to_cny).toFixed(2);total=total.plus(cny);}
   else {complete=false;warnings.push(a.name+'缺少净资产或人民币折算汇率，未计入折算合计');}
   if(fx?.as_of && now()-Date.parse(fx.as_of)>(fx.source?.startsWith('Frankfurter')?7*24:staleHours)*3600000)warnings.push(a.name+'折算汇率已过期');
   return{...a,cny_net_liquidation_value:cny};
  });
  sources.push({refresh_policy:freshness?.policy,next_expected_by:freshness?.next_expected_by,source:p.source,snapshot_id:p.snapshot_id,revision:p.revision,as_of:p.as_of,imported_at:row.imported_at,stale,accounts,warnings:[...new Set(warnings)]});
 }
 return{connected:rows.length>0,sources,currency:'CNY',reported_net_assets_cny:rows.length===1&&complete?total.toFixed(2):null,conversion_complete:complete,account_mapping_complete:false,
  financial_transaction_posted:false,note:'仅为各来源申报净资产的折算加总；来源重复覆盖同一账户时不可当作个人总资产。与正式三张表分开展示。'};
}
