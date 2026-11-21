// Platform-level aggregation (0.4.15): one asset total and one liability total per platform,
// while multi-currency and multi-card facts stay intact underneath. Synthetic data only.
import {test,after} from 'node:test';import assert from 'node:assert/strict';import {readFile,mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';import {randomUUID} from 'node:crypto';
import Decimal from 'decimal.js';
import {connectDatabase} from '../lib/db.mjs';import {createAccount,recordEvent,listAccounts} from '../lib/ledger.mjs';import {reports} from '../lib/reports.mjs';import {documentService} from '../lib/documents.mjs';
import {platformName,platformOptions,groupPlatformBalances} from '../lib/platforms.mjs';
if(!process.env.DATABASE_URL)process.env.DATABASE_URL=(await readFile('.env.test','utf8')).trim().split('DATABASE_URL=')[1];
if(!new URL(process.env.DATABASE_URL).pathname.endsWith('_test'))throw new Error('Isolated test database required');
const pool=await connectDatabase(),dir=await mkdtemp(path.join(tmpdir(),'cfo-platform-')),docs=documentService(pool,dir);
after(async()=>{await pool.end();await rm(dir,{recursive:true,force:true});});
const reset=()=>pool.query('TRUNCATE cfo_audit,cfo_event_sources,cfo_lines,cfo_entries,cfo_events,cfo_documents RESTART IDENTITY CASCADE; DELETE FROM cfo_accounts WHERE system_key IS NULL');
async function record(payload,extra={}){const d=await docs.saveBytes({file_name:'synthetic-platform.json'},{bytes:Buffer.from(randomUUID()),mime:'application/json'});return (await recordEvent(pool,{document_id:d.id,source_ref:'row:1',request_key:randomUUID(),payload:{date:'2026-11-02',...payload},...extra})).event;}
const acct=(name,kind='bank',currency='CNY')=>createAccount(pool,{name,kind,currency});
// Opening balances in a foreign currency carry an explicit manual quote so the test never touches the network.
const opening=(a,amount,fx)=>record({kind:'opening',date:'2026-11-01',account_id:a.id,amount,...(fx?{fx_rate:fx,fx_source:'synthetic manual quote'}:{})});
const total=rows=>rows.reduce((n,r)=>n.plus(r.balance),new Decimal(0)).toFixed(2);
const card=(rows,name)=>rows.find(r=>r.name===name);

/** Builds the acceptance fixture named in the handover: one bank across four currencies/cards plus a
 *  credit card, three separate brokers, and the 中信银行 / 中信证券 pair that must never merge. */
async function fixture(){
 await reset();
 const hsbcCny=await acct('汇丰活期'),hsbcTime=await acct('汇丰定期'),hsbcUsd=await acct('汇丰美元户','bank','USD'),hsbcSgd=await acct('汇丰新币户','bank','SGD'),
  hsbcCard=await acct('汇丰信用卡','credit_card'),tiger=await acct('Tiger 证券','investment','USD'),moomoo=await acct('moomoo 账户','investment','USD'),
  futu=await acct('富途牛牛','investment','HKD'),citicBank=await acct('中信银行储蓄'),citicSec=await acct('中信证券账户','investment');
 for(const [a,amount,fx] of [[hsbcCny,'10000'],[hsbcTime,'50000'],[hsbcUsd,'1000','7.2'],[hsbcSgd,'2000','5.4'],[hsbcCard,'3000'],
   [tiger,'500','7.2'],[moomoo,'600','7.2'],[futu,'700','0.92'],[citicBank,'8000'],[citicSec,'9000']])
  assert.equal((await opening(a,amount,fx)).status,'posted',`期初未入账: ${a.name}`);
 return {hsbcCny,hsbcTime,hsbcUsd,hsbcSgd,hsbcCard,tiger,moomoo,futu,citicBank,citicSec};
}

test('one asset total and one liability total per platform; multi-currency cards merge while distinct institutions never do',async()=>{
 await fixture();const r=await reports(pool,'2026-11');const {assets,liabilities}=r.balance_sheet;
 // Four HSBC nodes across CNY/USD/SGD collapse into a single asset card; the credit card stays on the liability side.
 const hsbc=card(assets,'HSBC');assert.ok(hsbc,'缺少 HSBC 平台资产卡片');
 assert.equal(hsbc.member_count,4);assert.equal(hsbc.balance,'78000.00');
 const hsbcDebt=card(liabilities,'HSBC');assert.ok(hsbcDebt,'缺少 HSBC 平台负债卡片');
 assert.equal(hsbcDebt.member_count,1);assert.equal(hsbcDebt.balance,'3000.00');
 // Assets and liabilities are reported separately, never netted into one platform figure.
 assert.ok(!assets.some(a=>a.account_group==='liability'));assert.ok(!liabilities.some(a=>a.account_group==='asset'));
 // The three brokers are independent platforms, and neither 中信 institution absorbs the other.
 assert.deepEqual([card(assets,'Tiger')?.balance,card(assets,'moomoo')?.balance,card(assets,'富途')?.balance],['3600.00','4320.00','644.00']);
 assert.equal(card(assets,'中信银行').balance,'8000.00');assert.equal(card(assets,'中信证券').balance,'9000.00');
 assert.equal(card(assets,'中信银行').member_count,1);assert.equal(card(assets,'中信证券').member_count,1);
 assert.equal(assets.filter(a=>a.name.startsWith('中信')).length,2);
 assert.deepEqual([...assets.map(a=>a.name)].sort(),['HSBC','Tiger','moomoo','中信银行','中信证券','富途'].sort());
});

test('aggregation is exact: platform cards reproduce total assets, liabilities and net worth to the cent',async()=>{
 await fixture();const r=await reports(pool,'2026-11');const {assets,liabilities,total_assets,total_liabilities,net_worth}=r.balance_sheet;
 assert.equal(total(assets),total_assets);assert.equal(total(liabilities),total_liabilities);
 assert.equal(new Decimal(total(assets)).minus(total(liabilities)).toFixed(2),net_worth);
 assert.equal(total_assets,'103564.00');assert.equal(total_liabilities,'3000.00');assert.equal(net_worth,'100564.00');
 assert.equal(r.balance_sheet.balanced,true);
 // Grouping is a presentation layer: the per-node detail behind the cards still sums to the same totals.
 assert.equal(total(r.balance_sheet.account_details.assets),total_assets);
 assert.equal(total(r.balance_sheet.account_details.liabilities),total_liabilities);
 // Every member id is accounted for exactly once, so no node is dropped or double-counted.
 const grouped=assets.concat(liabilities).flatMap(a=>a.member_ids),detail=r.balance_sheet.account_details.assets.concat(r.balance_sheet.account_details.liabilities).map(a=>a.id);
 assert.equal(new Set(grouped).size,grouped.length);assert.deepEqual([...grouped].sort(),[...detail].sort());
});

test('platform grouping leaves profit and cash flow untouched, hides zero platforms without deleting the nodes',async()=>{
 const {hsbcCny}=await fixture();
 assert.equal((await record({kind:'income',account_id:hsbcCny.id,amount:'1200',category:'income.salary'})).status,'posted');
 assert.equal((await record({kind:'expense',account_id:hsbcCny.id,amount:'200',category:'expense.food'})).status,'posted');
 const empty=await acct('招商银行空户');const r=await reports(pool,'2026-11');
 assert.equal(r.income_statement.total_income,'1200.00');assert.equal(r.income_statement.total_expenses,'200.00');
 assert.equal(r.income_statement.net_income,'1000.00');assert.equal(r.cash_flow.net_change,'1000.00');assert.equal(r.cash_flow.reconciled,true);
 // A zero-balance platform is hidden from the cards but its underlying node survives untouched.
 assert.equal(card(r.balance_sheet.assets,'招商银行'),undefined);
 assert.ok(r.balance_sheet.account_details.assets.some(a=>a.id===empty.id));
 assert.ok((await listAccounts(pool)).some(a=>a.id===empty.id));
 assert.equal(total(r.balance_sheet.assets),r.balance_sheet.total_assets);
 assert.equal(r.balance_sheet.balanced,true);
});

test('system accounts never leak into platform cards, and every grouped node is a real asset or liability',async()=>{
 await fixture();const r=await reports(pool,'2026-11');
 // Income/expense/equity system nodes must stay out of the balance sheet; this invariant is what keeps
 // the aggregation exact, because platformOptions() skips any account carrying a system_key.
 for(const row of r.balance_sheet.account_details.assets.concat(r.balance_sheet.account_details.liabilities)){
  assert.equal(row.system_key,null,`系统科目混入资产负债: ${row.name}`);
  assert.ok(['asset','liability'].includes(row.account_group));
 }
 const systemRows=(await pool.query("SELECT name,account_group FROM cfo_accounts WHERE system_key IS NOT NULL")).rows;
 assert.ok(systemRows.length>0);
 assert.ok(!systemRows.some(a=>['asset','liability'].includes(a.account_group)),'出现了 system_key 资产/负债科目，平台聚合会静默漏账');
 assert.deepEqual(groupPlatformBalances(systemRows.map(a=>({...a,id:randomUUID(),balance:'1',system_key:'x'}))),[]);
});

test('opening confirmation is reported per platform and a single unconfirmed member keeps the platform pending',async()=>{
 const {hsbcCny}=await fixture();
 let r=await reports(pool,'2026-11');assert.equal(card(r.balance_sheet.assets,'HSBC').opening_confirmed,true);
 // A newly added card on an already-confirmed platform must drag the whole platform back to pending.
 const extra=await acct('汇丰第二张卡');
 assert.equal((await record({kind:'income',account_id:extra.id,amount:'500',category:'income.other'})).status,'posted');
 r=await reports(pool,'2026-11');const hsbc=card(r.balance_sheet.assets,'HSBC');
 assert.equal(hsbc.member_count,5);assert.equal(hsbc.opening_confirmed,false,'有成员期初未确认时平台不应显示已确认');
 assert.ok(r.warnings.some(w=>w.includes('期初余额尚未确认')&&w.includes('HSBC')));
 assert.equal(total(r.balance_sheet.assets),r.balance_sheet.total_assets);
 assert.equal(card(r.balance_sheet.assets,'中信银行').opening_confirmed,true);
 assert.ok(hsbcCny.id);
});

test('switching the display currency rescales platform totals exactly and never rewrites the stored journal',async()=>{
 await fixture();
 const cny=await reports(pool,'2026-11');
 const stored=(await pool.query('SELECT sum(cny_cents)::text AS cents FROM cfo_lines')).rows[0].cents;
 const usd=await reports(pool,'2026-11',{currency:'USD',rate:'0.14'});
 assert.equal(usd.currency,'USD');
 // Aggregation stays exact in the display currency.
 assert.equal(total(usd.balance_sheet.assets),usd.balance_sheet.total_assets);
 assert.equal(total(usd.balance_sheet.liabilities),usd.balance_sheet.total_liabilities);
 assert.equal(usd.balance_sheet.balanced,true);
 assert.deepEqual(usd.balance_sheet.assets.map(a=>a.currency),usd.balance_sheet.assets.map(()=>'USD'));
 // Converted totals track the CNY book within rounding, and membership is unchanged.
 assert.ok(new Decimal(usd.balance_sheet.total_assets).minus(new Decimal(cny.balance_sheet.total_assets).mul('0.14')).abs().lte('1'));
 assert.equal(card(usd.balance_sheet.assets,'HSBC').member_count,4);
 assert.deepEqual([...card(usd.balance_sheet.assets,'HSBC').member_ids].sort(),[...card(cny.balance_sheet.assets,'HSBC').member_ids].sort());
 // Native per-node amounts and the stored journal are presentation-independent.
 const native=r=>r.balance_sheet.account_details.assets.map(a=>a.native_balance+' '+a.currency).sort();
 assert.deepEqual(native(usd),native(cny));
 assert.equal((await pool.query('SELECT sum(cny_cents)::text AS cents FROM cfo_lines')).rows[0].cents,stored);
});

test('broker-managed nodes group under their own platform and keep their anti-duplication hold',async()=>{
 await fixture();
 // Mirror the nodes lib/broker-ledger.mjs creates: investment asset, reported liability and the rounding
 // remainder, all in USD, one cfo_broker_accounts row each.
 const managed={};
 for(const [broker,label,role,kind,group] of [['moomoo','moomoo','asset','investment','asset'],['moomoo','moomoo','liability','other_liability','liability'],
   ['moomoo','moomoo','rounding','investment','asset'],['tiger','Tiger','asset','investment','asset'],['futubull','富途','rounding','investment','asset']]){
  const name=label+({asset:' · 券商投资资产',liability:' · 券商已报告负债',rounding:' · 券商分位尾差'}[role]);
  const a=(await pool.query("INSERT INTO cfo_accounts(name,kind,account_group,currency,is_cash,opening_confirmed) VALUES($1,$2,$3,'USD',false,true) RETURNING *",[name,kind,group])).rows[0];
  await pool.query('INSERT INTO cfo_broker_accounts(broker,role,account_id) VALUES($1,$2,$3)',[broker,role,a.id]);
  managed[broker+':'+role]=a;
 }
 // Broker nodes join the broker's own platform instead of inventing one card per node, and the
 // rounding remainder lands on that same platform rather than floating on its own.
 const accounts=await listAccounts(pool),options=platformOptions(accounts);
 assert.equal(platformName(managed['moomoo:asset']),'moomoo');
 assert.equal(platformName(managed['futubull:rounding']),'富途');
 const moomooAsset=options.find(o=>o.platform_name==='moomoo'&&o.side==='asset');
 assert.equal(moomooAsset.members.length,3,'moomoo 的投资资产、分位尾差应与原有节点同属一张资产卡片');
 assert.equal(options.filter(o=>o.platform_name==='moomoo').length,2);
 assert.ok(options.find(o=>o.platform_name==='moomoo'&&o.side==='liability'),'券商已报告负债不能被藏进资产侧');
 assert.ok(!options.some(o=>o.platform_name.includes('券商')),'券商节点不应各自成为一个平台');
 // A draft naming only the platform must reuse the managed node, even for a currency it does not hold,
 // rather than quietly creating a parallel node outside broker control.
 const before=(await listAccounts(pool)).length;
 const e=await record({kind:'income',platform_name:'moomoo',currency:'CNY',amount:'100',category:'income.other'});
 assert.equal(e.payload.account_id,managed['moomoo:asset'].id,'未绑定到券商管理的节点，可能绕过防重');
 assert.equal((await listAccounts(pool)).length,before,'券商平台下不应新建并行节点');
 const r=await reports(pool,'2026-11');
 assert.equal(total(r.balance_sheet.assets),r.balance_sheet.total_assets);
 assert.equal(total(r.balance_sheet.liabilities),r.balance_sheet.total_liabilities);
 assert.equal(r.balance_sheet.balanced,true);
});

test('platform selection binds new drafts to the matching native node without rebinding existing ones',async()=>{
 const {hsbcCny,hsbcUsd,hsbcSgd,tiger}=await fixture();
 const before=(await listAccounts(pool)).length;
 // A draft naming only the platform and a currency that already has exactly one node reuses that node.
 const usd=await record({kind:'income',platform_name:'汇丰',currency:'USD',amount:'300',category:'income.other',fx_rate:'7.2',fx_source:'synthetic manual quote'});
 assert.equal(usd.status,'posted');assert.equal(usd.payload.account_id,hsbcUsd.id);
 assert.equal((await listAccounts(pool)).length,before,'复用已有原币节点时不应新建账户');
 // A currency the platform has no node for creates one bound to that platform, leaving the others alone.
 const eur=await record({kind:'income',platform_name:'汇丰',currency:'EUR',amount:'100',category:'income.other',fx_rate:'7.8',fx_source:'synthetic manual quote'});
 assert.equal(eur.status,'posted');
 const accounts=await listAccounts(pool),created=accounts.find(a=>a.id===eur.payload.account_id);
 assert.equal(accounts.length,before+1);assert.equal(created.currency,'EUR');assert.equal(platformName(created),'HSBC');
 assert.ok(![hsbcCny.id,hsbcUsd.id,hsbcSgd.id].includes(created.id),'跨币种草稿不应改绑已有节点');
 for(const [a,currency] of [[hsbcCny,'CNY'],[hsbcUsd,'USD'],[hsbcSgd,'SGD'],[tiger,'USD']])
  assert.equal(accounts.find(x=>x.id===a.id).currency,currency,'已有节点币种被改动');
 // The platform dropdown offers one entry per platform and side, not one per currency or card.
 const options=platformOptions(accounts);
 assert.equal(options.filter(o=>o.platform_name==='HSBC'&&o.side==='asset').length,1);
 assert.equal(options.filter(o=>o.platform_name==='HSBC'&&o.side==='liability').length,1);
 assert.equal(options.filter(o=>o.platform_name==='HSBC'&&o.side==='asset')[0].members.length,5);
 assert.ok(options.length<accounts.length,'平台下拉项不应多于账户数');
 const r=await reports(pool,'2026-11');assert.equal(total(r.balance_sheet.assets),r.balance_sheet.total_assets);
});
