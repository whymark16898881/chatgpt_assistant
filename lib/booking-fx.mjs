import Decimal from 'decimal.js';
import {CURRENCIES,validDate} from './money.mjs';
import {singaporeDay} from './presentation-fx.mjs';
const services=new WeakMap();
export const configureBookingFx=(pool,service)=>services.set(pool,service);
export async function automaticBookingFx(pool,client,payload){const service=services.get(pool);return service?service.enrich(client,payload):payload;}
const provider='ECB / Frankfurter';
const good=v=>{try{return typeof v==='string'&&/^\d+(\.\d{1,12})?$/.test(v)&&new Decimal(v).gt(0)&&new Decimal(v).lt(100000);}catch{return false;}};
const fxOnly=new Set(['补充对应日期人民币折算汇率及来源','补充人民币折算汇率及来源','外币交易缺少有效的人民币汇率','请提供汇率来源，不能猜测汇率']);
export function createBookingFx(pool,{fetcher=fetch,now=()=>new Date()}={}){
 const pending=new Map();let status={status:'pending',requested_date:null,rate_date:null,provider};
 async function get(date){
  if(!validDate(date)||date>singaporeDay(now()))throw new Error('自动汇率需要有效且不晚于今天的入账日期');
  if(pending.has(date))return pending.get(date);
  const job=(async()=>{
   const cached=(await pool.query('SELECT * FROM cfo_booking_fx_daily WHERE requested_date=$1',[date])).rows[0];
   if(cached){status={status:'ready',requested_date:date,rate_date:cached.rate_date,provider:cached.provider};return cached;}
   const url=`https://api.frankfurter.dev/v1/${date}?base=CNY&symbols=USD,SGD,HKD,EUR,GBP`;
   const response=await fetcher(url,{signal:AbortSignal.timeout(7000),redirect:'error'});if(!response.ok)throw new Error('公开汇率服务暂不可用');
   const data=await response.json(),day=data.date;
   if(data.base!=='CNY'||data.amount!==1||!validDate(day)||day>date||(Date.parse(date)-Date.parse(day))/86400000>10)throw new Error('公开汇率日期或基准无效');
   const rates={CNY:'1'};
   for(const currency of CURRENCIES.filter(c=>c!=='CNY')){const value=data.rates?.[currency];if(typeof value!=='number'||!Number.isFinite(value)||value<=0)throw new Error('公开汇率不完整');rates[currency]=new Decimal(1).div(value).toFixed(12);if(!good(rates[currency]))throw new Error('公开汇率无效');}
   const row=(await pool.query('INSERT INTO cfo_booking_fx_daily(requested_date,rate_date,provider,rates,source_url) VALUES($1,$2,$3,$4,$5) ON CONFLICT(requested_date) DO UPDATE SET requested_date=EXCLUDED.requested_date RETURNING *',[date,day,provider,JSON.stringify(rates),url])).rows[0];
   status={status:'ready',requested_date:date,rate_date:row.rate_date,provider};return row;
  })();pending.set(date,job);
  try{return await job;}catch(e){status={status:'unavailable',requested_date:date,rate_date:null,provider};throw e;}finally{pending.delete(date);}
 }
 async function enrich(client,p){
  if(!validDate(p.date)||p.date>singaporeDay(now()))return p;
  const ids=[p.account_id,p.counter_account_id].filter(Boolean),accounts=ids.length?(await client.query('SELECT id,currency FROM cfo_accounts WHERE id=ANY($1::uuid[])',[ids])).rows:[];
  const from=accounts.find(a=>a.id===p.account_id)?.currency||p.currency,to=accounts.find(a=>a.id===p.counter_account_id)?.currency;
  if(p.currency&&from&&p.currency!==from)return p;
  const foreign=from&&from!=='CNY',counter=['transfer','reimbursement_advance','reimbursement_received'].includes(p.kind)&&to&&to!==from&&to!=='CNY';
  if(!foreign&&!counter)return p;
  const auto=!!p.fx_reference,complete=(!foreign||good(p.fx_rate))&&(!counter||good(p.counter_fx_rate))&&!!p.fx_source?.trim();
  if(complete&&!auto)return p;
  try{
   const quote=await get(p.date),next={...p};
   if(foreign)next.fx_rate=quote.rates[from];if(counter)next.counter_fx_rate=quote.rates[to];
   if((foreign&&!next.fx_rate)||(counter&&!next.counter_fx_rate))return p;
   next.fx_source=`${quote.provider} ${quote.rate_date} (记账日${p.date})`;
   next.fx_reference={requested_date:p.date,rate_date:quote.rate_date,provider:quote.provider,source_url:quote.source_url};
   next.needs_review=(p.needs_review||[]).filter(note=>!fxOnly.has(note));return next;
  }catch{
   // A failed lookup never discards an original receipt or borrows today's quote.
   // Clear only machine-filled quotes whose requested date is now different.
   if(auto&&p.fx_reference.requested_date!==p.date){const next={...p};delete next.fx_rate;delete next.counter_fx_rate;delete next.fx_source;delete next.fx_reference;return next;}
   return p;
  }
 }
 return{get,enrich,status:()=>status,warmToday:()=>get(singaporeDay(now()))};
}
