import {cents,yuan as formatYuan,CURRENCIES} from './money.mjs';
const yuan=n=>formatYuan(n.toString());
const rowCurrency=row=>row.account_currency&&row.payload.currency&&row.account_currency!==row.payload.currency?null:row.account_currency||row.payload.currency||null;

// This is a receipt for explicitly selected events, never a whole-month report.
export function summarizeBatchRows(rows){
 const currencies=new Map(),seen=new Set();let postedIncome=0n,postedExpense=0n;
 const counts={posted:0,draft:0,reversed:0,discarded:0,other:0};
 const unknown={currency:0,amount:0},pending=[];let excluded=0;
 for(const row of rows){
  if(seen.has(row.id))continue;seen.add(row.id);
  const status=Object.hasOwn(counts,row.status)?row.status:'other';counts[status]++;
  const p=row.payload;
  if(row.status==='draft')pending.push({event_id:row.id,date:p.date??null,description:p.description||'',kind:p.kind,amount:p.amount??null,currency:rowCurrency(row),issues:row.issues||[]});
  if(!['posted','draft'].includes(row.status))continue;
  if(!['income','expense'].includes(p.kind)){excluded++;continue;}
  if(row.status==='posted'){
   if(row.income_cents==null||row.expense_cents==null||Number(row.entry_count)!==1)throw new Error('已入账交易缺少完整分录，无法汇总');
   postedIncome+=BigInt(row.income_cents);postedExpense+=BigInt(row.expense_cents);
  }
  const currency=rowCurrency(row);
  let amount;try{amount=BigInt(cents(p.amount));if(amount<=0n)throw new Error('invalid amount');}catch{unknown.amount++;}
  if(!CURRENCIES.includes(currency)){unknown.currency++;continue;}
  if(amount===undefined||amount<=0n)continue;
  if(!currencies.has(currency))currencies.set(currency,{posted_income:0n,posted_expense:0n,pending_income:0n,pending_expense:0n});
  const group=currencies.get(currency),key=(row.status==='posted'?'posted_':'pending_')+p.kind;group[key]+=amount;
 }
 const by_currency=[...currencies].sort(([a],[b])=>a.localeCompare(b)).map(([currency,g])=>({currency,posted_income:yuan(g.posted_income),posted_expense:yuan(g.posted_expense),pending_income:yuan(g.pending_income),pending_expense:yuan(g.pending_expense),identified_income:yuan(g.posted_income+g.pending_income),identified_expense:yuan(g.posted_expense+g.pending_expense)}));
 return{scope:'selected_events',event_count:seen.size,counts,posted:{income_cny:yuan(postedIncome),expense_cny:yuan(postedExpense),net_cny:yuan(postedIncome-postedExpense)},by_currency,unknown,pending,excluded_non_income_expense_count:excluded,
  financial_transaction_posted:false,note:'只读批次汇总；已识别合计包含待确认，只有posted计入正式报表。重复event_id只计一次；已在历史入账的选定交易也计入批次金额，不能称为本次新增。转账、借还本金、期初、报销及估值不混入本批收入支出；不同币种不直接相加。'};
}
export async function batchSummary(pool,ids){
 const unique=[...new Set(ids)];
 const rows=(await pool.query(`SELECT e.id,e.status,e.payload,e.issues,a.currency AS account_currency,
  (SELECT count(*) FROM cfo_entries j WHERE j.event_id=e.id AND j.reverses_id IS NULL)::int AS entry_count,
  (SELECT sum(CASE WHEN a2.account_group='income' THEN -l.cny_cents ELSE 0 END) FROM cfo_entries j JOIN cfo_lines l ON l.entry_id=j.id JOIN cfo_accounts a2 ON a2.id=l.account_id WHERE j.event_id=e.id AND j.reverses_id IS NULL)::text AS income_cents,
  (SELECT sum(CASE WHEN a2.account_group='expense' THEN l.cny_cents ELSE 0 END) FROM cfo_entries j JOIN cfo_lines l ON l.entry_id=j.id JOIN cfo_accounts a2 ON a2.id=l.account_id WHERE j.event_id=e.id AND j.reverses_id IS NULL)::text AS expense_cents
  FROM cfo_events e LEFT JOIN cfo_accounts a ON a.id::text=e.payload->>'account_id' WHERE e.id=ANY($1::uuid[])`,[unique])).rows;
 if(rows.length!==unique.length)throw new Error('批次含不存在的交易，未返回不完整合计');
 return summarizeBatchRows(rows);
}
