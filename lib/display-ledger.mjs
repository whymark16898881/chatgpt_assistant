// Convert complete original journals, then mirror their exact negation through
// reversal/restore chains. Only presentation SELECTs use this adapter.
export function displayLedger(client,{currency='CNY',rate='1'}={}){
 if(currency==='CNY')return client;
 if(!['USD','SGD'].includes(currency)||!/^\d+(\.\d{1,20})?$/.test(rate)||Number(rate)<=0||Number(rate)>=100000)throw new Error('展示汇率无效');
 return{release:()=>client.release(),query:(sql,args=[])=>{
  if(!/\bcfo_lines\b/.test(sql))return client.query(sql,args);
  const p='$'+(args.length+1),prefix=`WITH RECURSIVE fx_roots AS (SELECT id AS entry_id,id AS root_id,1 AS sign FROM cfo_entries WHERE reverses_id IS NULL UNION ALL SELECT j.id,p.root_id,-p.sign FROM cfo_entries j JOIN fx_roots p ON j.reverses_id=p.entry_id),
   fx_raw AS (SELECT l.*,floor(l.cny_cents::numeric*${p}::numeric) AS lo,l.cny_cents::numeric*${p}::numeric-floor(l.cny_cents::numeric*${p}::numeric) AS fraction FROM cfo_lines l JOIN cfo_entries j ON j.id=l.entry_id WHERE j.reverses_id IS NULL),
   fx_ranked AS (SELECT r.*,row_number() OVER(PARTITION BY entry_id ORDER BY fraction DESC,id) AS rank,-sum(lo) OVER(PARTITION BY entry_id) AS extra,row_number() OVER(PARTITION BY entry_id,account_id ORDER BY id) AS account_ordinal FROM fx_raw r),
   fx_actual AS (SELECT l.*,row_number() OVER(PARTITION BY entry_id,account_id ORDER BY id) AS account_ordinal FROM cfo_lines l),
   display_lines AS (SELECT l.id,l.entry_id,l.account_id,l.native_cents,((r.lo+CASE WHEN r.rank<=r.extra THEN 1 ELSE 0 END)*root.sign)::bigint AS cny_cents,l.fx_rate,l.fx_source FROM fx_actual l JOIN fx_roots root ON root.entry_id=l.entry_id JOIN fx_ranked r ON r.entry_id=root.root_id AND r.account_id=l.account_id AND r.account_ordinal=l.account_ordinal)`;
  const body=sql.replace(/\bcfo_lines\b/g,'display_lines');return client.query(prefix+(body.trimStart().startsWith('WITH RECURSIVE ')?','+body.trimStart().slice(15):' '+body),[...args,rate]);
 }};
}
