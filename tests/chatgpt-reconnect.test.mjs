import{test}from'node:test';
import assert from'node:assert/strict';
import{mkdtemp,mkdir,writeFile,readFile,rm}from'node:fs/promises';
import{tmpdir}from'node:os';
import path from'node:path';
import{spawnSync}from'node:child_process';
const script=path.resolve('scripts/reconnect-chatgpt.sh');
async function fixture(fn){const root=await mkdtemp(path.join(tmpdir(),'cfo-reconnect-'));try{
 const bin=path.join(root,'bin'),log=path.join(root,'calls.jsonl');await mkdir(bin);await writeFile(path.join(root,'compose.yaml'),'services: {}\n');
 await writeFile(path.join(bin,'sleep'),'#!/bin/sh\nexit 0\n',{mode:0o755});
 await writeFile(path.join(bin,'docker'),`#!/usr/bin/env node
const fs=require('node:fs'),a=process.argv.slice(2);fs.appendFileSync(process.env.CFO_MOCK_LOG,JSON.stringify(a)+'\\n');
if(a[0]==='ps'){
 if(!a.includes('label=com.docker.compose.project=cfo')||!a.includes('label=com.docker.compose.service=tunnel')||!a.includes('label=com.docker.compose.oneoff=False'))process.exit(90);
 if(process.env.CFO_MOCK_NONE!=='1')console.log(process.env.CFO_MOCK_MULTI==='1'?'formal-one\\nformal-two':'formal-one');
}else if(a[0]==='compose')console.log('app-one');
else if(a[0]==='inspect')console.log(process.env.CFO_MOCK_UNHEALTHY==='1'?'starting':'healthy');
else if(a[0]==='exec'){if(process.env.CFO_MOCK_CHECK_FAIL==='1')process.exit(7);console.log('{"event":"formal_mcp_local_check","status":"ready"}');}
else if(a[0]==='restart'){if(a[1]!=='formal-one')process.exit(91);console.log('formal-one');}
else process.exit(92);
`,{mode:0o755});
 const run=(extra={})=>spawnSync('sh',[script],{encoding:'utf8',env:{...process.env,PATH:bin+path.delimiter+process.env.PATH,CFO_TARGET_DIR:root,CFO_PROJECT_NAME:'cfo',CFO_MOCK_LOG:log,...extra}});
 const calls=async()=> (await readFile(log,'utf8')).trim().split('\n').map(s=>JSON.parse(s));await fn({run,calls});
}finally{await rm(root,{recursive:true,force:true});}}
test('upgrade reconnects only the running formal OpenAI client after actual local MCP check',()=>fixture(async({run,calls})=>{
 const r=run();assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/MCP_CONNECTOR_RECONNECTED/);const a=await calls();assert.ok(a.findIndex(c=>c[0]==='exec')<a.findIndex(c=>c[0]==='restart'));assert.deepEqual(a.filter(c=>c[0]==='restart'),[['restart','formal-one']]);assert.ok(!JSON.stringify(a).includes('cfo-test'));assert.ok(!JSON.stringify(a).includes('cloudflare'));
}));
test('a stopped or unconfigured formal client is not activated',()=>fixture(async({run,calls})=>{
 const r=run({CFO_MOCK_NONE:'1'});assert.equal(r.status,0);assert.match(r.stdout,/SKIPPED/);assert.equal((await calls()).length,1);
}));
test('ambiguous clients, unhealthy app or failed MCP checks cannot yield a successful reconnect',()=>fixture(async({run,calls})=>{
 for(const flag of['CFO_MOCK_MULTI','CFO_MOCK_UNHEALTHY','CFO_MOCK_CHECK_FAIL'])assert.notEqual(run({[flag]:'1'}).status,0);
 assert.ok(!(await calls()).some(c=>c[0]==='restart'));
}));
