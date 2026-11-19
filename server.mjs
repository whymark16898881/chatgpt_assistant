import express from 'express';
import {createPresentationFx} from './lib/presentation-fx.mjs';
import {webPresentation} from './lib/web-presentation.mjs';
import {VERSION} from './lib/version.mjs';
import next from 'next';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {connectDatabase} from './lib/db.mjs';
import {documentService} from './lib/documents.mjs';
import {financeMcp} from './lib/mcp.mjs';
import {createAuth,equalSecret} from './lib/auth.mjs';
import {createAccount,listAccounts,listEvents,eventPage,processDraftBatch,recordEvent,requestKey,reviseAndPost,reverseEvent,discardDraft,categories,eventSchema} from './lib/ledger.mjs';
import {reports} from './lib/reports.mjs';
import {investmentView} from './lib/investment-view.mjs';
import {transactionActionSchema,transactionApplySchema,previewTransactionAction,applyTransactionAction} from './lib/transaction-lifecycle.mjs';
import {documentActionSchema,documentApplySchema} from './lib/document-lifecycle.mjs';
import {analysisOverview,analysisQuerySchema,transactionDetail} from './lib/analysis.mjs';

const dev=process.argv.includes('--dev');
const pool=await connectDatabase();
const presentationFx=createPresentationFx(pool);
void presentationFx.get().catch(()=>{});
const rateTimer=setInterval(()=>{void presentationFx.get().catch(()=>{});},300000);rateTimer.unref();
const presentationFor=req=>presentationFx.resolve(z.enum(['CNY','USD','SGD']).parse(req.query.currency||req.body?.currency||'CNY'),req.query.rate_id||req.body?.rate_id?z.uuid().parse(req.query.rate_id||req.body.rate_id):undefined);
const documents=documentService(pool,process.env.CFO_DATA_DIR||path.resolve('data/originals'));
const password=(await readFile(process.env.CFO_WEB_PASSWORD_FILE||'/run/secrets/web_password','utf8')).trim();
const mcpAuthorization=(await readFile(process.env.CFO_MCP_AUTHORIZATION_FILE||'/run/cfo/mcp-authorization','utf8')).trim();
if(!/^Bearer [a-f0-9]{64}$/.test(mcpAuthorization))throw new Error('Configure a dedicated MCP authorization secret');
const auth=createAuth(password,{secureCookie:process.env.CFO_SECURE_COOKIE==='true'});
const app=express();app.disable('x-powered-by');app.use(express.json({limit:'1mb'}));
app.use((req,res,next)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('X-Frame-Options','DENY');next();});
app.get('/health/presentation',(req,res)=>{res.setHeader('Cache-Control','no-store');res.json(presentationFx.status());});
app.get('/health',async(req,res)=>{try{await pool.query('SELECT 1');res.json({status:'ready',version:VERSION});}catch{res.status(503).json({status:'not_ready'});}});
app.get(['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp'],(req,res)=>res.status(404).json({error:'not_advertised'}));
app.post('/mcp',async(req,res)=>{
 if(!equalSecret(req.headers.authorization,mcpAuthorization))return res.status(401).json({error:'Unauthorized'});
 const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined});const server=financeMcp(pool,documents);
 res.on('close',()=>{void transport.close();void server.close();});
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
