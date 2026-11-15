// Only for the isolated Compose check project, not for a real ledger.
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const base='http://127.0.0.1:3202';
assert.equal((await fetch(base+'/health')).status,200);assert.equal((await fetch(base+'/api/state')).status,401);
assert.equal((await fetch(base+'/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
const password=(await readFile('/workspace/scratch/cfo-020-local/secrets/web-password.txt','utf8')).trim();
const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password})});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
const badOrigin=await fetch(base+'/api/accounts',{method:'POST',headers:{'Content-Type':'application/json','Cookie':cookie,'Origin':'https://untrusted.example'},body:'{}'});assert.equal(badOrigin.status,403);
const state=await fetch(base+'/api/state',{headers:{Cookie:cookie}});assert.equal(state.status,200);assert.equal((await state.json()).report.currency,'CNY');
const env={...process.env};for(const key of['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH'])delete env[key];
const authorization=execFileSync('docker',['--host=unix:///var/run/docker.sock','exec','cfo-020-check-app-1','cat','/run/cfo/mcp-authorization'],{env,encoding:'utf8'}).trim();
const client=new Client({name:'http-check',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{Authorization:authorization}}}));
try{const health=await client.callTool({name:'cfo_health',arguments:{}});assert.equal(health.structuredContent.database,'reachable');const tools=await client.listTools();assert.equal(tools.tools.length,12);}finally{await client.close();}
console.log('HTTP PASS: Docker health, authenticated web state, unauthorized web/MCP blocked, cross-origin write blocked, real MCP HTTP health and 12 tool discovery.');
