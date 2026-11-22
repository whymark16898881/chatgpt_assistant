'use client';
// 待澄清：把同一个根问题下的多笔交易合成一条，回答一次就固化成规则并重算积压。
// 这里不做逐笔补充——那仍然在「资料收件箱」里，两条路互不干扰。
import {useDisplayCurrency,currencySymbol,formatAmount} from './display-currency';
import {useEffect,useState} from 'react';

type Variant={merchant:string;count:number};
type Sample={event_id:string;description:string;merchant:string|null;date:string|null;amount:string|null;currency:string|null;filename:string|null;issues:string[]};
type Option={value:string;label:string};
type Question={id:string;type:'merchant'|'field';kind:'income'|'expense'|null;field:string|null;field_label?:string;scope_label?:string;options:Option[]|null;match_key?:string;suggested_pattern?:string;title:string;question:string;impact_amount:string;impact_currency:string;amount_unknown_count:number;draft_count:number;posted_count:number;blocking:boolean;variants:Variant[];samples:Sample[]};
type Rule={id:string;pattern:string;account_pattern:string|null;applies_to:string;action:string;category:string|null;reason:string;enabled:boolean;hit_count:number;last_hit_at:string|null};
type Data={currency:string;rate_date:string|null;blocking:Question[];preventive:Question[];totals:{draft_count:number;blocking_count:number;active_rules:number};rules:Rule[];note:string};
type Category={key:string;name:string;account_group:string};
type Answered={applied:{total:number;posted:number;still_draft:number;set_aside:number;not_matched:number;failed:number;changed:number};results:{event_id:string;outcome:string;reason?:string;issues?:string[]}[];rule:Rule|null};

