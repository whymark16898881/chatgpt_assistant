import * as fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {z} from 'zod';
export const PORTFOLIO_FILES=['account_risk_latest.json','positions_latest.json','official_marks_history.csv','account_risk_history.csv','assets_history.csv','trades.csv','nontrade_live.csv','nontrade_tiger.csv','nontrade_futubull.csv','moomoo_fees.csv','external_flows.csv','corporate_actions.csv','fx_cache.csv'];
export const OPTIONAL_PORTFOLIO_FILES=['account_results.json'];
const allowedFiles=[...PORTFOLIO_FILES,...OPTIONAL_PORTFOLIO_FILES];
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function fail(code,message){throw Object.assign(new Error(message),{code});}
const stamp=z.iso.datetime({offset:true});
export function parsePortfolioManifest(text){
 let m;try{m=JSON.parse(text.replace(/^\uFEFF/,''));}catch{fail('INVALID_MANIFEST','导出manifest不是有效JSON');}
 if(!m||typeof m.export_id!=='string'||!m.export_id.trim()||m.export_id.length>200||!stamp.safeParse(m.exported_at).success)fail('INVALID_MANIFEST','导出标识或时点缺失');
 if(!m.source||typeof m.source.snapshot_id!=='string'||!m.source.snapshot_id.trim()||!stamp.safeParse(m.source.generated_at).success||typeof m.source.complete!=='boolean'||typeof m.source.stale!=='boolean')fail('INVALID_MANIFEST','manifest缺少源快照身份或状态');
 if(Date.parse(m.exported_at)<Date.parse(m.source.generated_at))fail('INVALID_MANIFEST','导出完成时间早于源快照');
 if(!Array.isArray(m.files)||![PORTFOLIO_FILES.length,allowedFiles.length].includes(m.files.length))fail('INVALID_MANIFEST','manifest需列出原13文件，可额外包含账户结果文件');
 let total=0;const names=new Set();for(const f of m.files){
  if(!f||!allowedFiles.includes(f.name)||names.has(f.name))fail('INVALID_MANIFEST','manifest文件名不在白名单或重复');names.add(f.name);
  if(Object.hasOwn(f,'kept_previous')&&typeof f.kept_previous!=='boolean')fail('INVALID_MANIFEST','沿用旧文件标记类型无效');
  if(f.status!=='ok'||f.kept_previous===true)fail('INCOMPLETE_EXPORT','导出含缺失、复制失败或沿用旧文件，保留原数据');
  if(typeof f.sha256!=='string'||!/^[a-f0-9]{64}$/i.test(f.sha256)||!Number.isSafeInteger(f.bytes)||f.bytes<0||f.bytes>16*1024*1024||!stamp.safeParse(f.source_mtime).success)fail('INVALID_MANIFEST','文件哈希、长度或来源时点无效');
  total+=f.bytes;if(total>64*1024*1024)fail('SOURCE_TOO_LARGE','整批来源超过读取上限');
 }
 if(PORTFOLIO_FILES.some(name=>!names.has(name)))fail('INVALID_MANIFEST','原13个必要文件不能缺失或被替换');
 return m;
}
async function readRegular(root,name,limit){
 let h;try{
  h=await fs.open(path.join(root,name),constants.O_RDONLY|constants.O_NOFOLLOW);const st=await h.stat();
  if(!st.isFile()||st.size>limit)fail('SOURCE_TOO_LARGE','来源文件类型或大小不符合限制');
  const bytes=await h.readFile();if(bytes.length!==st.size)fail('SOURCE_CHANGED_RETRY','读取期间文件变化，稍后重试');return bytes;
 }catch(e){if(e.code==='ELOOP')fail('INVALID_SOURCE','禁止来源符号链接');if(e.code==='ENOENT'||e.code==='EACCES')fail('SOURCE_UNAVAILABLE','导出文件缺失或无读取权限');throw e;}finally{await h?.close();}
}
function utf8(bytes){try{return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{fail('INVALID_SOURCE_ENCODING','来源不是有效UTF-8');}}
export async function readVerifiedPortfolioExport(root,{read=readRegular}={}){
 if(!root)fail('SOURCE_NOT_CONFIGURED','券商只读目录尚未配置');
 const base=await fs.realpath(root).catch(()=>fail('SOURCE_UNAVAILABLE','券商只读挂载不可用'));
 const first=await read(base,'manifest.json',256*1024),m=parsePortfolioManifest(utf8(first));const files={};let total=0;
 for(const f of m.files){
  if((total+=f.bytes)>64*1024*1024)fail('SOURCE_TOO_LARGE','整批来源超过读取上限');
  const bytes=await read(base,f.name,16*1024*1024);
  if(bytes.length!==f.bytes||sha(bytes).toLowerCase()!==f.sha256.toLowerCase())fail('HASH_MISMATCH','导出正在变化或文件校验失败，未覆盖已有数据');
  files[f.name]=utf8(bytes);
 }
 const last=await read(base,'manifest.json',256*1024),end=parsePortfolioManifest(utf8(last));
 if(end.export_id!==m.export_id||sha(last)!==sha(first))fail('SOURCE_CHANGED_RETRY','读取期间manifest改变，整批未导入');
 files['manifest.json']=utf8(first);return files;
}
export function verifyManifestIdentity(files){
 if(files['manifest.json']===undefined)fail('INVALID_MANIFEST','必须通过已校验的manifest读取导出');
 const m=parsePortfolioManifest(files['manifest.json']);for(const f of m.files){if(typeof files[f.name]!=='string'||Buffer.byteLength(files[f.name])!==f.bytes||sha(Buffer.from(files[f.name]))!==f.sha256.toLowerCase())fail('HASH_MISMATCH','导出内容与manifest不符');}let p;try{p=JSON.parse(files['positions_latest.json'].replace(/^\uFEFF/,''));}catch{fail('INVALID_SOURCE','持仓JSON无效');}
 if(m.source.snapshot_id!==p.snapshot_id||Date.parse(m.source.generated_at)!==Date.parse(p.generated_at)||m.source.complete!==p.complete||m.source.stale!==p.stale)fail('MANIFEST_SOURCE_MISMATCH','manifest与实际持仓的身份或状态不一致');
 for(const broker of['moomoo','tiger','futubull'])if(m.source.coverage?.[broker]&&m.source.coverage[broker].ok!==p.coverage?.[broker]?.ok)fail('MANIFEST_SOURCE_MISMATCH','manifest与实际券商覆盖标记不一致');
 return m;
}
