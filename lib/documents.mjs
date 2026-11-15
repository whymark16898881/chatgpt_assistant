import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {transaction} from './db.mjs';
import {createDownloader} from '../probe/download.mjs';
export function documentService(pool,dataDir,{download=createDownloader({policy:'public_https'})}={}) {
  async function saveBytes(file,{bytes,mime}) {
    await fs.mkdir(dataDir,{recursive:true,mode:0o700});
    const sha=createHash('sha256').update(bytes).digest('hex'),target=path.join(dataDir,sha),temp=target+'.tmp-'+randomUUID();
    try {
      const h=await fs.open(temp,'wx',0o600);try{await h.writeFile(bytes);await h.sync();}finally{await h.close();}
      return await transaction(pool,async c=>{
        await c.query('SELECT pg_advisory_xact_lock($1::bigint)',[BigInt.asIntN(64,BigInt('0x'+sha.slice(0,16))).toString()]);
        let exists=true;try{if(createHash('sha256').update(await fs.readFile(target)).digest('hex')!==sha)throw new Error('已有原件校验失败');}catch(e){if(e.code==='ENOENT')exists=false;else throw e;}
        if(!exists){await fs.rename(temp,target);const d=await fs.open(dataDir,'r');try{await d.sync();}finally{await d.close();}}
        const id=randomUUID();
        const q=await c.query(`INSERT INTO cfo_documents(id,sha256,filename,mime_type,bytes,stored_path) VALUES($1,$2,$3,$4,$5,$6)
          ON CONFLICT(sha256) DO UPDATE SET sha256=EXCLUDED.sha256 RETURNING id,sha256,filename,mime_type,bytes,archived_at`,[id,sha,path.basename(file.file_name||'attachment').slice(0,250),mime,bytes.length,target]);
        return{...q.rows[0],duplicate:q.rows[0].id!==id,original_saved:true};
      });
    }finally{await fs.unlink(temp).catch(()=>{});}
  }
  return{
    saveBytes,
    archive:async file=>saveBytes(file,await download(file)),
    list:async()=> (await pool.query(`SELECT d.id,d.filename,d.sha256,d.mime_type,d.bytes,d.archived_at,
      (SELECT count(*)::int FROM cfo_event_sources s WHERE s.document_id=d.id) AS transaction_count
      FROM cfo_documents d ORDER BY d.archived_at DESC LIMIT 250`)).rows,
    read:async id=>{
      const row=(await pool.query('SELECT * FROM cfo_documents WHERE id=$1',[id])).rows[0];if(!row)throw new Error('凭证不存在');
      const bytes=await fs.readFile(row.stored_path);if(createHash('sha256').update(bytes).digest('hex')!==row.sha256)throw new Error('凭证校验失败');return{...row,bytes};
    }
  };
}
