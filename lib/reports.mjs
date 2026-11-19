import {displayLedger} from './display-ledger.mjs';
import {SUMMARY_POLICY} from './settlement.mjs';
import Decimal from 'decimal.js';
import {validDate,START,yuan} from './money.mjs';
const sum=(rows,field)=>rows.reduce((s,r)=>s.plus(r[field]||0),new Decimal(0));
export async function reports(pool,month,presentation={}) {
  const c=await pool.connect();
  try{await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const r=await buildReports(displayLedger(c,presentation),month);r.currency=presentation.currency||'CNY';await c.query('COMMIT');return r;}
  catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
async function buildReports(pool,month) {
  if(!/^\d{4}-\d{2}$/.test(month))throw new Error('月份格式应为YYYY-MM');
  const from=month+'-01';if(!validDate(from)||from<START)throw new Error('报表从2026年11月开始');
  const end=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5)),0)).toISOString().slice(0,10);
  const q=await pool.query(`SELECT a.id,a.name,a.kind,a.currency,a.account_group,a.is_cash,a.opening_confirmed,
   COALESCE(sum(l.cny_cents) FILTER(WHERE j.entry_date<=$2),0)::text AS balance,
   COALESCE(sum(l.native_cents) FILTER(WHERE j.entry_date<=$2),0)::text AS native_balance,
   COALESCE(sum(l.cny_cents) FILTER(WHERE j.entry_date BETWEEN $1 AND $2),0)::text AS period,
   a.system_key FROM cfo_accounts a LEFT JOIN cfo_lines l ON l.account_id=a.id LEFT JOIN cfo_entries j ON j.id=l.entry_id
   GROUP BY a.id ORDER BY a.account_group,a.name`,[from,end]);
  const rows=q.rows;const assets=rows.filter(a=>a.account_group==='asset');const liabilities=rows.filter(a=>a.account_group==='liability');
  const income=rows.filter(a=>a.account_group==='income');const expenses=rows.filter(a=>a.account_group==='expense');
  const totalAssets=sum(assets,'balance'),totalLiabilities=sum(liabilities,'balance').negated();
  const netIncome=sum(income,'period').negated().minus(sum(expenses,'period'));
  const cumulativeProfit=sum(income,'balance').negated().minus(sum(expenses,'balance'));
  const capital=sum(rows.filter(a=>a.account_group==='equity'),'balance').negated();
  const flows=(await pool.query(`SELECT j.cash_flow_bucket,COALESCE(sum(l.cny_cents),0)::text AS cents
    FROM cfo_lines l JOIN cfo_accounts a ON a.id=l.account_id JOIN cfo_entries j ON j.id=l.entry_id
    WHERE a.is_cash AND j.entry_date BETWEEN $1 AND $2 AND j.cash_flow_bucket<>'opening'
    GROUP BY j.cash_flow_bucket`,[from,end])).rows;
  const cashRows=(await pool.query(`SELECT
   COALESCE(sum(l.cny_cents) FILTER(WHERE j.entry_date<$1 OR(j.entry_date=$1 AND j.cash_flow_bucket='opening')),0)::text AS opening,
   COALESCE(sum(l.cny_cents) FILTER(WHERE j.entry_date<=$2),0)::text AS closing
   FROM cfo_lines l JOIN cfo_accounts a ON a.id=l.account_id JOIN cfo_entries j ON j.id=l.entry_id WHERE a.is_cash`,[from,end])).rows[0];
  const missing=rows.filter(a=>!a.system_key&&!a.opening_confirmed).map(a=>a.name);
  const drafts=Number((await pool.query("SELECT count(*) FROM cfo_events WHERE status='draft'")).rows[0].count);
  const warnings=['报表采用已入账交易及历史汇率的账面口径；未核对的投资净值变动不直接记为利润，不用于税务申报。'];
  if(missing.length)warnings.push('期初余额尚未确认：'+missing.join('、'));
  if(drafts)warnings.push(`${drafts} 笔待处理交易未计入报表`);
  const bridgeRun=(await pool.query('SELECT status,summary FROM cfo_broker_bridge_runs ORDER BY id DESC LIMIT 1')).rows[0];
  const sourceConnected=!!(await pool.query('SELECT 1 FROM cfo_account_results UNION ALL SELECT 1 FROM cfo_broker_accounts LIMIT 1')).rowCount;
  const brokerCoverage=(await pool.query("SELECT account_scope,through_date::text FROM cfo_broker_postings WHERE kind='investment_settlement' ORDER BY through_date DESC")).rows;
  const through=Object.fromEntries(['moomoo','tiger','futubull'].map(b=>[b,brokerCoverage.find(r=>r.account_scope.includes(b))?.through_date||null]));
  const requiredThrough=end<new Date(Date.now()+8*3600000).toISOString().slice(0,10)?end:new Date(Date.now()+8*3600000).toISOString().slice(0,10);
  const investment_reconciliation={connected:sourceConnected,status:bridgeRun?.status||'not_started',complete:sourceConnected&&Object.values(through).every(d=>d&&d>=requiredThrough),through_by_broker:through,pending_reasons:bridgeRun?.summary?.reasons||[],cash_scope:'现金流仅按已登记的非券商现金收付核算；券商内现金已包含在投资账户总额中，未作为独立现金账户重复加入。'};
  if(sourceConnected&&!investment_reconciliation.complete)warnings.push('券商投资期间尚未核对齐全：当前利润仅含已入账部分；最新券商净值与账面余额可能不同，未把差额当收益。');
  const yearFrom=month.slice(0,4)+'-01-01';
  const coverageFrom=yearFrom<START?START:yearFrom;
  const financeRows=(await pool.query(`SELECT a.system_key,
    COALESCE(sum(l.cny_cents) FILTER(WHERE j.entry_date BETWEEN $1 AND $2),0)::text AS month_cents,
    COALESCE(sum(l.cny_cents) FILTER(WHERE j.entry_date BETWEEN $3 AND $2),0)::text AS year_cents
    FROM cfo_accounts a LEFT JOIN cfo_lines l ON l.account_id=a.id LEFT JOIN cfo_entries j ON j.id=l.entry_id
    WHERE a.system_key IN ('expense.interest','expense.financing_fees') GROUP BY a.system_key`,[from,end,coverageFrom])).rows;
  const financeCost=key=>financeRows.find(row=>row.system_key===key)||{month_cents:'0',year_cents:'0'};
  const interest=financeCost('expense.interest'),fees=financeCost('expense.financing_fees');
  const netWorth=totalAssets.minus(totalLiabilities);
  const leverage={basis:'posted_ledger',as_of:end,coverage_complete:missing.length===0&&assets.length+liabilities.length>0&&(!sourceConnected||investment_reconciliation.complete),
    asset_liability_ratio_percent:totalAssets.gt(0)?totalLiabilities.div(totalAssets).mul(100).toFixed(4):null,
    assets_to_net_worth:netWorth.gt(0)?totalAssets.div(netWorth).toFixed(4):null,
    debt_accounts:liabilities.map(a=>({account_id:a.id,name:a.name,kind:a.kind,currency:a.currency,balance:yuan(new Decimal(a.native_balance).negated()),cny_balance:yuan(new Decimal(a.balance).negated()),opening_confirmed:a.opening_confirmed})),
    note:'仅按已入账资产与负债计算；未映射的券商快照及未登记借款不在其中，不能当作完整个人杠杆。'};
  const financing={basis:'posted_expense',year:month.slice(0,4),year_coverage_from:coverageFrom,through:end,
    monthly_interest_expense:yuan(interest.month_cents),year_to_date_interest_expense:yuan(interest.year_cents),
    monthly_financing_fees:yuan(fees.month_cents),year_to_date_financing_fees:yuan(fees.year_cents),
    monthly_total_cost:yuan(new Decimal(interest.month_cents).plus(fees.month_cents)),
    year_to_date_total_cost:yuan(new Decimal(interest.year_cents).plus(fees.year_cents)),
    estimated_monthly_interest:null,estimated_annual_interest:null,
    note:'仅汇总已入账费用，包含以费用记录的计提；不等于已付现金或全年完整利息。缺少借款计息规则时不预测。'};
  return {investment_reconciliation,settlement_policy:SUMMARY_POLICY,leverage,financing,month,from,to:end,currency:'CNY',basis:'book_value',opening_complete:missing.length===0&&assets.length+liabilities.length>0,warnings,drafts,
    balance_sheet:{assets:assets.map(a=>({...a,balance:yuan(a.balance),native_balance:yuan(a.native_balance)})),liabilities:liabilities.map(a=>({...a,balance:yuan(new Decimal(a.balance).negated()),native_balance:yuan(new Decimal(a.native_balance).negated())})),total_assets:yuan(totalAssets),total_liabilities:yuan(totalLiabilities),net_worth:yuan(totalAssets.minus(totalLiabilities)),opening_equity:yuan(capital),retained_profit:yuan(cumulativeProfit),balanced:totalAssets.minus(totalLiabilities).eq(capital.plus(cumulativeProfit))},
    income_statement:{income:income.filter(a=>!new Decimal(a.period).isZero()).map(a=>({name:a.name,key:a.system_key,amount:yuan(new Decimal(a.period).negated())})),expenses:expenses.filter(a=>!new Decimal(a.period).isZero()).map(a=>({name:a.name,key:a.system_key,amount:yuan(a.period)})),total_income:yuan(sum(income,'period').negated()),total_expenses:yuan(sum(expenses,'period')),net_income:yuan(netIncome)},
    cash_flow:{basis:'recorded_cash_settlement',note:'按已记录的现金收付汇总，综合现金不代表某张卡或钱包的对账余额；赊购不计当期现金流，期初未齐时不代表完整现金家底。',opening:yuan(cashRows.opening),closing:yuan(cashRows.closing),buckets:flows.map(r=>({bucket:r.cash_flow_bucket,amount:yuan(r.cents)})),net_change:yuan(sum(flows,'cents')),reconciled:new Decimal(cashRows.closing).minus(cashRows.opening).eq(sum(flows,'cents'))}
  };
}
