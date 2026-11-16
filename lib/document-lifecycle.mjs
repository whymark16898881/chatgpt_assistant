import {createHash} from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
export const documentActionSchema=z.object({action:z.enum(['trash','restore','purge']),document_ids:z.array(z.uuid()).min(1).max(500).optional(),all:z.boolean().default(false)}).strict().superRefine((v,c)=>{if(v.all===!!v.document_ids)c.addIssue({code:'custom',message:'请选择指定凭证或整个范围'});});
export const documentApplySchema=z.object({...documentActionSchema.shape,confirmation_token:z.string().regex(/^[a-f0-9]{64}$/)}).strict().superRefine((v,c)=>{if(v.all===!!v.document_ids)c.addIssue({code:'custom',message:'请选择指定凭证或整个范围'});});
const predicates={trash:'d.trashed_at IS NULL AND d.purge_requested_at IS NULL',restore:'d.trashed_at IS NOT NULL AND d.purge_requested_at IS NULL',purge:'d.trashed_at IS NOT NULL AND d.file_removed_at IS NULL'};
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
export const documentLock=sha=>BigInt.asIntN(64,BigInt('0x'+sha.slice(0,16))).toString();
export function documentState(d){return d.file_removed_at?'purged':d.purge_requested_at?'purge_pending':d.trashed_at?'trash':'active';}
const select=`SELECT d.*,COALESCE((SELECT jsonb_agg(jsonb_build_object('id',e.id,'status',e.status) ORDER BY e.id) FROM cfo_events e WHERE e.document_id=d.id OR EXISTS(SELECT 1 FROM cfo_event_sources s WHERE s.event_id=e.id AND s.document_id=d.id) OR EXISTS(SELECT 1 FROM cfo_field_observations o WHERE o.event_id=e.id AND o.document_id=d.id)),'[]'::jsonb) AS linked_events FROM cfo_documents d`;
const safe=d=>({id:d.id,filename:d.filename,sha256:d.sha256,mime_type:d.mime_type,bytes:d.bytes,archived_at:d.archived_at,trashed_at:d.trashed_at,lifecycle:documentState(d),original_available:!d.purge_requested_at,transaction_count:d.linked_events.length,posted_count:d.linked_events.filter(e=>['posted','reversed'].includes(e.status)).length,draft_count:d.linked_events.filter(e=>e.status==='draft').length});
const token=(action,rows)=>createHash('sha256').update(JSON.stringify({action,rows:rows.map(d=>[d.id,d.lifecycle_revision,d.linked_events])})).digest('hex');
async function audit(c,action,id){await c.query('INSERT INTO cfo_audit(action,entity_id) VALUES($1,$2)',[action,id]);}
export function documentLifecycle(pool,dataDir){
 async function chosen(c,input){const ids=input.document_ids?[...new Set(input.document_ids.map(v=>v.toLowerCase()))]:null;const rows=(await c.query(select+` WHERE ${predicates[input.action]} AND ($1::uuid[] IS NULL OR d.id=ANY($1)) ORDER BY d.sha256`,[ids])).rows;if(ids&&rows.length!==ids.length)fail('DOCUMENT_SELECTION_CHANGED','部分凭证状态已变化，请刷新后重新选择');return rows;}
 return{
  inventory:async({status='active',limit=25,offset=0}={})=>{
   const q=z.object({status:z.enum(['active','trash']),limit:z.number().int().min(1).max(250),offset:z.number().int().min(0).max(1000000)}).parse({status,limit,offset});
   const c=await pool.connect();try{await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const counts=(await c.query(`SELECT count(*) FILTER(WHERE trashed_at IS NULL AND purge_requested_at IS NULL)::int AS active,count(*) FILTER(WHERE trashed_at IS NOT NULL AND file_removed_at IS NULL)::int AS trash,count(*) FILTER(WHERE file_removed_at IS NOT NULL)::int AS purged FROM cfo_documents`)).rows[0];const rows=(await c.query(select+` WHERE ${q.status==='active'?predicates.trash:predicates.purge} ORDER BY d.archived_at DESC,d.id LIMIT $1 OFFSET $2`,[q.limit,q.offset])).rows;await c.query('COMMIT');const total=counts[q.status];return{documents:rows.map(safe),counts,scope:{status:q.status,total,offset:q.offset,limit:q.limit,has_more:q.offset+rows.length<total}};}catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
  },
  preview:async input=>{const q=documentActionSchema.parse(input),rows=await chosen(pool,q),events=new Map(rows.flatMap(d=>d.linked_events.map(e=>[e.id,e])));return{action:q.action,document_count:rows.length,bytes:rows.reduce((s,d)=>s+d.bytes,0),linked_transaction_count:events.size,posted_transaction_count:[...events.values()].filter(e=>['posted','reversed'].includes(e.status)).length,draft_transaction_count:[...events.values()].filter(e=>e.status==='draft').length,sample_files:rows.slice(0,5).map(d=>d.filename),confirmation_token:token(q.action,rows),financial_transactions_changed:false};},
  apply:async input=>{
   const {confirmation_token,...selection}=documentApplySchema.parse(input),c=await pool.connect(),locks=[];let inTransaction=false,broken=false;
   try{
    await c.query('BEGIN');inTransaction=true;await c.query('SELECT pg_advisory_xact_lock(20261102)');
    // Session locks cover COMMIT and unlink, so a re-upload cannot race file removal.
    const initial=await chosen(c,selection);for(const d of initial){const key=documentLock(d.sha256);await c.query('SELECT pg_advisory_lock($1::bigint)',[key]);locks.push(key);}
    const rows=await chosen(c,selection);if(token(selection.action,rows)!==confirmation_token)fail('DOCUMENT_SELECTION_CHANGED','凭证或关联账目已变化，请重新确认操作范围');
    for(const d of rows){
     if(selection.action==='trash')await c.query('UPDATE cfo_documents SET trashed_at=now(),lifecycle_revision=lifecycle_revision+1 WHERE id=$1',[d.id]);
     else if(selection.action==='restore')await c.query('UPDATE cfo_documents SET trashed_at=NULL,lifecycle_revision=lifecycle_revision+1 WHERE id=$1',[d.id]);
     else await c.query('UPDATE cfo_documents SET purge_requested_at=COALESCE(purge_requested_at,now()),lifecycle_revision=lifecycle_revision+1 WHERE id=$1',[d.id]);
     await audit(c,'document_'+(selection.action==='purge'?'purge_requested':selection.action),d.id);
    }
    await c.query('COMMIT');inTransaction=false;
    let removed=0;const failures=[];
    if(selection.action==='purge')for(const d of rows){
     try{
      const target=path.resolve(dataDir,d.sha256);if(path.resolve(d.stored_path)!==target||!/^[a-f0-9]{64}$/.test(d.sha256))fail('INVALID_ORIGINAL_PATH','原件存储位置无效');
      try{await fs.unlink(target);}catch(e){if(e.code!=='ENOENT')throw e;}
      const directory=await fs.open(dataDir,'r');try{await directory.sync();}finally{await directory.close();}
      await c.query('BEGIN');inTransaction=true;await c.query('UPDATE cfo_documents SET file_removed_at=now(),lifecycle_revision=lifecycle_revision+1 WHERE id=$1',[d.id]);await audit(c,'document_purged',d.id);await c.query('COMMIT');inTransaction=false;removed++;
     }catch(e){if(inTransaction){await c.query('ROLLBACK');inTransaction=false;}failures.push({document_id:d.id,code:e.code==='INVALID_ORIGINAL_PATH'?e.code:'FILE_REMOVAL_PENDING'});}
    }
    return{action:selection.action,document_count:rows.length,completed_count:selection.action==='purge'?removed:rows.length,pending_count:failures.length,failures,financial_transactions_changed:false};
   }catch(e){if(inTransaction)await c.query('ROLLBACK').catch(()=>{broken=true;});throw e;}
   finally{for(const key of locks.reverse())try{await c.query('SELECT pg_advisory_unlock($1::bigint)',[key]);}catch{broken=true;}c.release(broken||undefined);}
  }
 };
}
