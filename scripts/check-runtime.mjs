// Compile server-side modules without running them or touching credentials/DB.
import {readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url)),files=[path.join(root,'server.mjs')];
async function walk(dir){for(const entry of await readdir(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory()&&!['node_modules','.git'].includes(entry.name))await walk(full);else if(entry.isFile()&&entry.name.endsWith('.mjs'))files.push(full);}}
for(const dir of ['lib','scripts','probe'])await walk(path.join(root,dir));
for(const file of files){const r=spawnSync(process.execPath,['--check',file],{encoding:'utf8',timeout:10000});if(r.status!==0){process.stderr.write(r.stderr||'Runtime syntax check failed: '+path.relative(root,file)+'\n');process.exit(1);}}
console.log('Runtime syntax verified ('+files.length+' modules).');
