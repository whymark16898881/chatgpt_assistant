// The list exists so the same judgement is asked for once. These tests hold it
// to that: identical lines collapse into one question, the biggest money is on
// top whatever the repeat count, answering writes a rule and re-runs the
// backlog, and an answered question does not come back.
import {test,after}from 'node:test';import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm}from 'node:fs/promises';import {tmpdir}from 'node:os';import path from 'node:path';
import {randomUUID}from 'node:crypto';
import {connectDatabase}from '../lib/db.mjs';
import {documentService}from '../lib/documents.mjs';
import {recordEvent}from '../lib/ledger.mjs';
import {reports}from '../lib/reports.mjs';
import {addRule}from '../lib/rules.mjs';
import {applyTransactionAction,previewTransactionAction}from '../lib/transaction-lifecycle.mjs';
import {buildClarifications,merchantKey,clarifications,answerClarification}from '../lib/clarifications.mjs';

if(!process.env.DATABASE_URL)process.env.DATABASE_URL=(await readFile('.env.test','utf8')).trim().split('DATABASE_URL=')[1];
if(!new URL(process.env.DATABASE_URL).pathname.endsWith('_test'))throw new Error('Isolated test database required');
const pool=await connectDatabase(),dir=await mkdtemp(path.join(tmpdir(),'cfo-clarify-'));
const docs=documentService(pool,dir);
after(async()=>{await pool.query("DELETE FROM cfo_rules WHERE reason LIKE '[测试]%'");await pool.end();await rm(dir,{recursive:true,force:true});});

const reset=async()=>{
 await pool.query('TRUNCATE cfo_presentation_rates,cfo_audit,cfo_event_sources,cfo_lines,cfo_entries,cfo_events,cfo_documents RESTART IDENTITY CASCADE; DELETE FROM cfo_accounts WHERE system_key IS NULL');
 // Seeded rules stay: they are nobody's personal data and other suites rely on
 // them. Only the rules a test writes are cleaned up.
 await pool.query("DELETE FROM cfo_rules WHERE reason LIKE '[测试]%'");
};
async function draft(payload={}){
 const doc=await docs.saveBytes({file_name:payload.__file||'synthetic-statement.png'},{bytes:Buffer.from(randomUUID()),mime:'image/png'});
 const {__file,...rest}=payload;
 return(await recordEvent(pool,{document_id:doc.id,source_ref:randomUUID(),request_key:randomUUID(),auto_post:false,
  payload:{kind:'expense',currency:'CNY',date:'2026-11-03',amount:'12.34',description:'synthetic',...rest}})).event;
}
const row=(payload,extra={})=>({id:extra.id||randomUUID(),revision:0,payload:{date:'2026-11-03',...payload},issues:[],filename:extra.filename||null});
const plainConvert=(amount,from)=>from==='CNY'?amount:from==='SGD'?(Number(amount)*5).toFixed(2):null;

test('ten small charges and one large one become two questions, ranked by money not by repeats',()=>{
 const drafts=[
  ...Array.from({length:10},()=>row({kind:'expense',merchant:'ZZRIDE *SG PTE LTD 4471',amount:'5.00',currency:'CNY',category:'expense.other'})),
  row({kind:'expense',merchant:'ZZCLINIC',amount:'2400.00',currency:'CNY',category:'expense.other'}),
 ];
 const out=buildClarifications({drafts,convert:plainConvert});
 assert.equal(out.blocking.length,2);
 assert.equal(out.blocking[0].impact_amount,'2400.00','单笔大额排在重复十次的小额前面');
 assert.equal(out.blocking[1].draft_count,10,'十笔只问一次');
 assert.equal(out.blocking[1].suggested_pattern,'zzride');
});

