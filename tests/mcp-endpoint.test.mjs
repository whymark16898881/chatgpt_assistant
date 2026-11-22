// The /mcp endpoint is the only door the model comes through, so both halves of
// it are worth holding: nothing gets past the bearer check, and a POST carrying
// no message is acknowledged rather than rejected. A 400 there reads to the
// connector as the whole exchange failing, which surfaces to the user as a
// refresh error they cannot act on.
import {test,after,before} from 'node:test';import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import path from 'node:path';import {randomBytes} from 'node:crypto';

const DB=process.env.DATABASE_URL||(await readFile('.env.test','utf8')).trim().split('DATABASE_URL=')[1];
if(!new URL(DB).pathname.endsWith('_test'))throw new Error('Isolated test database required');

const dir=await mkdtemp(path.join(tmpdir(),'cfo-mcp-'));
const auth='Bearer '+randomBytes(32).toString('hex');
const port=3400+Math.floor(Math.random()*400);
let child;

before(async()=>{
 await writeFile(path.join(dir,'web'),'Ab12!xyZ',{mode:0o600});
 await writeFile(path.join(dir,'mcp'),auth,{mode:0o600});
 child=spawn(process.execPath,['server.mjs'],{env:{...process.env,DATABASE_URL:DB,CFO_DATA_DIR:path.join(dir,'data'),
  CFO_WEB_PASSWORD_FILE:path.join(dir,'web'),CFO_MCP_AUTHORIZATION_FILE:path.join(dir,'mcp'),PORT:String(port),NODE_ENV:'production'},stdio:'ignore'});
 for(let i=0;i<60;i++){
  try{if((await fetch(`http://127.0.0.1:${port}/health`)).ok)return;}catch{}
  await new Promise(r=>setTimeout(r,500));
 }
 throw new Error('服务没能起来');
});
after(async()=>{child?.kill();await rm(dir,{recursive:true,force:true});});

const post=(body,headers={})=>fetch(`http://127.0.0.1:${port}/mcp`,{method:'POST',
 headers:{Authorization:auth,'Content-Type':'application/json',Accept:'application/json, text/event-stream',...headers},
 ...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})});

test('the bearer check comes first, whatever the body is',async()=>{
 const bad={Authorization:'Bearer '+'0'.repeat(64)};
 assert.equal((await post(undefined,bad)).status,401,'空 body 也不能绕过鉴权');
 assert.equal((await post({jsonrpc:'2.0',id:1,method:'tools/list',params:{}},bad)).status,401);
 assert.equal((await post(undefined,{Authorization:''})).status,401,'不带凭证必须 401');
});

test('a POST with no message is acknowledged, not rejected',async()=>{
 // Answering 400 here is what made a tool refresh report failure.
 assert.equal((await post(undefined)).status,202,'空 body 应 202');
 assert.equal((await post('')).status,202,'空字符串 body 应 202');
 assert.equal((await post({})).status,202,'空对象 body 应 202');
});

test('real calls still work, and an unknown method answers in JSON-RPC rather than failing',async()=>{
 const list=await post({jsonrpc:'2.0',id:1,method:'tools/list',params:{}});
 assert.equal(list.status,200);

 // server/discover is OpenAI's own extension, absent from the spec and from the
 // SDK. It must still come back as a well-formed JSON-RPC error carrying the
 // request's id, so the client can match the reply to what it asked.
 const probe=await post({jsonrpc:'2.0',id:'openai-mcp-discover',method:'server/discover',params:{}});
 assert.equal(probe.status,200,'未知方法不该用 HTTP 错误回应');
 const text=await probe.text();
 assert.match(text,/"id":"openai-mcp-discover"/,'响应必须带回请求的 id');
 assert.match(text,/-32601/,'应是标准的 Method not found');
});