const directions:Record<string,string>={income:'收入',expense:'支出'};
const outcomes:Record<string,string>={posted:'已入账',still_draft:'仍待处理',set_aside:'已搁置',not_matched:'规则未覆盖',failed:'未成功',changed:'记录已变化'};
const hints:Record<string,string>={set_aside:'已移到交易账本的「已删除」，资料保留，可随时恢复',not_matched:'匹配词没覆盖到这一笔，仍留在待处理',still_draft:'资料仍不齐，保留为待处理',changed:'这笔在回答期间被改动过，本次未处理'};
async function call(url:string,body?:unknown){
 const r=await fetch(url,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 let d;try{d=await r.json();}catch{throw Object.assign(new Error('服务暂时不可用，请稍后重试'),{status:r.status});}
 if(!r.ok)throw Object.assign(new Error(d.error||'请求未完成'),{status:r.status});
 return d;
}

export default function ClarificationsPanel({categories,onSessionExpired,onFinancialChange}:{categories:Category[];onSessionExpired:()=>void;onFinancialChange:()=>Promise<void>}){
 const {currency,snapshot}=useDisplayCurrency(),target=currency==='CNY'||snapshot?.id?currency:'CNY';
 const [data,setData]=useState<Data|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState('');
 const [open,setOpen]=useState(''),[draftAnswer,setDraftAnswer]=useState<{pattern:string;mode:'categorize'|'skip';category:string;reason:string;value:string}|null>(null);
 const [tick,setTick]=useState(0),[result,setResult]=useState<Answered|null>(null);
 const symbol=currencySymbol(data?.currency||target);
 useEffect(()=>{
  let current=true;setError('');
  void call('/api/clarifications?currency='+target).then(d=>{if(current)setData(d);})
   .catch(e=>{if(!current)return;if(e.status===401)onSessionExpired();else setError(e.message);});
  return()=>{current=false;};
 },[target,tick,onSessionExpired]);

 function start(q:Question){
  setOpen(q.id);setResult(null);setError('');
  setDraftAnswer({pattern:q.suggested_pattern||'',mode:'categorize',category:'',
   reason:'',value:q.options?q.options[0].value:''});
 }
 async function send(q:Question){
  if(!draftAnswer)return;
  setBusy(q.id);setError('');setNotice('');
  try{
   const body=q.type==='merchant'
    ?{question_id:q.id,rule:{pattern:draftAnswer.pattern.trim(),action:draftAnswer.mode,
      ...(draftAnswer.mode==='categorize'?{category:draftAnswer.category}:{}),
      reason:draftAnswer.reason.trim()||defaultReason(q,draftAnswer,categories)}}
    :{question_id:q.id,field:{field:q.field,value:draftAnswer.value}};
   const out:Answered=await call('/api/clarifications/answer',body);
   setResult(out);setOpen('');setDraftAnswer(null);
   setNotice(summarize(out));
   setTick(t=>t+1);await onFinancialChange();
  }catch(e){const x=e as Error&{status?:number};if(x.status===401)onSessionExpired();else setError(x.message);}
  finally{setBusy('');}
 }
 async function disable(rule:Rule){
  setBusy(rule.id);setError('');setNotice('');
  try{await call('/api/rules/'+rule.id+'/disable',{});setNotice('已停用规则「'+rule.pattern+'」，相关问题会重新出现在清单上');setTick(t=>t+1);}
  catch(e){const x=e as Error&{status?:number};if(x.status===401)onSessionExpired();else setError(x.message);}
  finally{setBusy('');}
 }

 function card(q:Question){
  const editing=open===q.id&&draftAnswer,options=categories.filter(c=>c.account_group===q.kind);
  return <article className="clarify-card" key={q.id}>
   <div className="clarify-head">
    <div><b>{q.title}</b><small>{q.question}</small></div>
    <div className="numeric"><strong>{q.impact_amount==='0.00'&&q.amount_unknown_count>0?'金额待定':symbol+' '+formatAmount(q.impact_amount)}</strong>
     <small>{q.draft_count>0?`${q.draft_count} 笔待处理`:`已入账 ${q.posted_count} 笔`}
      {q.draft_count>0&&q.posted_count>0?` · 另有已入账 ${q.posted_count} 笔`:''}
      {q.amount_unknown_count>0?` · ${q.amount_unknown_count} 笔金额待定`:''}</small></div>
   </div>
   {q.variants.length>0&&<div className="clarify-variants">{q.variants.map(v=><span key={v.merchant}>{v.merchant}{v.count>1?` ×${v.count}`:''}</span>)}</div>}
   {q.samples.length>0&&<details className="clarify-samples"><summary>看这 {q.draft_count} 笔</summary>
    <ul>{q.samples.map(s=><li key={s.event_id}>{s.date||'日期待补'} · {s.amount??'金额待补'} {s.currency||''} · {s.merchant||s.description||'无描述'}
     {s.filename?<small>{s.filename}</small>:null}{s.issues.length>0?<small className="issue">{s.issues.join('；')}</small>:null}</li>)}</ul>
    {q.draft_count>q.samples.length&&<p className="muted">另有 {q.draft_count-q.samples.length} 笔同类，答一次一并处理。</p>}</details>}
   {!editing
    ?<div className="clarify-actions"><button className="secondary" onClick={()=>start(q)}>回答这一条</button></div>
    :<div className="clarify-form">
      {q.type==='merchant'
       ?<>
        <label>规则匹配词<input value={draftAnswer!.pattern} onChange={e=>setDraftAnswer(d=>d&&{...d,pattern:e.target.value})}/>
         <small className="muted">商户、摘要或备注里含有这个词就按本条处理；改窄了只会少覆盖几笔，不会改错账。</small></label>
        <label>怎么处理<select value={draftAnswer!.mode} onChange={e=>setDraftAnswer(d=>d&&{...d,mode:e.target.value as 'categorize'|'skip'})}>
         <option value="categorize">归到一个科目</option>
         <option value="skip">不算收支（已在其他材料记过，或是本人账户间调拨）</option></select></label>
        {draftAnswer!.mode==='categorize'&&<label>科目<select value={draftAnswer!.category} onChange={e=>setDraftAnswer(d=>d&&{...d,category:e.target.value})}>
         <option value="">请选择{directions[q.kind||'expense']}科目</option>
         {options.map(c=><option key={c.key} value={c.key}>{c.name}</option>)}</select></label>}
        <label>依据（会记在规则上，日后可复核）<input value={draftAnswer!.reason} placeholder={defaultReason(q,draftAnswer!,categories)} onChange={e=>setDraftAnswer(d=>d&&{...d,reason:e.target.value})}/></label>
        {draftAnswer!.mode==='skip'&&<p className="muted">这 {q.draft_count} 笔会移到「已删除」，资料保留，可在交易账本恢复；今后同样的材料会在入账前就被挡下。</p>}
       </>
       :<>
        <label>{q.field_label}
         {q.options
          ?<select value={draftAnswer!.value} onChange={e=>setDraftAnswer(d=>d&&{...d,value:e.target.value})}>{q.options.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}</select>
          :<input type="date" min="2026-11-01" value={draftAnswer!.value} onChange={e=>setDraftAnswer(d=>d&&{...d,value:e.target.value})}/>}</label>
        <p className="muted">这 {q.draft_count} 笔会统一按此补充并尝试入账；仍有其他缺项的会留在待处理。字段补充不会生成规则。</p>
       </>}
      <div className="clarify-actions">
       <button className="text-button" onClick={()=>{setOpen('');setDraftAnswer(null);}}>取消</button>
       <button className="primary" disabled={busy===q.id||(q.type==='merchant'&&draftAnswer!.mode==='categorize'&&!draftAnswer!.category)||(q.type==='merchant'&&draftAnswer!.pattern.trim().length<2)||(q.type==='field'&&!draftAnswer!.value)}
        onClick={()=>void send(q)}>{busy===q.id?'正在处理…':q.type==='merchant'?`建立规则并重算 ${q.draft_count} 笔`:`这 ${q.draft_count} 笔统一指定`}</button>
      </div>
     </div>}
  </article>;
 }

 if(error&&!data)return <section className="panel"><p role="alert" className="error">{error}</p><button className="secondary" onClick={()=>setTick(t=>t+1)}>重试</button></section>;
 if(!data)return <section className="panel"><p role="status">正在整理待澄清的问题…</p></section>;
 return <>
  {error&&<div role="alert" className="banner error">{error}<button onClick={()=>setError('')}>×</button></div>}
  {notice&&<div role="status" className="banner success">{notice}<button onClick={()=>{setNotice('');setResult(null);}}>×</button></div>}
  <section className="panel">
   <div className="section-title"><div><span className="eyebrow">ONE QUESTION, ONE RULE</span>
    <h2>卡住的问题 <span className="count">{data.blocking.length}</span></h2>
    <p className="muted">同一个问题只问一次：回答后立刻建立规则，并把积压的交易重新跑一遍。按影响金额排序，不按出现次数。</p></div></div>
   {data.blocking.length?data.blocking.map(card)
    :<div className="empty"><h3>没有卡住的问题</h3><p>待处理交易里暂时没有需要你拍板的共性问题。</p></div>}
  </section>
  {result&&result.results.some(r=>r.outcome!=='posted')&&<section className="panel">
   <h3>这次没有直接入账的</h3>
   <ul className="clarify-results">{result.results.filter(r=>r.outcome!=='posted').map(r=>
    <li key={r.event_id}>{outcomes[r.outcome]||r.outcome}：{r.reason||r.issues?.join('；')||hints[r.outcome]||'仍保留为待处理'}</li>)}</ul>
   {result.results.some(r=>['still_draft','not_matched','failed','changed'].includes(r.outcome))&&<p className="muted">这些仍在「资料收件箱」里，可以逐笔补充。</p>}</section>}
  {data.preventive.length>0&&<section className="panel">
   <div className="section-title"><div><span className="eyebrow">WILL BE ASKED AGAIN</span>
    <h2>下次还会问 <span className="count">{data.preventive.length}</span></h2>
    <p className="muted">这些商户已经出现过多次但还没有规则。现在定下来，以后的新材料就不用再判断。已入账的记录不会被改写。</p></div></div>
   {data.preventive.map(card)}</section>}
  <section className="panel">
   <div className="section-title"><div><span className="eyebrow">SETTLED</span><h2>已经定下来的判断 <span className="count">{data.rules.filter(r=>r.enabled).length}</span></h2>
    <p className="muted">每一条都来自一次回答。停用后，相关的问题会重新回到上面的清单。</p></div></div>
   <div className="table-wrap"><table><thead><tr><th>匹配词</th><th>方向</th><th>处理</th><th>依据</th><th>命中</th><th>操作</th></tr></thead>
    <tbody>{data.rules.map(r=><tr key={r.id}>
     <td><b>{r.pattern}</b>{r.account_pattern&&<small>限于 {r.account_pattern}</small>}</td>
     <td>{directions[r.applies_to]||'收支皆可'}</td>
     <td>{r.action==='skip'?'不算收支':'归入 '+(categories.find(c=>c.key===r.category)?.name||r.category)}</td>
     <td><small>{r.reason}</small></td>
     <td className="numeric">{r.hit_count}{r.last_hit_at&&<small>{r.last_hit_at.slice(0,10)}</small>}</td>
     <td>{r.enabled?<button className="text-button" disabled={busy===r.id} onClick={()=>void disable(r)}>停用</button>:<span className="badge discarded">已停用</span>}</td>
    </tr>)}</tbody></table>
    {!data.rules.length&&<div className="empty"><h3>还没有规则</h3><p>回答上面任意一条问题，判断就会固化在这里。</p></div>}</div>
  </section>
  <p className="muted">{data.note}</p>
 </>;
}

function defaultReason(q:Question,answer:{mode:string;category:string},categories:Category[]){
 if(answer.mode==='skip')return'用户确认这类材料不另计收支';
 const name=categories.find(c=>c.key===answer.category)?.name;
 return'用户确认这类'+(directions[q.kind||'expense'])+'归入'+(name||'所选科目');
}
function summarize(out:Answered){
 const a=out.applied,parts=[];
 if(out.rule)parts.push('已建立规则「'+out.rule.pattern+'」');
 if(a.posted)parts.push('入账 '+a.posted+' 笔');
 if(a.set_aside)parts.push('搁置 '+a.set_aside+' 笔');
 if(a.still_draft)parts.push('仍待处理 '+a.still_draft+' 笔');
 if(a.not_matched)parts.push('规则未覆盖 '+a.not_matched+' 笔');
 if(a.failed)parts.push('未成功 '+a.failed+' 笔');
 return parts.join('，')+'。';
}