test('the same merchant written four ways is still one question, and a rule already given removes it',()=>{
 const spellings=['ZZRIDE *SG PTE LTD 4471','zzride sg','ZZRIDE','ZZRIDE SINGAPORE 99'];
 const drafts=spellings.map(merchant=>row({kind:'expense',merchant,amount:'5.00',currency:'CNY'}));
 const out=buildClarifications({drafts,convert:plainConvert});
 assert.equal(out.blocking.length,1);
 assert.equal(out.blocking[0].variants.length,4,'把实际写法列给用户看，别让他盲答');
 // Every spelling contains the proposed pattern, so one rule really does cover them.
 for(const s of spellings)assert.ok(s.toLowerCase().includes(out.blocking[0].suggested_pattern));
 const settled=buildClarifications({drafts,convert:plainConvert,
  rules:[{id:'r',enabled:true,pattern:'zzride',applies_to:'expense',action:'categorize',category:'expense.commute',reason:'x'}]});
 assert.equal(settled.blocking.length,0,'答过的不再出现');
});

test('direction is part of the question: a refund is not the expense that was just filed',()=>{
 const out=buildClarifications({convert:plainConvert,drafts:[
  row({kind:'expense',merchant:'ZZRIDE',amount:'5.00',currency:'CNY'}),
  row({kind:'income',merchant:'ZZRIDE refund',amount:'5.00',currency:'CNY'}),
 ]});
 assert.equal(out.blocking.length,2);
 assert.deepEqual(out.blocking.map(q=>q.kind).sort(),['expense','income']);
});

test('one missing field per source is one question; drafts that already carry the field are left alone',()=>{
 const out=buildClarifications({convert:plainConvert,drafts:[
  row({kind:'expense',merchant:'ZZSHOP A',amount:'10.00'},{filename:'bank-a.pdf'}),
  row({kind:'expense',merchant:'ZZSHOP B',amount:'20.00'},{filename:'bank-a.pdf'}),
  row({kind:'expense',merchant:'ZZSHOP C',amount:'30.00',currency:'SGD'},{filename:'bank-a.pdf'}),
  row({kind:'expense',merchant:'ZZSHOP D',amount:'40.00',currency:'CNY',settlement:'unknown'}),
 ]});
 const currencyQuestions=out.blocking.filter(q=>q.field==='currency');
 assert.equal(currencyQuestions.length,1);
 assert.equal(currencyQuestions[0].draft_count,2,'只问缺币种的那两笔');
 assert.equal(currencyQuestions[0].impact_amount,'0.00');
 assert.equal(currencyQuestions[0].amount_unknown_count,2,'币种未知就不折算，更不按零处理');
 const settlement=out.blocking.filter(q=>q.field==='settlement');
 assert.equal(settlement.length,1);
 assert.equal(settlement[0].draft_count,1);
 // The same two lines must not also be asked about as a merchant: choosing a
 // category would not unblock them, and one problem is one question.
 assert.equal(out.blocking.filter(q=>q.type==='merchant'&&q.variants.some(v=>v.merchant.startsWith('ZZSHOP A'))).length,0);
 assert.equal(out.blocking.filter(q=>q.type==='merchant').map(q=>q.match_key).sort().join(','),'zzshop',
  '只有资料齐全、仅差归类的才问科目');
});

test('a merchant seen more than once with no rule is listed as coming back, not as stuck',()=>{
 const posted=[0,1,2].map(()=>row({kind:'expense',merchant:'ZZSUBSCRIPTION',amount:'88.00',currency:'CNY'}));
 const out=buildClarifications({posted,convert:plainConvert});
 assert.equal(out.blocking.length,0);
 assert.equal(out.preventive.length,1);
 assert.equal(out.preventive[0].posted_count,3);
 assert.equal(buildClarifications({posted:[posted[0]],convert:plainConvert}).preventive.length,0,'只出现一次的不打扰用户');
});

test('question ids are stable, so an answer applies to the question that was asked',()=>{
 const drafts=[row({kind:'expense',merchant:'ZZRIDE',amount:'5.00',currency:'CNY'})];
 assert.equal(buildClarifications({drafts,convert:plainConvert}).blocking[0].id,
  buildClarifications({drafts,convert:plainConvert}).blocking[0].id);
});

