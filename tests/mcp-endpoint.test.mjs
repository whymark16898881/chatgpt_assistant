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

test('standard calls keep working, and an unknown method answers in JSON-RPC',async()=>{
 assert.equal((await post({jsonrpc:'2.0',id:1,method:'tools/list',params:{}})).status,200);
 assert.equal((await post({jsonrpc:'2.0',id:2,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'t',version:'1'}}})).status,200);
 const unknown=await post({jsonrpc:'2.0',id:'u1',method:'totally/unknown',params:{}});
 assert.equal(unknown.status,200,'未知方法不该用 HTTP 错误回应');
 const text=await unknown.text();
 assert.match(text,/"id":"u1"/,'响应必须带回请求的 id');
 assert.match(text,/-32601/);
});

test('server/discover answers in the DiscoverResult shape, not Method not found',async()=>{
 // Refreshing a connector's tools goes through this method and nothing else, so
 // answering Method not found leaves the user with a refresh that always fails.
 const r=await post({jsonrpc:'2.0',id:'openai-mcp-discover',method:'server/discover',
  params:{_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28',
   'io.modelcontextprotocol/clientInfo':{name:'openai-mcp (Codex)',version:'1.0.0'}}}});
 assert.equal(r.status,200);
 const d=await r.json();
 assert.equal(d.id,'openai-mcp-discover','必须带回请求的 id，否则客户端匹配不上');
 assert.ok(!d.error,'不能再回 Method not found');
 for(const k of ['resultType','supportedVersions','capabilities','ttlMs','cacheScope'])
  assert.ok(k in d.result,`DiscoverResult 缺必填字段 ${k}`);
 assert.equal(d.result.resultType,'complete');
 assert.equal(d.result.cacheScope,'private');
 assert.equal(typeof d.result.ttlMs,'number');
 assert.ok(d.result.ttlMs>=0,'ttlMs 不能为负');
 assert.equal(d.result._meta['io.modelcontextprotocol/serverInfo'].name,'personal-cfo');

 // Report what is actually supported. Echoing the client's version would hide a
 // mismatch instead of letting it surface.
 assert.ok(Array.isArray(d.result.supportedVersions)&&d.result.supportedVersions.length);
 assert.ok(d.result.supportedVersions.includes('2025-06-18'),'SDK 原本支持的版本不能丢');
 assert.ok(d.result.supportedVersions.includes('2026-07-28'),'发现与标准调用在这一版上确实可用，要列出来，否则客户端停在发现阶段');
 assert.equal(new Set(d.result.supportedVersions).size,d.result.supportedVersions.length,'版本列表不能重复');

 // Discovery precedes tools/list rather than replacing it.
 assert.ok(!('tools' in d.result),'工具清单不属于发现响应');
 assert.equal((await post({jsonrpc:'2.0',id:9,method:'tools/list',params:{}})).status,200);
});

const META={'io.modelcontextprotocol/protocolVersion':'2026-07-28'};

test('the newer revision gets its own shapes, and the older path is untouched',async()=>{
 // Only requests that say they speak the newer revision take the new paths. A
 // client on the handshake-based versions must keep finding initialize working.
 const modern=await post({jsonrpc:'2.0',id:1,method:'tools/list',params:{_meta:META}});
 assert.equal(modern.status,200);
 const m=await modern.json();
 for(const k of ['resultType','tools','ttlMs','cacheScope'])
  assert.ok(k in m.result,`新版 tools/list 缺必填字段 ${k}`);
 assert.equal(m.result.resultType,'complete');
 assert.ok(m.result.tools.some(t=>t.name==='cfo_rules_add'),'工具清单应是真的那份');

 // The handshake is gone in that revision, so these must not answer as if present.
 for(const method of ['initialize','ping','logging/setLevel','resources/subscribe','resources/unsubscribe']){
  const r=await post({jsonrpc:'2.0',id:'x',method,params:{_meta:META}});
  assert.equal(r.status,404,`${method} 在新版下应 404`);
  const e=await r.json();
  assert.equal(e.error.code,-32601);
  assert.equal(e.id,'x','错误响应也要带回 id');
 }

 // Without that _meta, nothing changes.
 assert.equal((await post({jsonrpc:'2.0',id:2,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'t',version:'1'}}})).status,200);
 const old=await post({jsonrpc:'2.0',id:3,method:'tools/list',params:{}});
 assert.equal(old.status,200);
 assert.ok(!(await old.text()).includes('cacheScope'),'旧路径不该被改成新格式');
});
