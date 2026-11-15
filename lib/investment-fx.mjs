import DecimalBase from 'decimal.js';
const D=DecimalBase.clone({precision:60});
export function foreignUsdToCny(usdPerForeign,cnyPerUsd){return new D(usdPerForeign).mul(cnyPerUsd).toFixed();}
export function usdForeignToCny(foreignPerUsd,cnyPerUsd){return new D(cnyPerUsd).div(foreignPerUsd).toFixed(12);}
export async function fetchInvestmentFx({fetcher=fetch,now=()=>Date.now()}={}){
 const response=await fetcher('https://api.frankfurter.dev/v1/latest?base=USD&symbols=CNY',{signal:AbortSignal.timeout(10000),redirect:'error'});
 if(!response.ok)throw new Error('估值汇率服务暂不可用');
 const text=await response.text();if(text.length>16384)throw new Error('汇率响应过大');const d=JSON.parse(text);
 if(d.base!=='USD'||!/^\d{4}-\d{2}-\d{2}$/.test(d.date)||typeof d.rates?.CNY!=='number'||!Number.isFinite(d.rates.CNY)||d.rates.CNY<=0)throw new Error('估值汇率格式无效');
 const as_of=d.date+'T00:00:00Z';if(!Number.isFinite(Date.parse(as_of))||now()-Date.parse(as_of)>7*86400000||Date.parse(as_of)>now()+300000)throw new Error('估值汇率日期无效或过期');
 return{rate_to_cny:new D(d.rates.CNY).toFixed(),as_of,source:'Frankfurter / ECB daily reference; valuation only, not broker execution FX'};
}