test('merchant keys ignore corporate noise and reference numbers, and refuse to speak for a single character',()=>{
 assert.equal(merchantKey('ZZRIDE *SG PTE LTD 4471'),'zzride');
 assert.equal(merchantKey('  ZZRIDE-SINGAPORE '),'zzride');
 assert.equal(merchantKey('星巴克(国贸店)'),'星巴克');
 assert.equal(merchantKey('123456'),null);
 assert.equal(merchantKey('X 99'),null);
 assert.equal(merchantKey(''),null);
});

test('answering once files the whole backlog and the question does not come back',async()=>{
 await reset();
 const drafts=[];
 for(const amount of ['5.00','6.00','7.00'])drafts.push(await draft({merchant:'ZZRIDE *SG '+amount,amount,category:'expense.other'}));
 const before=await clarifications(pool);
 const question=before.blocking.find(q=>q.match_key==='zzride');
 assert.ok(question,'三笔同商户应合成一条问题');
 assert.equal(question.draft_count,3);
 const out=await answerClarification(pool,{question_id:question.id,
  rule:{pattern:'zzride',action:'categorize',category:'expense.commute',reason:'[测试] 用户确认属于通勤'}});
 assert.equal(out.applied.posted,3,'一次回答，三笔积压当场入账');
 assert.equal(out.applied.still_draft,0);
 assert.equal(out.rule.category,'expense.commute');
 assert.equal(out.rule.applies_to,'expense','方向跟着问题走，不扩大到收入');
 const report=await reports(pool,'2026-11');
 assert.equal(report.income_statement.total_expenses,'18.00');
 assert.ok(report.income_statement.expenses.some(l=>l.name==='通勤交通'),'入的是用户选的科目');
 const after=await clarifications(pool);
 assert.equal(after.blocking.filter(q=>q.match_key==='zzride').length,0,'答过的问题不再出现');
 assert.equal(after.rules.find(r=>r.id===out.rule.id).hit_count,3,'命中次数要记上，答得过宽日后才查得出来');
 for(const d of drafts)assert.equal((await pool.query('SELECT status FROM cfo_events WHERE id=$1',[d.id])).rows[0].status,'posted');
});

test('a skip answer sets the backlog aside reversibly instead of inventing a second record of it',async()=>{
 await reset();
 const d=await draft({merchant:'ZZWALLETMIRROR 01',amount:'30.00',category:'expense.other'});
 const question=(await clarifications(pool)).blocking.find(q=>q.match_key==='zzwalletmirror');
 const out=await answerClarification(pool,{question_id:question.id,
  rule:{pattern:'zzwalletmirror',action:'skip',reason:'[测试] 同一笔已在钱包账单记过'}});
 assert.equal(out.applied.set_aside,1);
 const stored=(await pool.query('SELECT status,deleted_at,deleted_status,payload FROM cfo_events WHERE id=$1',[d.id])).rows[0];
 assert.ok(stored.deleted_at,'跳过的是软删除，不是凭空消失');
 assert.equal(stored.deleted_status,'draft');
 assert.equal(stored.payload.amount,'30.00','原始资料保留');
 assert.equal((await reports(pool,'2026-11')).income_statement.total_expenses,'0.00','跳过不产生金额');
 // Reversible: a wrong answer can be taken back from the ledger.
 const preview=await previewTransactionAction(pool,{action:'restore',event_ids:[d.id]});
 await applyTransactionAction(pool,{action:'restore',event_ids:[d.id],confirmation_token:preview.confirmation_token});
 assert.equal((await pool.query('SELECT status FROM cfo_events WHERE id=$1',[d.id])).rows[0].status,'draft');
});

