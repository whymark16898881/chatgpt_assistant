import {z} from 'zod';
import {cents,yuan,validDate,START} from './money.mjs';
import {classificationTree} from './classifications.mjs';
import {loadRecognition} from './recognition.mjs';
const money=n=>yuan(n.toString());
export const analysisQuerySchema=z.object({month:z.string().regex(/^\d{4}-\d{2}$/),kind:z.enum(['all','income','expense']).default('all'),group_by:z.enum(['analysis_category','financial_category','merchant','meal_type','day']).default('analysis_category'),category_code:z.string().max(100).optional(),financial_code:z.string().max(100).optional(),merchant:z.string().max(150).optional(),meal_type:z.enum(['breakfast','lunch','dinner','snack','unknown','not_applicable']).optional(),day:z.string().optional(),unclassified:z.boolean().default(false),unknown_merchant:z.boolean().default(false),direct_category_code:z.string().max(100).optional(),limit:z.number().int().min(1).max(100).default(30),offset:z.number().int().min(0).max(1000000).default(0)}).strict();
export function allocateCents(total,weights){
 total=BigInt(total);weights=weights.map(BigInt);const sum=weights.reduce((a,b)=>a+b,0n);if(!weights.length||weights.some(w=>w<0n)||sum<=0n)throw new Error('分摊基数无效');
 const sign=total<0n?-1n:1n,absolute=total*sign,parts=weights.map((w,i)=>({i,value:absolute*w/sum,remainder:absolute*w%sum}));
 let left=absolute-parts.reduce((s,p)=>s+p.value,0n);const order=[...parts].sort((a,b)=>a.remainder===b.remainder?a.i-b.i:a.remainder>b.remainder?-1:1);
 for(const p of order){if(!left)break;p.value++;left--;}
 return parts.map(p=>p.value*sign);
}
function sourceDocuments(rows){const map=new Map();for(const row of rows){if(!map.has(row.document_id))map.set(row.document_id,{document_id:row.document_id,filename:row.filename,mime_type:row.mime_type,download_url:'/api/documents/'+row.document_id,locations:[]});map.get(row.document_id).locations.push({source_ref:row.source_ref||null,page:row.page||null,bounding_box:row.bounding_box||null,location_verified:false});}return[...map.values()];}
async function sourcesFor(c,ids){return(await c.query(`SELECT s.event_id,s.document_id,s.source_ref,d.filename,d.mime_type,NULL::int AS page,NULL::jsonb AS bounding_box FROM cfo_event_sources s JOIN cfo_documents d ON d.id=s.document_id WHERE s.event_id=ANY($1::uuid[])
 UNION SELECT e.id,e.document_id,e.source_ref,d.filename,d.mime_type,NULL::int,NULL::jsonb FROM cfo_events e JOIN cfo_documents d ON d.id=e.document_id WHERE e.id=ANY($1::uuid[])
 UNION SELECT o.event_id,o.document_id,o.source_ref,d.filename,d.mime_type,o.page,o.bounding_box FROM cfo_field_observations o JOIN cfo_documents d ON d.id=o.document_id WHERE o.event_id=ANY($1::uuid[])`,[ids])).rows;}
