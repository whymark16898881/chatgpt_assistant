import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
export async function importProbe(source,documents,originalDir){
 const c=await source.connect();let imported=0,skipped=0,reused=0;
 try{
  await c.query('BEGIN READ ONLY');
  const rows=(await c.query('SELECT sha256,filename,mime_type FROM cfo_probe_documents ORDER BY created_at')).rows;
  for(const row of rows){
   if(row.sha256==='72277670745bf3b84f54e6d44fb4fac973c6de59dc10dc327e2449827c609076'){skipped++;continue;}
   if(!/^[a-f0-9]{64}$/.test(row.sha256))throw new Error('Invalid source hash');
   const bytes=await readFile(path.join(originalDir,row.sha256));
   if(createHash('sha256').update(bytes).digest('hex')!==row.sha256)throw new Error('Source checksum mismatch');
   const d=await documents.saveBytes({file_name:row.filename},{bytes,mime:row.mime_type});if(d.duplicate)reused++;else imported++;
  }
  await c.query('COMMIT');return{imported,reused,skipped,financial_transaction_posted:false};
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
