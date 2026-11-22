// Personal P&L in company form. Strict COGS: only spending that would not happen
// without the job rolls into cost of revenue, so gross profit answers "what does
// this job actually net me" rather than drifting with how often one eats out.
import {test,after} from 'node:test';import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';
import path from 'node:path';import {randomUUID} from 'node:crypto';
import {connectDatabase} from '../lib/db.mjs';
import {recordEvent} from '../lib/ledger.mjs';
import {documentService} from '../lib/documents.mjs';
import {reports} from '../lib/reports.mjs';
import {financialParent,seedClassifications,classificationTree} from '../lib/classifications.mjs';

if(!process.env.DATABASE_URL)process.env.DATABASE_URL=(await readFile('.env.test','utf8')).trim().split('DATABASE_URL=')[1];
if(!new URL(process.env.DATABASE_URL).pathname.endsWith('_test'))throw new Error('Isolated test database required');
const pool=await connectDatabase(),dir=await mkdtemp(path.join(tmpdir(),'cfo-pnl-')),docs=documentService(pool,dir);
after(async()=>{await pool.end();await rm(dir,{recursive:true,force:true});});
const reset=()=>pool.query('TRUNCATE cfo_audit,cfo_event_sources,cfo_lines,cfo_entries,cfo_events,cfo_documents RESTART IDENTITY CASCADE; DELETE FROM cfo_accounts WHERE system_key IS NULL');

async function post(payload){
 const d=await docs.saveBytes({file_name:'pnl.json'},{bytes:Buffer.from(randomUUID()),mime:'application/json'});
 const r=await recordEvent(pool,{document_id:d.id,source_ref:'row:'+randomUUID(),request_key:randomUUID(),
  payload:{currency:'CNY',date:'2026-11-10',...payload}});
 assert.equal(r.event.status,'posted',`未入账：${JSON.stringify(r.event.payload.needs_review||r.event.payload)}`);
 return r.event;
}

test('strict COGS keeps everyday meals out of cost of revenue',()=>{
 // Would not happen without the job → cost of revenue.
 for(const k of ['expense.commute','expense.work_meal','expense.training','expense.work_equipment','expense.work_attire'])
  assert.equal(financialParent(k,'expense'),'expense.cogs',k);
 // Happens whether or not one works → necessary living.
 for(const k of ['expense.food','expense.home','expense.housing','expense.transport','expense.medical','expense.unheard_of'])
  assert.equal(financialParent(k,'expense'),'expense.living',k);
 // Optional enjoyment → discretionary.
 for(const k of ['expense.travel','expense.entertainment','expense.shopping','expense.dining','expense.hobby'])
  assert.equal(financialParent(k,'expense'),'expense.lifestyle',k);
 assert.equal(financialParent('expense.interest','expense'),'expense.financing');
 assert.equal(financialParent('expense.fx','expense'),'expense.investment');
});

test('income splits into the three lines: job, investing, everything else',()=>{
 assert.equal(financialParent('income.salary','income'),'income.work');
 assert.equal(financialParent('income.side','income'),'income.other');   // moved out of job income
 assert.equal(financialParent('income.dividend','income'),'income.investment');
 assert.equal(financialParent('income.interest','income'),'income.investment');
});

test('the statement layers gross profit, operating profit and net income, and they reconcile',async()=>{
 await reset();
 await post({kind:'income', amount:'10000',category:'income.salary'});
 await post({kind:'income', amount:'300',  category:'income.dividend'});
 await post({kind:'expense',amount:'500',  category:'expense.commute'});      // COGS
 await post({kind:'expense',amount:'800',  category:'expense.work_meal'});    // COGS
 await post({kind:'expense',amount:'2000', category:'expense.food'});         // living
 await post({kind:'expense',amount:'3000', category:'expense.housing'});         // living
 await post({kind:'expense',amount:'1500', category:'expense.travel'});       // lifestyle
 await post({kind:'expense',amount:'200',  category:'expense.interest'});     // financing
 const s=(await reports(pool,'2026-11')).income_statement.sections;
 assert.equal(s.operating_revenue,'10000.00');
 assert.equal(s.cogs,'1300.00');                 // 500 + 800
 assert.equal(s.gross_profit,'8700.00');         // the job nets this before living
 assert.equal(s.living,'5000.00');               // 2000 + 3000
 assert.equal(s.lifestyle,'1500.00');
 assert.equal(s.operating_profit,'2200.00');     // 8700 - 5000 - 1500
 assert.equal(s.investment_income,'300.00');
 assert.equal(s.financing_cost,'200.00');
 assert.equal(s.net_income,'2300.00');           // 2200 + 300 - 200
});

test('layered net income always equals the flat total, so the two views cannot drift',async()=>{
 await reset();
 await post({kind:'income', amount:'8800.55',category:'income.salary'});
 await post({kind:'expense',amount:'1234.56',category:'expense.commute'});
 await post({kind:'expense',amount:'987.65', category:'expense.food'});
 await post({kind:'expense',amount:'432.10', category:'expense.shopping'});
 await post({kind:'expense',amount:'77.77',  category:'expense.interest'});
 const st=(await reports(pool,'2026-11')).income_statement;
 assert.equal(st.sections.net_income,st.net_income);
 const byLayer=['cogs','living','lifestyle','financing_cost','investment_loss','other_expense']
  .reduce((t,k)=>t+Number(st.sections[k]),0);
 assert.equal(byLayer.toFixed(2),Number(st.total_expenses).toFixed(2));  // every expense lands in exactly one layer
});

test('an account filed under the old single bucket is migrated to its new line',async()=>{
 await reset();
 await post({kind:'expense',amount:'600',category:'expense.travel'});
 // Simulate a node created before the restructure, when everything hung off living.
 await pool.query("UPDATE cfo_classification_nodes SET parent_code='expense.living' WHERE tree='financial' AND code='expense.travel'");
 await seedClassifications(pool);
 const node=(await classificationTree(pool)).find(n=>n.tree==='financial'&&n.code==='expense.travel');
 assert.equal(node.parent_code,'expense.lifestyle','旧科目没有被迁移到新的一级');
});

test('every classification node has a parent that exists and shares its group',async()=>{
 // A fresh database inserts accounts in declaration order, so a child whose parent
 // is itself an account node can be inserted first. The parent check then reads a
 // NULL group and reports "different business group", which hides the real cause:
 // the parent is simply not there yet. Verified by migrating an empty database.
 const tree=await classificationTree(pool);
 const byKey=new Map(tree.map(n=>[n.tree+':'+n.code,n]));
 let checked=0;
 for(const n of tree){
  if(!n.parent_code)continue;
  const parent=byKey.get(n.tree+':'+n.parent_code);
  assert.ok(parent,`${n.tree}:${n.code} 的父节点 ${n.parent_code} 不存在`);
  assert.equal(parent.business_group,n.business_group,`${n.code} 与父节点 ${n.parent_code} 的分组不一致`);
  checked++;
 }
 assert.ok(checked>10,`只检查到 ${checked} 个父子关系，树看起来没建起来`);
});

test('side income hangs under other income, which is itself a seeded node',async()=>{
 const tree=await classificationTree(pool);
 const other=tree.find(n=>n.tree==='financial'&&n.code==='income.other');
 assert.ok(other,'其他收入必须是种子节点，否则副业会先于它插入');
 assert.equal(other.parent_code,'income');
 const side=tree.find(n=>n.tree==='financial'&&n.code==='income.side');
 if(side)assert.equal(side.parent_code,'income.other');
});