test('a narrowed pattern only touches the lines it really matches, and says so',async()=>{
 await reset();
 const kept=await draft({merchant:'ZZCAFE EAST',amount:'11.00',category:'expense.other'});
 await draft({merchant:'ZZCAFE WEST',amount:'12.00',category:'expense.other'});
 const question=(await clarifications(pool)).blocking.find(q=>q.match_key==='zzcafe');
 assert.equal(question.draft_count,2);
 const out=await answerClarification(pool,{question_id:question.id,
  rule:{pattern:'ZZCAFE EAST',action:'categorize',category:'expense.food',reason:'[测试] 只认东店'}});
 assert.equal(out.applied.posted,1);
 assert.equal(out.applied.not_matched,1,'没覆盖到的要报出来，不能悄悄改写');
 assert.equal((await pool.query('SELECT status FROM cfo_events WHERE id=$1',[kept.id])).rows[0].status,'posted');
 assert.equal((await reports(pool,'2026-11')).income_statement.total_expenses,'11.00');
});

test('one answer settles a missing currency for a whole source without touching other sources',async()=>{
 await reset();
 const a=await draft({merchant:'ZZSHOPONE',amount:'10.00',currency:undefined,platform_name:'ZZBANK'});
 const b=await draft({merchant:'ZZSHOPTWO',amount:'20.00',currency:undefined,platform_name:'ZZBANK'});
 const other=await draft({merchant:'ZZSHOPTHREE',amount:'30.00',currency:undefined,platform_name:'ZZOTHERBANK'});
 const question=(await clarifications(pool)).blocking.find(q=>q.field==='currency'&&q.scope_label==='ZZBANK');
 assert.equal(question.draft_count,2);
 const out=await answerClarification(pool,{question_id:question.id,field:{field:'currency',value:'CNY'}});
 assert.equal(out.applied.posted,2);
 assert.equal((await reports(pool,'2026-11')).income_statement.total_expenses,'30.00');
 for(const e of [a,b])assert.equal((await pool.query('SELECT status FROM cfo_events WHERE id=$1',[e.id])).rows[0].status,'posted');
 assert.equal((await pool.query('SELECT status FROM cfo_events WHERE id=$1',[other.id])).rows[0].status,'draft','别的来源不受影响');
});

test('an answer to a question that no longer exists is refused, and a wrong-shaped answer too',async()=>{
 await reset();
 await draft({merchant:'ZZGYM CENTRAL',amount:'99.00',category:'expense.other'});
 const question=(await clarifications(pool)).blocking.find(q=>q.match_key==='zzgym');
 await assert.rejects(()=>answerClarification(pool,{question_id:'merchant:expense:deadbeefdead',
  rule:{pattern:'zzgym',action:'categorize',category:'expense.food',reason:'[测试] 不存在的问题'}}),/不在清单/);
 await assert.rejects(()=>answerClarification(pool,{question_id:question.id,field:{field:'currency',value:'CNY'}}),/不是这个字段/);
 await assert.rejects(()=>answerClarification(pool,{question_id:question.id,
  rule:{pattern:'zzgym',action:'categorize',reason:'[测试] 缺科目'}}),/科目/);
 assert.equal((await pool.query("SELECT count(*)::int AS n FROM cfo_events WHERE status='draft'")).rows[0].n,1);
});

test('a line already covered by a standing rule never reaches the clarification list',async()=>{
 await reset();
 await addRule(pool,{pattern:'ZZPHONEBILL',applies_to:'expense',action:'categorize',category:'expense.telecom',reason:'[测试] 话费'});
 await draft({merchant:'ZZPHONEBILL NOV',amount:'59.00',category:'expense.other'});
 await draft({merchant:'ZZUNKNOWNSHOP',amount:'59.00',category:'expense.other'});
 const out=await clarifications(pool);
 assert.equal(out.blocking.filter(q=>q.match_key==='zzphonebill').length,0);
 assert.equal(out.blocking.filter(q=>q.match_key==='zzunknownshop').length,1);
});

test('the list names no person, account holder or employer of its own accord',async()=>{
 await reset();
 const out=await clarifications(pool);
 assert.equal(out.schema,'cfo_clarifications/v1');
 // Everything shown comes from the user's own database rows; the module itself
 // ships no names. This repository is public.
 const source=await readFile('lib/clarifications.mjs','utf8');
 assert.ok(!/@|雇主|工资账户名/.test(source.replace(/\x00/g,'')),'模块本身不得写入任何个人信息');
});
