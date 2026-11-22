// Standing judgements the user made once. The sharpest case: the salary account
// pays into two other accounts every month and reuses the SALA memo, so the same
// wage would otherwise be booked three times, inventing money as it goes.
import {test,after} from 'node:test';import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {connectDatabase} from '../lib/db.mjs';
import {matchRule,listRules,addRule,setRuleEnabled,applyRulesTo} from '../lib/rules.mjs';

if(!process.env.DATABASE_URL)process.env.DATABASE_URL=(await readFile('.env.test','utf8')).trim().split('DATABASE_URL=')[1];
if(!new URL(process.env.DATABASE_URL).pathname.endsWith('_test'))throw new Error('Isolated test database required');
const pool=await connectDatabase();
after(()=>pool.end());

const RULES=[
 {id:'r-sala',enabled:true,priority:10,pattern:'SALA',account_pattern:'DBS|UOB',applies_to:'income',action:'skip',reason:'内部调度'},
 {id:'r-gojek',enabled:true,priority:100,pattern:'Gojek',applies_to:'expense',action:'categorize',category:'expense.commute',reason:'通勤'},
 {id:'r-off',enabled:false,priority:20,pattern:'支付宝',applies_to:'expense',action:'skip',reason:'停用中'},
];

test('the same SALARY memo is income on the salary account and a transfer everywhere else',()=>{
 const on=n=>matchRule(RULES,{kind:'income',description:'SALARY NOV 2026',account_name:n});
 assert.equal(on('DBS Multiplier')?.id,'r-sala');
 assert.equal(on('UOB One Account')?.id,'r-sala');
 assert.equal(on('HSBC Everyday Global'),null,'真工资账户上的 SALARY 不能被当成内部调度跳过');
});

test('a merchant rule files the charge without being asked again',()=>{
 assert.equal(matchRule(RULES,{kind:'expense',merchant:'Gojek',account_name:'UOB Visa'})?.category,'expense.commute');
 assert.equal(matchRule(RULES,{kind:'expense',merchant:'GOJEK SG PTE',account_name:'DBS'})?.category,'expense.commute');
 // Direction matters: a refund from the same merchant is not a commuting cost.
 assert.equal(matchRule(RULES,{kind:'income',merchant:'Gojek',account_name:'DBS'}),null);
});

test('a disabled rule does nothing, and nothing matches on an empty description',()=>{
 assert.equal(matchRule(RULES,{kind:'expense',merchant:'支付宝',account_name:'招商银行'}),null);
 assert.equal(matchRule(RULES,{kind:'expense',account_name:'DBS'}),null);
});

test('applying rules re-files what it knows and drops what is already recorded elsewhere',async()=>{
 await pool.query("DELETE FROM cfo_rules WHERE reason LIKE '[测试]%'");
 const sala=await addRule(pool,{pattern:'QQINTERNAL',account_pattern:'ZZDBS',applies_to:'income',action:'skip',reason:'[测试] 内部调度',priority:5});
 await addRule(pool,{pattern:'QQRIDEHAIL',applies_to:'expense',action:'categorize',category:'expense.commute',reason:'[测试] 通勤',priority:5});
 const items=[
  {source_ref:'a',payload:{kind:'income',description:'QQINTERNAL NOV',platform_name:'ZZDBS',amount:'8000'}},
  {source_ref:'b',payload:{kind:'income',description:'QQINTERNAL NOV',platform_name:'ZZHSBC',amount:'8000'}},
  {source_ref:'c',payload:{kind:'expense',merchant:'QQRIDEHAIL',category:'expense.other',amount:'12'}},
  {source_ref:'d',payload:{kind:'expense',merchant:'Unknown Cafe',category:'expense.food',amount:'30'}},
 ];
 const out=await applyRulesTo(pool,items);
 assert.deepEqual(out.skipped.map(s=>s.source_ref),['a'],'只有 ZZDBS 上那笔该被跳过');
 assert.deepEqual(out.kept.map(k=>k.source_ref),['b','c','d']);
 assert.equal(out.kept.find(k=>k.source_ref==='c').payload.category,'expense.commute','规则应覆盖模型给的科目');
 assert.equal(out.kept.find(k=>k.source_ref==='d').payload.category,'expense.food','没有规则的保持原样');
 assert.deepEqual(out.recategorized.map(r=>[r.source_ref,r.from,r.to]),[['c','expense.other','expense.commute']]);
 // Hits are counted so a rule that fires unexpectedly often can be found.
 const after=(await listRules(pool)).find(r=>r.id===sala.id);
 assert.equal(after.hit_count,1);
 await setRuleEnabled(pool,sala.id,false);
 const off=await applyRulesTo(pool,[items[0]]);
 assert.equal(off.skipped.length,0,'停用后不该再跳过');
 await pool.query("DELETE FROM cfo_rules WHERE reason LIKE '[测试]%'");
});

test('a categorize rule without a category is refused outright',async()=>{
 await assert.rejects(()=>addRule(pool,{pattern:'ZZNOCAT',action:'categorize',reason:'[测试] 缺科目'}));
 await pool.query("DELETE FROM cfo_rules WHERE reason LIKE '[测试]%'");
});