export async function transactionDetail(pool,id){
 id=z.uuid().parse(id);const c=await pool.connect();try{
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const event=(await c.query("SELECT e.*,a.name AS account_name,a.currency AS account_currency FROM cfo_events e LEFT JOIN cfo_accounts a ON a.id::text=e.payload->>'account_id' WHERE e.id=$1",[id])).rows[0];if(!event)throw new Error('交易不存在');
  const recognition=await loadRecognition(c,id),sources=sourceDocuments(await sourcesFor(c,[id]));
  const entries=(await c.query(`SELECT j.id,j.entry_date,j.description,j.kind,j.reverses_id,jsonb_agg(jsonb_build_object('line_id',l.id,'account_id',a.id,'name',a.name,'group',a.account_group,'system_key',a.system_key,'native_cents',l.native_cents::text,'cny_cents',l.cny_cents::text,'fx_rate',l.fx_rate::text,'fx_source',l.fx_source) ORDER BY l.id) AS lines
   FROM cfo_entries j JOIN cfo_lines l ON l.entry_id=j.id JOIN cfo_accounts a ON a.id=l.account_id WHERE j.event_id=$1 OR j.reverses_id IN(SELECT id FROM cfo_entries WHERE event_id=$1) GROUP BY j.id ORDER BY j.created_at,j.id`,[id])).rows;
  await c.query('COMMIT');return{event,recognition,documents:sources,entries,financial_transaction_posted:false,note:'原件位置仅为已保存引用；未在本次查询重新核验原文。分析分类不会改写实际财务分录。'};
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}
export async function analysisOverview(pool,input){
 const q=analysisQuerySchema.parse(input),from=q.month+'-01';if(!validDate(from)||from<START)throw new Error('分析从2026年11月开始');
 const to=new Date(Date.UTC(Number(q.month.slice(0,4)),Number(q.month.slice(5)),0)).toISOString().slice(0,10);
 if(q.day&&(!validDate(q.day)||q.day<from||q.day>to))throw new Error('筛选日期不在所选月份');
 const c=await pool.connect();try{
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const tree=await classificationTree(c),nodes=new Map(tree.map(n=>[n.tree+':'+n.code,n]));
  if(q.category_code&&!nodes.has('analysis:'+q.category_code))throw new Error('分析分类不存在');if(q.direct_category_code&&!nodes.has('analysis:'+q.direct_category_code))throw new Error('分析分类不存在');if(q.financial_code&&!nodes.has('financial:'+q.financial_code))throw new Error('财务分类不存在');
  const events=(await c.query(`SELECT e.id,e.payload,j.entry_date::text,a.currency,a.name AS account_name,
   (SELECT count(*) FROM cfo_lines l WHERE l.entry_id=j.id)::int AS line_count,
   (SELECT sum(l.cny_cents) FROM cfo_lines l WHERE l.entry_id=j.id)::text AS balance_check,
   (SELECT sum(CASE WHEN n.account_group=e.payload->>'kind' THEN CASE WHEN n.account_group='income' THEN -l.cny_cents ELSE l.cny_cents END ELSE 0 END) FROM cfo_lines l JOIN cfo_accounts n ON n.id=l.account_id WHERE l.entry_id=j.id)::text AS cny_total,
   (SELECT array_agg(DISTINCT n.system_key) FILTER(WHERE n.system_key IS NOT NULL AND n.account_group=e.payload->>'kind') FROM cfo_lines l JOIN cfo_accounts n ON n.id=l.account_id WHERE l.entry_id=j.id) AS financial_codes
   FROM cfo_events e JOIN cfo_entries j ON j.event_id=e.id AND j.reverses_id IS NULL LEFT JOIN cfo_accounts a ON a.id::text=e.payload->>'account_id'
   WHERE e.status='posted' AND e.payload->>'kind' IN ('income','expense') AND j.entry_date BETWEEN $1 AND $2 ORDER BY j.entry_date DESC,e.id`,[from,to])).rows;
  const sources=await sourcesFor(c,events.map(e=>e.id)),items=[];
  for(const e of events){
   if(e.line_count<2||e.balance_check===null||BigInt(e.balance_check)!==0n||e.cny_total===null)throw new Error('交易分录未通过金额完整性检查');
   const p=e.payload,recognition=await loadRecognition(c,e.id),fresh=recognition.recognition_recorded&&!recognition.stale_for_transaction,documents=sourceDocuments(sources.filter(s=>s.event_id===e.id));
   let native=null;try{native=BigInt(cents(p.amount));}catch{}
   const complete=fresh&&recognition.allocation_status==='complete'&&native!==null&&native>0n&&recognition.items.length&&recognition.items.every(i=>i.amount_minor!==null&&i.currency===e.currency)&&recognition.items.reduce((s,i)=>s+BigInt(i.amount_minor),0n)===native;
   const unsplit=fresh&&recognition.allocation_status==='not_itemized'&&recognition.items.length===1;
   const rows=complete||unsplit?recognition.items:[{item_id:null,item_ref:null,description:p.description,amount_minor:native?.toString()??null,currency:e.currency,category_code:fresh?recognition.category_code:null,merchant:fresh?recognition.merchant||p.merchant:p.merchant,meal_type:fresh?recognition.meal_type:null,basis:'transaction_total_fallback'}];
   const effective=rows.length?rows:[{item_id:null,description:p.description,amount_minor:native?.toString()??null,currency:e.currency,basis:'transaction_total_fallback'}];
   const parts=complete?allocateCents(e.cny_total,effective.map(i=>i.amount_minor)):[BigInt(e.cny_total)];
   effective.forEach((i,index)=>items.push({transaction_id:e.id,item_id:i.item_id??null,recognition_revision:recognition.revision,description:i.description||p.description||'',kind:p.kind,date:p.date||e.entry_date,posting_date:e.entry_date,occurred_time:fresh?recognition.occurred_time:null,time_precision:fresh?recognition.time_precision:'date',timezone:fresh?recognition.timezone:null,
    amount:i.amount_minor==null?null:money(BigInt(i.amount_minor)),currency:i.currency||null,cny_amount:money(parts[index]),cny_cents:parts[index],financial_codes:e.financial_codes||[],category_code:i.category_code||null,merchant:i.merchant||p.merchant||null,meal_type:i.meal_type||null,basis:i.basis,allocation_status:recognition.allocation_status||'not_collected',recognition_stale:recognition.stale_for_transaction===true,account_name:e.account_name,documents}));
  }
  const matches=(node,root)=>!!node&&node.path.some(p=>p.code===root);
  const filtered=items.filter(i=>(q.kind==='all'||i.kind===q.kind)&&(!q.category_code||matches(nodes.get('analysis:'+i.category_code),q.category_code))&&(!q.financial_code||i.financial_codes.length===1&&matches(nodes.get('financial:'+i.financial_codes[0]),q.financial_code))&&(!q.unclassified||!i.category_code)&&(!q.direct_category_code||i.category_code===q.direct_category_code)&&(!q.unknown_merchant||!i.merchant)&&(!q.merchant||i.merchant===q.merchant)&&(!q.meal_type||(i.meal_type||'unknown')===q.meal_type)&&(!q.day||i.date===q.day));
  if(q.financial_code&&items.some(i=>i.financial_codes.length>1))throw new Error('存在多财务科目交易，暂不能按单科目分配其分析明细');
  const categoryGroup=(treeKind,code,root)=>{const n=nodes.get(treeKind+':'+code);if(!n)return{key:'__unclassified__',label:'未细分',next_code:null};const start=root?n.path.findIndex(p=>p.code===root):0;const child=n.path[start+1];return child?{key:child.code,label:child.name,next_code:child.code}:{key:n.code+'::direct',label:n.name+' · 本级未细分',next_code:null};};
  const groups=new Map();let income=0n,expense=0n;
  for(const i of filtered){
   if(i.kind==='income')income+=i.cny_cents;else expense+=i.cny_cents;
   let g;
   if(q.group_by==='analysis_category')g=categoryGroup('analysis',i.category_code,q.category_code);
   else if(q.group_by==='financial_category')g=i.financial_codes.length===1?categoryGroup('financial',i.financial_codes[0],q.financial_code):{key:'__multiple__',label:'多财务科目',next_code:null};
   else{const key=q.group_by==='merchant'?i.merchant:q.group_by==='meal_type'?(i.meal_type||'unknown'):i.date;g={key:key||'__unknown__',label:key||'未记录',next_code:null};}
   if(!groups.has(g.key))groups.set(g.key,{...g,income:0n,expense:0n,transaction_ids:new Set(),document_ids:new Set(),item_count:0});
   const row=groups.get(g.key);row[i.kind]+=i.cny_cents;row.transaction_ids.add(i.transaction_id);for(const d of i.documents)row.document_ids.add(d.document_id);row.item_count++;
  }
  const pending=(await c.query(`SELECT count(*) FILTER(WHERE payload->>'date' BETWEEN $1 AND $2)::int AS dated_in_month,count(*) FILTER(WHERE COALESCE(payload->>'date','')='')::int AS without_date FROM cfo_events WHERE status='draft'`,[from,to])).rows[0];
  await c.query('COMMIT');
  const txIds=new Set(filtered.map(i=>i.transaction_id)),docIds=new Set(filtered.flatMap(i=>i.documents.map(d=>d.document_id)));
  const groupRows=[...groups.values()].sort((a,b)=>a.expense!==b.expense?(a.expense>b.expense?-1:1):a.income!==b.income?(a.income>b.income?-1:1):a.key.localeCompare(b.key)).map(g=>({key:g.key,label:g.label,next_code:g.next_code,income_cny:money(g.income),expense_cny:money(g.expense),net_cny:money(g.income-g.expense),transaction_count:g.transaction_ids.size,document_count:g.document_ids.size,item_count:g.item_count}));
  return{schema:'cfo_analysis/v1',month:q.month,from,to,currency:'CNY',basis:'posted_ledger',date_basis:'posting_date',filters:q,classification_tree:tree,
   totals:{income_cny:money(income),expense_cny:money(expense),net_cny:money(income-expense),transaction_count:txIds.size,document_count:docIds.size,item_count:filtered.length},pending,groups:groupRows,
   rows:filtered.slice(q.offset,q.offset+q.limit).map(({cny_cents,...i})=>i),scope:{total_matching_items:filtered.length,returned:Math.max(0,Math.min(q.limit,filtered.length-q.offset)),has_more:q.offset+q.limit<filtered.length,next_offset:q.offset+q.limit<filtered.length?q.offset+q.limit:null,totals_cover_all_matching_items:true},
   financial_transaction_posted:false,note:'只汇总已入账收入费用，转账/本金/期初/估值不混入。人民币金额来自实际分录，明细折算分配后与分录总额一致。未拆分或过期识别保留交易总额；分类不会改写财务科目。文件数按唯一原件计数，不与交易数混同。'};
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}
