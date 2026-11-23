import {configureBookingFx,createBookingFx} from './lib/booking-fx.mjs';
import express from 'express';
import {createPresentationFx} from './lib/presentation-fx.mjs';
import {webPresentation} from './lib/web-presentation.mjs';
import {VERSION} from './lib/version.mjs';
import next from 'next';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {SUPPORTED_PROTOCOL_VERSIONS} from '@modelcontextprotocol/sdk/types.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
// Served only as far as discovery and the unchanged standard calls reach.
const NEGOTIATED_VERSION='2026-07-28';
const REMOVED_IN_NEGOTIATED=['initialize','ping','logging/setLevel','resources/subscribe','resources/unsubscribe'];
import {connectDatabase} from './lib/db.mjs';
import {documentService} from './lib/documents.mjs';
import {financeMcp} from './lib/mcp.mjs';
import {createAuth,equalSecret} from './lib/auth.mjs';
import {createAccount,listAccounts,listEvents,eventPage,processDraftBatch,recordEvent,requestKey,reviseAndPost,reverseEvent,discardDraft,categories,eventSchema} from './lib/ledger.mjs';
import {reports} from './lib/reports.mjs';
import {brokerLedgerStatus,excludeNonBrokerAccounts} from './lib/broker-ledger.mjs';
import {investmentView} from './lib/investment-view.mjs';
import {transactionActionSchema,transactionApplySchema,previewTransactionAction,applyTransactionAction} from './lib/transaction-lifecycle.mjs';
import {documentActionSchema,documentApplySchema} from './lib/document-lifecycle.mjs';
import {analysisOverview,analysisQuerySchema,transactionDetail} from './lib/analysis.mjs';
import {clarifications,answerClarification} from './lib/clarifications.mjs';
import {setRuleEnabled} from './lib/rules.mjs';
import {DISPLAY_CURRENCIES} from './lib/presentation-fx.mjs';

