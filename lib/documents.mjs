import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {documentLifecycle,documentLock} from './document-lifecycle.mjs';
import {transaction} from './db.mjs';
import {createDownloader} from '../probe/download.mjs';
export function documentService(pool,dataDir,{download=createDownloader({policy:'public_https'})}={}) {
  async function saveBytes(file,{bytes,mime}) {
    await fs.mkdir(dataDir,{recursive:true,mode:0o700});
    const sha=createHash('sha256').update(bytes).digest('hex'),target=path.join(dataDir,sha),temp=target+'.tmp-'+randomUUID();
    try {
      const h=await fs.open(temp,'wx',0o600);try{await h.writeFile(bytes);await h.sync();}finally{await h.close();}
      return await transaction(pool,async c=>{
        await c.query('SELECT pg_advisory_xact_lock($1::bigint)',[documentLock(sha)]);
        let exists=true;try{if(createHash('sha256').update(await fs.readFile(target)).digest('hex')!==sha)throw new Error('已有原件校验失败');}catch(e){if(e.code==='ENOENT')exists=false;else throw e;}
        if(!exists){await fs.rename(temp,target);const d=await fs.open(dataDir,'r');try{await d.sync();}finally{await d.close();}}
        const previous=(await c.query('SELECT id,trashed_at,purge_requested_at FROM cfo_documents WHERE sha256=$1',[sha])).rows[0];
        const id=randomUUID();
        const q=await c.query(`INSERT INTO cfo_documents(id,sha256,filename,mime_type,bytes,stored_path) VALUES($1,$2,$3,$4,$5,$6)
          ON CONFLICT(sha256) DO UPDATE SET trashed_at=NULL,purge_requested_at=NULL,file_removed_at=NULL,lifecycle_revision=cfo_documents.lifecycle_revision+CASE WHEN cfo_documents.trashed_at IS NOT NULL OR cfo_documents.purge_requested_at IS NOT NULL THEN 1 ELSE 0 END RETURNING id,sha256,filename,mime_type,bytes,archived_at`,[id,sha,path.basename(file.file_name||'attachment').slice(0,250),mime,bytes.length,target]);
        if(previous&&(previous.trashed_at||previous.purge_requested_at))await c.query("INSERT INTO cfo_audit(action,entity_id) VALUES('document_restored_by_upload',$1)",[previous.id]);
        return{...q.rows[0],duplicate:q.rows[0].id!==id,original_saved:true};
      });
    }finally{await fs.unlink(temp).catch(()=>{});}
  }
  return{
    ...documentLifecycle(pool,dataDir),
    saveBytes,
    archive:async file=>saveBytes(file,await download(file)),
    list:async()=> (await documentLifecycle(pool,dataDir).inventory({limit:250})).documents,
    read:async id=>{
      const c=await pool.connect();try{await c.query('BEGIN');let row=(await c.query('SELECT * FROM cfo_documents WHERE id=$1',[id])).rows[0];if(!row)throw new Error('凭证不存在');await c.query('SELECT pg_advisory_xact_lock($1::bigint)',[documentLock(row.sha256)]);row=(await c.query('SELECT * FROM cfo_documents WHERE id=$1',[id])).rows[0];
      if(row.purge_requested_at)throw Object.assign(new Error(row.file_removed_at?'原件已永久删除；账目和凭证记录仍保留':'原件待永久删除，暂不可读取；可在回收站重试删除'),{code:'DOCUMENT_PURGED'});
      const bytes=await fs.readFile(row.stored_path);if(createHash('sha256').update(bytes).digest('hex')!==row.sha256)throw new Error('凭证校验失败');await c.query('COMMIT');return{...row,bytes};
      }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
    }
  };
}
