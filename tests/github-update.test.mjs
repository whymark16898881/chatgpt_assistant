import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';import path from 'node:path';import{execFile}from'node:child_process';import{promisify}from'node:util';
const exec=promisify(execFile),updater=path.resolve('scripts/github-update.sh');
async function fixture(){
 const dir=await mkdtemp(path.join(tmpdir(),'cfo-github-update-')),root=path.join(dir,'live CFO'),state=path.join(dir,'deploy state'),bin=path.join(dir,'bin'),src=path.join(dir,'repo');
 for(const p of[bin,path.join(root,'secrets'),path.join(src,'scripts'),path.join(src,'lib')])await mkdir(p,{recursive:true});
 await writeFile(path.join(root,'compose.yaml'),'original-compose\n');await writeFile(path.join(root,'secrets/web-password.txt'),'synthetic-password');await writeFile(path.join(root,'financial-sentinel'),'DO_NOT_CHANGE');
 await writeFile(path.join(src,'scripts/upgrade-existing.sh'),`#!/bin/sh\nset -eu\nprintf 'new-compose\\n' > "$CFO_TARGET_DIR/compose.yaml"\nprintf 'attempt\\n' >> "$CFO_MOCK_LOG"\nif [ "\${CFO_MOCK_FAIL:-0}" = 1 ]; then exit 23; fi\nprintf 'ready\\n' > "$CFO_TARGET_DIR/deployed"\n`);
 for(const[name,body]of[['scripts/backup.sh','#!/bin/sh\nexit 0\n'],['Dockerfile','FROM scratch\n'],['compose.yaml','name: cfo\n'],['lib/version.mjs',"export const VERSION='0.3.4';\n"]])await writeFile(path.join(src,name),body);
 const archive=path.join(dir,'source.tar.gz');await exec('tar',['-czf',archive,'-C',dir,'repo']);
 await writeFile(path.join(bin,'curl'),`#!/usr/bin/env node\nconst fs=require('node:fs'),a=process.argv.slice(2),u=a.find(x=>x.startsWith('https://')||x.startsWith('http://'));if(u?.includes('/commits/stable'))process.stdout.write(process.env.CFO_MOCK_SHA);else if(u?.includes('codeload.github.com'))fs.copyFileSync(process.env.CFO_MOCK_ARCHIVE,a[a.indexOf('-o')+1]);else if(u?.includes('/health'))console.log('{"status":"ready","version":"0.3.4"}');else process.exit(8);\n`,{mode:0o755});
 await writeFile(path.join(bin,'docker'),`#!/bin/sh\nprintf '%s\\n' "$*" >> "$CFO_MOCK_DOCKER_LOG"\ncase "$*" in *' ps -q app') echo fixture-app;; *'{{.Image}}'*) echo sha256:1111111111111111111111111111111111111111111111111111111111111111;; esac\n`,{mode:0o755});
 const env={...process.env,PATH:bin+':'+process.env.PATH,CFO_DEPLOY_TEST_MODE:'isolated',CFO_TARGET_DIR:root,CFO_DEPLOY_ROOT:state,CFO_MOCK_SHA:'a'.repeat(40),CFO_MOCK_ARCHIVE:archive,CFO_MOCK_LOG:path.join(dir,'attempts'),CFO_MOCK_DOCKER_LOG:path.join(dir,'docker-log'),CFO_UPDATER_INSTALLED_PATH:path.join(dir,'not-installed')};
 return{dir,root,state,env,run:async(mode='update',extra={})=>exec('sh',[updater,mode],{env:{...env,...extra}}),close:()=>rm(dir,{recursive:true,force:true})};
}
async function exists(p){try{await access(p);return true;}catch{return false;}}
test('GitHub updater downloads an immutable SHA once, deploys once, preserves financial files and then skips',async()=>{
 const f=await fixture();try{const first=await f.run();assert.match(first.stdout,/GITHUB_DEPLOY_READY/);assert.equal((await readFile(path.join(f.state,'applied-commit'),'utf8')).trim(),f.env.CFO_MOCK_SHA);await f.run('--automatic');assert.equal((await readFile(f.env.CFO_MOCK_LOG,'utf8')).trim(),'attempt');assert.equal(await readFile(path.join(f.root,'financial-sentinel'),'utf8'),'DO_NOT_CHANGE');assert.equal(await readFile(path.join(f.root,'secrets/web-password.txt'),'utf8'),'synthetic-password');}finally{await f.close();}
});
test('check-only and malformed remote identifiers cannot start deployment',async()=>{
 const f=await fixture();try{await f.run('--check');assert.equal(await exists(f.env.CFO_MOCK_LOG),false);await assert.rejects(f.run('update',{CFO_MOCK_SHA:'../../wrong'}));assert.equal(await exists(f.env.CFO_MOCK_LOG),false);}finally{await f.close();}
});
test('failed deployment restores code configuration, records failure, skips automatic retries and allows explicit retry',async()=>{
 const f=await fixture();try{await assert.rejects(f.run('update',{CFO_MOCK_FAIL:'1'}),e=>e.code===23);assert.equal(await readFile(path.join(f.root,'compose.yaml'),'utf8'),'original-compose\n');assert.equal((await readFile(path.join(f.state,'failed-commit'),'utf8')).trim(),f.env.CFO_MOCK_SHA);assert.equal(await exists(path.join(f.state,'applied-commit')),false);await f.run('--automatic');assert.equal((await readFile(f.env.CFO_MOCK_LOG,'utf8')).trim(),'attempt');await f.run('--retry');assert.equal((await readFile(f.env.CFO_MOCK_LOG,'utf8')).trim().split('\n').length,2);assert.equal(await exists(path.join(f.state,'failed-commit')),false);assert.equal(await readFile(path.join(f.root,'financial-sentinel'),'utf8'),'DO_NOT_CHANGE');assert.match(await readFile(f.env.CFO_MOCK_DOCKER_LOG,'utf8'),/--no-deps --no-build app/);}finally{await f.close();}
});
test('an unrelated pre-existing deploy directory is never overwritten',async()=>{
 const f=await fixture();try{await mkdir(f.state);await writeFile(path.join(f.state,'other-project'),'keep');await assert.rejects(f.run());assert.equal(await readFile(path.join(f.state,'other-project'),'utf8'),'keep');assert.equal(await exists(f.env.CFO_MOCK_LOG),false);}finally{await f.close();}
});
test('updater refuses a state directory inside the live financial application',async()=>{
 const f=await fixture();try{await assert.rejects(f.run('update',{CFO_DEPLOY_ROOT:path.join(f.root,'nested-state')}));assert.equal(await exists(f.env.CFO_MOCK_LOG),false);assert.equal(await readFile(path.join(f.root,'financial-sentinel'),'utf8'),'DO_NOT_CHANGE');}finally{await f.close();}
});
