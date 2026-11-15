import DecimalBase from 'decimal.js';
import {accountResultOverview} from './account-results.mjs';
import {investmentOverview} from './investments.mjs';
import {portfolioSourceStatus} from './portfolio-source.mjs';
const Decimal=DecimalBase.clone({precision:60});
// CFO consumes account results. Securities and trade analysis belong upstream.
export function summarizeInvestmentView(overview,sourceStatus){
 const sources=overview.sources.map(source=>{
  const totals=new Map();
  const accounts=source.accounts.map(({positions,positions_complete,...account})=>{
   const currency=account.valuation_currency,group=totals.get(currency)||{amount:new Decimal(0),complete:true};
   if(account.net_liquidation_value===undefined)group.complete=false;else group.amount=group.amount.plus(account.net_liquidation_value);totals.set(currency,group);
   const negative_cash_balances=(account.cash_balances||[]).filter(c=>new Decimal(c.amount).lt(0)).map(c=>({currency:c.currency,amount:new Decimal(c.amount).negated().toFixed(2)}));
   return{...account,negative_cash_balances};
  });
  return{...source,accounts,net_assets_by_currency:[...totals].map(([currency,group])=>({currency,amount:group.complete?group.amount.toFixed(2):null}))};
 });
 let source_status=sourceStatus;
 if(sourceStatus?.metadata){const {aggregate_positions,cash_candidates,...metadata}=sourceStatus.metadata;source_status={...sourceStatus,metadata};}
 return{...overview,sources,source_status,investment_profit:{status:'unavailable',amount:null,reason:'尚未接入已核对的期间投资损益；账户净值变化不能直接当作利润。'}};
}
export async function investmentView(pool,options){const [overview,source_status,account_results]=await Promise.all([investmentOverview(pool,options),portfolioSourceStatus(pool,options),accountResultOverview(pool,options)]);return{...summarizeInvestmentView(overview,source_status),account_results};}
