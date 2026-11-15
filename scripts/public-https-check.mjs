// Acceptance fixture: loopback TLS proxy -> cloud-local isolated cfo-020-check.
// Never run against a real NAS ledger. This script logs no passwords/tokens.
import https from 'node:https';
import http from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
const base='https://127.0.0.1:3443';
const key=await readFile('/workspace/scratch/cfo-public-check/tls-key.pem');
const cert=await readFile('/workspace/scratch/cfo-public-check/tls-cert.pem');
const password=(await readFile(process.env.CFO_BROWSER_PASSWORD_FILE||'/workspace/scratch/cfo-020-local/secrets/web-password.txt','utf8')).trim();
const proxy=https.createServer({key,cert},(req,res)=>{
 const upstream=http.request({hostname:'127.0.0.1',port:3202,path:req.url,method:req.method,headers:req.headers},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});
 upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.pipe(upstream);
});
await new Promise(resolve=>proxy.listen(3443,'127.0.0.1',resolve));
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:1000}});
const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
 assert.equal((await context.request.get(base+'/api/state')).status(),401);
 assert.equal((await context.request.get(base+'/api/documents/00000000-0000-4000-8000-000000000000')).status(),401);
 const denied=await context.request.post(base+'/api/login',{headers:{Origin:'https://other.example'},data:{password}});assert.equal(denied.status(),403);
 await page.goto(base);await page.getByLabel('访问密码').fill(password);await page.getByRole('button',{name:'进入私账 →'}).click();await page.getByRole('heading',{name:'财务总览',exact:true}).waitFor();
 const cookies=await context.cookies();const cookie=cookies.find(c=>c.name==='cfo_session');assert.ok(cookie);assert.equal(cookie.secure,true);assert.equal(cookie.httpOnly,true);assert.equal(cookie.sameSite,'Strict');assert.equal(cookie.domain,'127.0.0.1');
 const stateResponse=await context.request.get(base+'/api/state');assert.equal(stateResponse.status(),200);assert.equal(stateResponse.headers()['cache-control'],'no-store');const state=await stateResponse.json();assert.equal(state.report.balance_sheet.balanced,true);assert.equal(state.report.cash_flow.reconciled,true);
 const doc=state.documents[0];assert.ok(doc,'Isolated browser fixture must include its manual note');
 const file=await context.request.get(base+'/api/documents/'+doc.id);assert.equal(file.status(),200);assert.equal(file.headers()['cache-control'],'no-store');assert.match(file.headers()['content-disposition'],/^attachment;/);
 const wrongOrigin=await context.request.post(base+'/api/accounts',{headers:{Origin:'https://finteam.example'},data:{name:'should-not-be-created',kind:'bank',currency:'CNY'}});assert.equal(wrongOrigin.status(),403);
 assert.equal((await context.request.post(base+'/mcp',{data:{}})).status(),401);
 await mkdir('artifacts',{recursive:true});await page.screenshot({path:'artifacts/https-desktop.png',fullPage:true});await page.setViewportSize({width:390,height:844});await page.screenshot({path:'artifacts/https-mobile.png',fullPage:true});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 assert.equal((await context.request.post(base+'/api/logout',{headers:{Origin:base},data:{}})).status(),200);assert.equal((await context.request.get(base+'/api/state')).status(),401);assert.deepEqual(errors,[]);
 console.log('PASS HTTPS proxy: real browser login, Secure/HttpOnly/host-only cookie, private state and download, no-store, sibling-origin rejection, MCP unauthenticated rejection, logout, desktop/mobile.');
}finally{await browser.close();await new Promise(resolve=>proxy.close(resolve));}
