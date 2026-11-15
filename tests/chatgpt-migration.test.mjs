import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
const script=path.resolve('scripts/migrate-chatgpt-connector.sh');
const expected='tunnel_6af4529b32cc8191b39327c4cdded4ce';
async function fixture(fn){
 const root=await mkdtemp(path.join(tmpdir(),'cfo-migration-'));
 try{
  const target=path.join(root,'formal CFO'),bin=path.join(root,'bin'),stateFile=path.join(root,'docker-state.json');
  await mkdir(path.join(target,'secrets'),{recursive:true});await mkdir(path.join(target,'scripts'));await mkdir(bin);
  for(const file of ['compose.yaml','compose.chatgpt.yaml','compose.https.yaml'])await writeFile(path.join(target,file),'services: {}\n');
  await writeFile(path.join(target,'.env.public'),'CFO_PUBLIC_ORIGIN=https://example.invalid\n');
  await writeFile(path.join(target,'secrets/web-password.txt'),'SYNTHETIC_PASSWORD_ONLY\n');
  await writeFile(path.join(target,'secrets/openai-runtime-key.txt'),'SYNTHETIC_CREDENTIAL_ONLY\n');
  await copyFile('scripts/prepare-chatgpt-credential.sh',path.join(target,'scripts/prepare-chatgpt-credential.sh'));
  const initial={old:{id:'old-id',tunnel:expected,running:true,restart:'unless-stopped',project:'cfo-test',service:'tunnel'},new:null,actions:[]};
  await writeFile(stateFile,JSON.stringify(initial));
  await writeFile(path.join(bin,'docker'),`#!/usr/bin/env node
const fs=require('node:fs');const file=process.env.CFO_MOCK_STATE,a=process.argv.slice(2),s=JSON.parse(fs.readFileSync(file));
const save=()=>fs.writeFileSync(file,JSON.stringify(s));const exit=n=>{save();process.exit(n)};
s.actions.push(a);
function container(id){if(id==='cfo-test-tunnel-1'||id===s.old.id)return s.old;if(id===s.new?.id)return s.new;if(id==='cfo-app-1')return{health:'healthy'};throw Error('unknown container '+id)}
if(a[0]==='inspect'){
 const c=container(a.at(-1)),fmt=a[2];
 if(fmt.includes('.Config.Env'))console.log('CONTROL_PLANE_TUNNEL_ID='+c.tunnel+'\\nMCP_SERVER_URL=http://app:3210/mcp');
 else if(fmt.includes('com.docker.compose.project'))console.log(c.project);
 else if(fmt.includes('com.docker.compose.service'))console.log(c.service);
 else if(fmt.includes('Health.Status'))console.log(c.health);
 else if(fmt.includes('.State.Running'))console.log(c.running);
 else if(fmt.includes('RestartPolicy.Name'))console.log(c.restart);
 else if(fmt.includes('MaximumRetryCount'))console.log(0);
 else if(fmt==='{{.Id}}')console.log(c.id);else exit(99);
}else if(a[0]==='compose'){
 if(a.includes('exec')){if(process.env.CFO_MOCK_PREFLIGHT_FAIL==='1')exit(18);console.log('{"event":"formal_mcp_local_check","status":"ready"}')}
 else if(a.includes('ps')){if(s.new)console.log(s.new.id)}
 else if(a.includes('up')&&a.includes('--no-start')){if(process.env.CFO_MOCK_CREATE_FAIL==='1')exit(17);if(!s.new)s.new={id:'new-id',tunnel:s.old.tunnel,running:false,restart:'unless-stopped'};}
 else if(a.includes('up')){if(process.env.CFO_MOCK_START_FAIL==='1')exit(19);s.new.running=true;}
 else exit(98);
}else if(a[0]==='update'){container(a.at(-1)).restart=a[1].slice('--restart='.length)}
else if(a[0]==='stop'){container(a[1]).running=false}
else if(a[0]==='start'){container(a[1]).running=true}
else if(a[0]==='logs'){console.log('tunnel metadata fetched\\npoller started')}
else exit(97);
exit(0);
`,{mode:0o755});
  const env={...process.env,CFO_TARGET_DIR:target,CFO_MOCK_STATE:stateFile,PATH:bin+path.delimiter+process.env.PATH};
  const run=(mode='migrate',extra={})=>spawnSync('sh',[script,mode],{env:{...env,...extra},encoding:'utf8'});
  const state=async()=>JSON.parse(await readFile(stateFile,'utf8'));
  const change=async fn=>{const s=await state();fn(s);await writeFile(stateFile,JSON.stringify(s));};
  await fn({root,target,run,state,change});
 }finally{await rm(root,{recursive:true,force:true});}
}
test('existing plugin migration preflights formal tools, prepares before stopping, and never runs two clients',()=>fixture(async({target,run,state})=>{
 const result=run();assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/CHATGPT_CONNECTOR_SWITCHED/);assert.ok(!result.stdout.includes('SYNTHETIC_CREDENTIAL_ONLY'));
 const s=await state();assert.equal(s.old.running,false);assert.equal(s.old.restart,'no');assert.equal(s.new.running,true);assert.equal(s.new.restart,'unless-stopped');assert.equal(s.new.tunnel,expected);
 const actions=s.actions.map(a=>a.join(' '));assert.ok(actions.findIndex(a=>a.includes('up --no-start --no-deps --no-build'))<actions.findIndex(a=>a==='stop cfo-test-tunnel-1'));assert.ok(actions.findIndex(a=>a==='stop cfo-test-tunnel-1')<actions.findIndex(a=>a.includes('up -d --no-deps')));
 assert.ok(actions.some(a=>a.includes('exec -T app node scripts/check-chatgpt.mjs')));assert.ok(!actions.some(a=>a.includes('down')||a.includes('rm ')));
 assert.equal(await readFile(path.join(target,'secrets/web-password.txt'),'utf8'),'SYNTHETIC_PASSWORD_ONLY\n');
}));
test('a completed switch is idempotent and does not interrupt the formal connector',()=>fixture(async({run,state})=>{
 assert.equal(run().status,0);const before=(await state()).actions.length;const r=run();assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/ALREADY_MIGRATED/);assert.ok(!(await state()).actions.slice(before).some(a=>['stop','start','update'].includes(a[0])));
}));
test('failed formal connector start restores original running state and restart policy',()=>fixture(async({run,state})=>{
 const r=run('migrate',{CFO_MOCK_START_FAIL:'1'});assert.notEqual(r.status,0);assert.match(r.stdout,/ROLLED_BACK/);const s=await state();assert.equal(s.old.running,true);assert.equal(s.old.restart,'unless-stopped');assert.equal(s.new.running,false);assert.equal(s.new.restart,'no');
 assert.equal(run().status,0);const repaired=await state();assert.equal(repaired.new.restart,'unless-stopped');assert.equal(repaired.old.running,false);
}));
test('wrong tunnel identity or conflicting formal configuration leaves original connector untouched',()=>fixture(async({target,run,state,change})=>{
 await change(s=>{s.old.tunnel='tunnel_OTHER';});assert.notEqual(run().status,0);assert.equal((await state()).old.running,true);assert.ok(!(await state()).actions.some(a=>a[0]==='stop'));
 await change(s=>{s.old.tunnel=expected;});await writeFile(path.join(target,'.env.chatgpt'),'CFO_TUNNEL_ID=tunnel_OTHER\n');assert.notEqual(run().status,0);assert.equal((await state()).old.restart,'unless-stopped');
}));
test('preflight or image preparation failure never stops the old connector',()=>fixture(async({run,state})=>{
 for(const flag of ['CFO_MOCK_PREFLIGHT_FAIL','CFO_MOCK_CREATE_FAIL'])assert.notEqual(run('migrate',{[flag]:'1'}).status,0);
 const s=await state();assert.equal(s.old.running,true);assert.equal(s.old.restart,'unless-stopped');assert.ok(!s.actions.some(a=>a[0]==='stop'));
}));
test('explicit rollback restores the original connector without deleting data or credentials',()=>fixture(async({run,state})=>{
 assert.equal(run().status,0);const r=run('--rollback');assert.equal(r.status,0,r.stderr);const s=await state();assert.equal(s.old.running,true);assert.equal(s.old.restart,'unless-stopped');assert.equal(s.new.running,false);assert.equal(s.new.restart,'no');
}));
test('repairing a later stopped formal client retains the original rollback baseline',()=>fixture(async({run,state,change})=>{
 assert.equal(run().status,0);await change(s=>{s.new.running=false;});assert.equal(run().status,0);assert.equal(run('--rollback').status,0);const s=await state();assert.equal(s.old.running,true);assert.equal(s.old.restart,'unless-stopped');assert.equal(s.new.running,false);
}));
