import {cents,CURRENCIES} from './money.mjs';
export function balanceReference(payload){
 if(payload.kind!=='opening'||payload.amount!==undefined&&payload.amount!=='')return null;
 if(payload.balance_observation)return{...payload.balance_observation,basis:'recorded_observation'};
 // Legacy display fallback only. Never writes a posting amount, chooses a date,
 // sums separate products, or treats arbitrary numbers as a balance.
 const text=payload.description||'';if(!text.includes('截图'))return null;
 const matches=[...text.matchAll(/(?:总额|余额)\s*(CNY|USD|SGD|HKD|EUR|GBP)\s*((?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]{1,2})?)(?![0-9.]|,[0-9]|\s*[A-Za-z万亿千])/g)];
 if(matches.length!==1)return null;const currency=matches[0][1],amount=matches[0][2].replaceAll(',','');
 try{cents(amount);if(payload.currency&&payload.currency!==currency)return null;if(!CURRENCIES.includes(currency))return null;return{amount,currency,basis:'description_only'};}catch{return null;}
}