const dev=process.argv.includes('--dev');
const pool=await connectDatabase();
const bookingFx=createBookingFx(pool);configureBookingFx(pool,bookingFx);
void bookingFx.warmToday().catch(()=>{});
const presentationFx=createPresentationFx(pool);
void presentationFx.get().catch(()=>{});
const rateTimer=setInterval(()=>{void presentationFx.get().catch(()=>{});void bookingFx.warmToday().catch(()=>{});},300000);rateTimer.unref();
const presentationFor=req=>presentationFx.resolve(z.enum(['CNY','USD','SGD']).parse(req.query.currency||req.body?.currency||'CNY'),req.query.rate_id||req.body?.rate_id?z.uuid().parse(req.query.rate_id||req.body.rate_id):undefined);
const documents=documentService(pool,process.env.CFO_DATA_DIR||path.resolve('data/originals'));
const password=(await readFile(process.env.CFO_WEB_PASSWORD_FILE||'/run/secrets/web_password','utf8')).trim();
const mcpAuthorization=(await readFile(process.env.CFO_MCP_AUTHORIZATION_FILE||'/run/cfo/mcp-authorization','utf8')).trim();
if(!/^Bearer [a-f0-9]{64}$/.test(mcpAuthorization))throw new Error('Configure a dedicated MCP authorization secret');
const auth=createAuth(password,{secureCookie:process.env.CFO_SECURE_COOKIE==='true'});
const app=express();app.disable('x-powered-by');app.use(express.json({limit:'1mb'}));
app.use((req,res,next)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('X-Frame-Options','DENY');next();});
app.get('/health/investment-ledger',async(req,res)=>{res.setHeader('Cache-Control','no-store');try{const s=await brokerLedgerStatus(pool);res.json({status:s.status,opening_count:s.summary?.opening_count||0,period_count:s.summary?.period_count||0,reason_codes:[...new Set((s.summary?.reasons||[]).map(x=>x.code))],history_headers:(s.summary?.history_headers||[]).filter(x=>/^[a-z_.]{1,60}$/i.test(x)),history_fields:s.summary?.history_fields||[],history_sections:s.summary?.history_sections||[],last_checked:s.last_checked});}catch{res.status(503).json({status:'unavailable'});}});
app.get('/health/booking-rates',(req,res)=>{res.setHeader('Cache-Control','no-store');res.json(bookingFx.status());});
app.get('/health/presentation',(req,res)=>{res.setHeader('Cache-Control','no-store');res.json(presentationFx.status());});
app.get('/health',async(req,res)=>{try{await pool.query('SELECT 1');res.json({status:'ready',version:VERSION});}catch{res.status(503).json({status:'not_ready'});}});
app.get(['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp'],(req,res)=>res.status(404).json({error:'not_advertised'}));
// The tool list is fixed at build time, so take it once rather than standing up a
// server per request.
let inventory=null;
async function toolInventory(){
 if(inventory)return inventory;
 const [clientSide,serverSide]=InMemoryTransport.createLinkedPair();
 const server=financeMcp(pool,documents),client=new Client({name:'inventory',version:'1'});
 try{
  await server.connect(serverSide);await client.connect(clientSide);
  inventory=(await client.listTools()).tools;
  return inventory;
 }finally{await client.close().catch(()=>{});await server.close().catch(()=>{});}
}
app.post('/mcp',async(req,res)=>{
 if(!equalSecret(req.headers.authorization,mcpAuthorization))return res.status(401).json({error:'Unauthorized'});
 const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined});const server=financeMcp(pool,documents);
 res.on('close',()=>{void transport.close();void server.close();});
 // Temporary: the connector's refresh probe is rejected as malformed JSON-RPC and
 // we have never seen what it actually sends. Log only requests that are not a
 // standard MCP call — a probe carries protocol fields, never ledger data — so the
 // compatibility fix can be written against the real shape instead of a guess.
 const body=req.body;
 const shaped=body&&typeof body==='object'&&!Array.isArray(body)&&body.jsonrpc==='2.0'&&typeof body.method==='string';
 const standard=shaped&&/^(initialize|ping|tools\/|resources\/|prompts\/|completion\/|logging\/|notifications\/)/.test(body.method);
 if(standard)console.log('MCP_CALL '+JSON.stringify({method:body.method,id:body.id??null}));
 else console.log('MCP_UNUSUAL_REQUEST '+JSON.stringify({method:shaped?body.method:null,type:Array.isArray(body)?'array':typeof body,keys:body&&typeof body==='object'?Object.keys(body).slice(0,12):null,body:JSON.stringify(body??null).slice(0,600)}));
 // A POST with no body carries no JSON-RPC message to answer. The SDK reads that
 // as a parse failure and returns 400, which the connector treats as the whole
 // exchange having failed — and a refresh that sends one then reports an error
 // the user cannot act on. Nothing was asked, so acknowledge and return nothing.
 if(body===undefined||body===null||(typeof body==='object'&&!Array.isArray(body)&&!Object.keys(body).length))return res.status(202).end();
 // server/discover is OpenAI's own method: absent from the MCP spec and from the
 // SDK, which answers Method not found. Refreshing a connector's tools goes
 // through it and nothing else, so that answer leaves the user with a refresh
 // that always fails. Its params carry what initialize carries, and the name says
 // discovery, so answer with what initialize returns plus the tool list — a
 // client reading either half finds what it came for.
 // Discovery is how a connector refreshes its tools, and the SDK does not
 // implement it: the method belongs to a protocol version newer than the one this
 // SDK knows, so it answers Method not found and a refresh can never succeed.
 // The result carries versions and capabilities only — the tool list stays with
 // tools/list, which discovery is meant to precede rather than replace. Report
 // the versions actually supported rather than echoing what the client asked for,
 // so a mismatch surfaces as a mismatch instead of being papered over.
 // Everything below applies only when the client says it speaks the newer
 // revision. The SDK serves every other client exactly as before; a client on the
 // handshake-based versions must keep finding initialize where it left it.
 const negotiated=shaped&&body.params?._meta?.['io.modelcontextprotocol/protocolVersion']===NEGOTIATED_VERSION;
 // That revision drops the handshake, so these no longer exist. Answering 200 to
 // a method the version removed tells the client the opposite of the truth.
 if(negotiated&&REMOVED_IN_NEGOTIATED.includes(body.method))
  return res.status(404).json({jsonrpc:'2.0',id:body.id,error:{code:-32601,message:'Method not found'}});
 // Results there carry cache metadata. The SDK writes the older shape straight to
 // the response, so this one is answered here instead of being handed over.
 if(negotiated&&body.method==='tools/list'){
  try{
   return res.json({jsonrpc:'2.0',id:body.id,result:{
    resultType:'complete',
    tools:await toolInventory(),
    ttlMs:0,
    cacheScope:'private',
    _meta:{'io.modelcontextprotocol/serverInfo':{name:'personal-cfo',version:VERSION}}}});
  }catch(e){console.log('MCP_INVENTORY_FAILED '+String(e&&e.message).slice(0,200));}
 }
 if(shaped&&body.method==='server/discover')return res.json({jsonrpc:'2.0',id:body.id,result:{
  resultType:'complete',
  // The client speaks a version newer than this SDK knows. Discovery is
  // implemented here and the standard calls are unchanged at the JSON-RPC level,
  // so the refresh path is genuinely served — but the rest of that version is
  // not, and listing it is a deliberate claim rather than a complete one.
  supportedVersions:[...new Set([NEGOTIATED_VERSION,...SUPPORTED_PROTOCOL_VERSIONS])],
  capabilities:{tools:{listChanged:false}},
  ttlMs:0,
  cacheScope:'private',
  _meta:{'io.modelcontextprotocol/serverInfo':{name:'personal-cfo',version:VERSION}}}});
 try{await server.connect(transport);await transport.handleRequest(req,res,req.body);}catch{if(!res.headersSent)res.status(500).json({error:'Tool request failed'});}
});
app.all('/mcp',(req,res)=>res.status(405).end());
const attempts=new Map();
app.use('/api',(req,res,next)=>{
 res.setHeader('Cache-Control','no-store');
 if(req.method!=='GET'){
  const origin=req.headers.origin;const expected=process.env.CFO_PUBLIC_ORIGIN||`${req.protocol}://${req.get('host')}`;
  if(origin && origin!==expected)return res.status(403).json({error:'请求来源不匹配'});
  if(!req.is('application/json'))return res.status(415).json({error:'请发送JSON请求'});
 }
 if(['/login','/logout'].includes(req.path))return next();
 if(!auth.valid(auth.fromRequest(req)))return res.status(401).json({error:'请先登录'});
 next();
});
app.post('/api/login',(req,res)=>{
 const key=req.ip;const now=Date.now();const a=attempts.get(key)||{count:0,until:now+15*60000};
 if(a.until<now){a.count=0;a.until=now+15*60000;}
 if(a.count>=8)return res.status(429).json({error:'尝试次数过多，请稍后再试'});
 if(!auth.checkPassword(typeof req.body?.password==='string'?req.body.password:'')){
  a.count++;if(attempts.size>10000)attempts.clear();attempts.set(key,a);return res.status(401).json({error:'密码不正确'});
 }
 attempts.delete(key);res.setHeader('Set-Cookie',auth.cookie(auth.issue()));res.json({ok:true});
});
app.post('/api/logout',(req,res)=>{res.setHeader('Set-Cookie',auth.cookie('',0));res.json({ok:true});});
const route=fn=>async(req,res,next)=>{try{const result=await fn(req,res);if(!res.headersSent)res.json(result);}catch(e){next(e);}};
const uuid=id=>z.uuid().parse(id);
app.get('/api/state',route(async req=>{
 const month=req.query.month||new Date(Date.now()+8*3600000).toISOString().slice(0,7);
 const [accounts,events,docs,report,cats,investments,deleted_events]=await Promise.all([listAccounts(pool),listEvents(pool),documents.list(),reports(pool,String(month)),categories(pool),investmentView(pool,{month:String(month)}),listEvents(pool,{onlyDeleted:true})]);
 const data={accounts,events,deleted_events,documents:docs,report,categories:cats,investments};
 if(req.query.currency){const p=await presentationFor(req);return{...data,presentation:await webPresentation(pool,data,p)};}return data;
}));
app.get('/api/events/page',route(async req=>{
 const page=await eventPage(pool,{status:req.query.status,search:req.query.search,include_zero:req.query.include_zero==='true',limit:req.query.limit===undefined?20:Number(req.query.limit),offset:req.query.offset===undefined?0:Number(req.query.offset)});
 const p=await presentationFor(req),month=String(req.query.month||new Date(Date.now()+8*3600000).toISOString().slice(0,7));
 const data={accounts:await listAccounts(pool),events:page.events,deleted_events:[],report:await reports(pool,month)};
 const display=await webPresentation(pool,data,p);return{...page,events:display.events};
}));
app.get('/api/presentation-rates',route(()=>presentationFx.get()));
app.get('/api/analysis',route(async req=>{const {currency,rate_id,...query}=req.query;return analysisOverview(pool,analysisQuerySchema.parse({...query,unclassified:req.query.unclassified==='true',unknown_merchant:req.query.unknown_merchant==='true',limit:req.query.limit===undefined?30:Number(req.query.limit),offset:req.query.offset===undefined?0:Number(req.query.offset)}),await presentationFor(req));}));
// One question, one answer, one rule: the clarification list converts a standing
// judgement into something the capture gate can apply on its own next time.
app.get('/api/clarifications',route(async req=>{
 const currency=z.enum(DISPLAY_CURRENCIES).parse(req.query.currency||'CNY');
 const snapshot=await presentationFx.get().catch(()=>null);
 return clarifications(pool,{currency,rates:snapshot?.rates||{CNY:'1'},rate_date:snapshot?.rate_date||null});
}));
app.post('/api/clarifications/answer',route(req=>answerClarification(pool,req.body)));
app.post('/api/rules/:id/disable',route(req=>setRuleEnabled(pool,uuid(req.params.id),false)));
app.post('/api/transactions/actions/preview',route(async req=>previewTransactionAction(pool,transactionActionSchema.parse(req.body),await presentationFor(req))));
app.post('/api/transactions/actions/apply',route(async req=>applyTransactionAction(pool,transactionApplySchema.parse(req.body),await presentationFor(req))));
app.get('/api/transactions/:id',route(async req=>transactionDetail(pool,uuid(req.params.id),await presentationFor(req))));
app.post('/api/accounts',route(req=>createAccount(pool,req.body)));
app.post('/api/events',route(async req=>{
 const request_key=z.string().min(8).max(200).parse(req.body.request_key);
 const payload=eventSchema.parse(req.body.payload);
 let document_id=req.body.document_id?uuid(req.body.document_id):null;
 if(!document_id){const bytes=Buffer.from(JSON.stringify({type:'user_manual_note',request_key,payload}));document_id=(await documents.saveBytes({file_name:'手工录入凭证.json'},{bytes,mime:'application/json'})).id;}
 return recordEvent(pool,{document_id,source_ref:req.body.source_ref||'manual:1',request_key,payload,auto_post:true});
}));
app.post('/api/investments/exclusions',route(req=>{if(req.body.confirmed!==true)throw new Error('需要明确确认这些归类不包含三家券商');return excludeNonBrokerAccounts(pool,req.body.account_ids);}));
app.post('/api/events/drafts/batch',route(req=>processDraftBatch(pool,req.body)));
app.post('/api/events/:id/resolve',route(req=>reviseAndPost(pool,uuid(req.params.id),req.body)));
app.post('/api/events/:id/discard',route(req=>discardDraft(pool,uuid(req.params.id))));
app.post('/api/events/:id/reverse',route(req=>reverseEvent(pool,uuid(req.params.id),req.body)));
app.get('/api/documents',route(req=>documents.inventory({status:req.query.status||'active',limit:Number(req.query.limit||25),offset:Number(req.query.offset||0)})));
app.post('/api/documents/actions/preview',route(req=>documents.preview(documentActionSchema.parse(req.body))));
app.post('/api/documents/actions/apply',route(req=>documents.apply(documentApplySchema.parse(req.body))));
app.get('/api/documents/:id',route(async(req,res)=>{
 const d=await documents.read(uuid(req.params.id));res.setHeader('Content-Type',d.mime_type);
 res.setHeader('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(d.filename)}`);res.send(d.bytes);
}));
app.use('/api',(req,res)=>res.status(404).json({error:'接口不存在'}));
app.use((error,req,res,next)=>{
 if(res.headersSent)return next(error);
 if(error.code==='DOCUMENT_PURGED')return res.status(410).json({error:error.message});
 if(error.code==='DOCUMENT_SELECTION_CHANGED'||error.code==='TRANSACTION_ACTION_CONFLICT')return res.status(409).json({error:error.message});
 const message=error.name==='ZodError'?'字段格式不正确':error.code?'操作未完成，请检查服务状态':error.message;
 res.status(400).json({error:message});
});
const web=next({dev,dir:process.cwd()});await web.prepare();app.use((req,res)=>web.getRequestHandler()(req,res));
const listener=app.listen(Number(process.env.PORT||3000),process.env.HOST||'127.0.0.1',()=>console.log('Personal CFO '+VERSION+' ready'));
async function shutdown(){listener.close();await pool.end();process.exit(0);}process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
