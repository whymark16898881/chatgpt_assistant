import DecimalBase from 'decimal.js';import {validDate,CURRENCIES} from './money.mjs';
const Decimal=DecimalBase.clone({precision:50});export const DISPLAY_CURRENCIES=['CNY','USD','SGD'];
const primary='https://open.er-api.com/v6/latest/USD',fallback='https://api.frankfurter.dev/v1/latest?base=CNY&symbols=USD,SGD,HKD,EUR,GBP';
export const singaporeDay=d=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Singapore',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
function validRate(value){try{const n=new Decimal(value);return n.isFinite()&&n.gt(0)&&n.lt(100000);}catch{return false;}}
export function normalizeFx(data,provider,now=new Date()){
 const today=singaporeDay(now);let date,raw,base;
 if(provider==='ExchangeRate-API'){if(data.result!=='success'||data.base_code!=='USD'||!Number.isSafeInteger(data.time_last_update_unix)||data.time_last_update_unix*1000>now.getTime()+300000)throw new Error('汇率来源格式或时间无效');date=new Date(data.time_last_update_unix*1000).toISOString().slice(0,10);raw=data.rates;base='USD';}
 else{if(data.base!=='CNY'||data.amount!==1)throw new Error('汇率来源基准无效');date=data.date;raw={...data.rates,CNY:1};base='CNY';}
 if(!validDate(date)||date>today||(Date.parse(today)-Date.parse(date))/86400000>5)throw new Error('汇率来源日期过期或无效');
 if(!raw||!CURRENCIES.every(c=>validRate(raw[c]))||!new Decimal(raw[base]).eq(1))throw new Error('汇率数据不完整');
 const rates=Object.fromEntries(CURRENCIES.map(c=>[c,new Decimal(raw[c]).div(raw.CNY).toFixed(16)]));rates.CNY='1';return{provider,rate_date:date,rates,source_url:provider==='ExchangeRate-API'?primary:fallback};
}
export function convertReference(amount,from,to,rates){if(amount===null||amount===undefined||amount==='')return null;try{if(!/^-?\d+(\.\d+)?$/.test(String(amount)))return null;if(from===to)return new Decimal(amount).toFixed(2);if(!validRate(rates?.[from])||!validRate(rates?.[to]))return null;return new Decimal(amount).div(rates[from]).mul(rates[to]).toFixed(2);}catch{return null;}}
export function createPresentationFx(pool,{fetcher=fetch,now=()=>new Date()}={}){
 let running,lastStatus={status:'loading',rate_date:null,provider:null};
 function result(row,cached=false){const today=singaporeDay(now());return row?{...row,today,status:cached?'cached':row.rate_date===today?'current':'latest_available'}:{id:null,today,rate_date:null,provider:null,rates:{CNY:'1'},status:'unavailable',source_url:null};}
 async function cached(id){const row=(await pool.query('SELECT id,rate_date::text,provider,rates,source_url,fetched_at FROM cfo_presentation_rates '+(id?'WHERE id=$1':'ORDER BY rate_date DESC,fetched_at DESC LIMIT 1'),id?[id]:[])).rows[0];if(!row||!validDate(row.rate_date)||row.rate_date>singaporeDay(now())||(Date.parse(singaporeDay(now()))-Date.parse(row.rate_date))/86400000>5||!CURRENCIES.every(c=>validRate(row.rates?.[c])))return null;return row;}
 async function getInternal(){const old=await cached();if(old&&now().getTime()-new Date(old.fetched_at).getTime()<3600000&&singaporeDay(new Date(old.fetched_at))===singaporeDay(now()))return result(old);if(!running)running=(async()=>{for(const [url,provider] of [[primary,'ExchangeRate-API'],[fallback,'ECB / Frankfurter']])try{const r=await fetcher(url,{signal:AbortSignal.timeout(7000),redirect:'error'});if(!r.ok)throw new Error('汇率来源暂不可用');const rate=normalizeFx(await r.json(),provider,now());if(old&&old.rate_date>rate.rate_date)continue;const row=(await pool.query('INSERT INTO cfo_presentation_rates(rate_date,provider,rates,source_url,fetched_at) VALUES($1,$2,$3,$4,$5) RETURNING id,rate_date::text,provider,rates,source_url,fetched_at',[rate.rate_date,rate.provider,JSON.stringify(rate.rates),rate.source_url,now()])).rows[0];return result(row);}catch{}return result(old,true);})().finally(()=>{running=null;});return running;}
 async function get(){const r=await getInternal();lastStatus={status:r.status,rate_date:r.rate_date,provider:r.provider};return r;}
 return{get,status:()=>lastStatus,resolve:async(currency='CNY',id)=>{if(!DISPLAY_CURRENCIES.includes(currency))throw new Error('展示币种仅支持人民币、美金、新币');const snapshot=id?result(await cached(id)):currency==='CNY'?result(null):await get();if(currency!=='CNY'&&!snapshot.id)throw new Error('最新可用汇率暂不可用，请稍后重试');return{currency,rate:currency==='CNY'?'1':snapshot.rates[currency],snapshot};}};
}
