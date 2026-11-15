import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { performance } from 'node:perf_hooks';
import { ProbeError, policyError, timeoutError } from './errors.mjs';
import { parseURL, validateAddresses, hostClass, knownHosts } from './policy.mjs';

const REDIRECTS = new Set([301,302,303,307,308]);
const MIME = new Set(['image/png','image/jpeg','application/pdf']);
function normalizeMime(value) { const s=String(value||'').split(';')[0].trim().toLowerCase();return s==='image/jpg'?'image/jpeg':s; }
function mimeAllowed(mime) { return !mime || mime==='application/octet-stream' || MIME.has(mime); }
function actualMime(bytes) {
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
  if(bytes[0]===255 && bytes[1]===216 && bytes[2]===255)return 'image/jpeg';
  if(bytes.subarray(0,5).toString()==='%PDF-')return 'application/pdf';
  throw new ProbeError('UNSUPPORTED_TYPE','Only PNG, JPEG and PDF file headers are supported.');
}
function abortable(promise, signal, ms) {
  return new Promise((resolve,reject)=>{
    const fail=()=>done(reject,timeoutError());
    const timer=setTimeout(fail,Math.max(1,ms));
    const done=(fn,value)=>{clearTimeout(timer);signal.removeEventListener('abort',fail);fn(value);};
    signal.addEventListener('abort',fail,{once:true});
    if(signal.aborted)return fail();
    promise.then(v=>done(resolve,v),()=>done(reject,new ProbeError('DNS_FAILED','DNS lookup failed.',{retryable:true,retryAction:'retry_tool'})));
  });
}
export function createDownloader({
  resolve=hostname=>lookup(hostname,{all:true,verbatim:true}), request=https.request,
  log=event=>console.info(JSON.stringify(event)),
  policy=process.env.CFO_PROBE_DOWNLOAD_POLICY || 'public_https',
  legacyHosts=(process.env.CFO_PROBE_DOWNLOAD_HOSTS||[...knownHosts].join(',')).split(',').map(x=>x.trim().toLowerCase()),
  legacySubdomains=process.env.CFO_PROBE_ALLOW_OPENAI_FILE_SUBDOMAINS!=='false',
  totalMs=20000, connectMs=5000, idleMs=10000, maxBytes=10*1024*1024, maxRedirects=3
}={}) {
  if(!['public_https','allowlist'].includes(policy))throw policyError();
  const rules={policy,legacyHosts,legacySubdomains};
  return async function download(file) {
    const start=performance.now(), deadline=start+totalMs;
    const controller=new AbortController();
    const totalTimer=setTimeout(()=>controller.abort(),totalMs);
    const signal=controller.signal;
    const remaining=()=>Math.max(0,deadline-performance.now());
    async function oneRequest(url) {
      const began=performance.now();let ipClass='not_resolved';
      const observation=code=>log({hostname:url.hostname,host_class:hostClass(url.hostname),ip_class:ipClass,error_code:code,elapsed_ms:Math.round(performance.now()-began)});
      try {
        const addresses=validateAddresses(await abortable(Promise.resolve().then(()=>resolve(url.hostname)),signal,Math.min(connectMs,remaining())));
        ipClass='public_unicast';
        if(signal.aborted || remaining()<=0)throw timeoutError();
        const pinned=addresses[0];
        const pinnedLookup=(hostname,options,callback)=>{
          if(typeof options==='function'){callback=options;options={};}
          if(hostname!==url.hostname)return callback(policyError());
          queueMicrotask(()=>options?.all ? callback(null,[{address:pinned.address,family:pinned.family}]) : callback(null,pinned.address,pinned.family));
        };
        // Never use the process globalAgent: Node can enable environment proxies on it.
        const agent=new https.Agent({keepAlive:false,maxSockets:1,proxyEnv:{}});
        const result=await new Promise((resolveResponse,reject)=>{
          let req,res,done=false,idleTimer;
          const connectTimer=setTimeout(()=>finish(timeoutError()),Math.max(1,Math.min(connectMs-(performance.now()-began),remaining())));
          const onAbort=()=>finish(timeoutError());
          function finish(error,value) {
            if(done)return;done=true;
            clearTimeout(connectTimer);clearTimeout(idleTimer);signal.removeEventListener('abort',onAbort);
            if(error){res?.destroy();req?.destroy();reject(error);}else{resolveResponse(value);res?.destroy();}
            agent.destroy();
          }
          function resetIdle(){clearTimeout(idleTimer);idleTimer=setTimeout(()=>finish(timeoutError()),Math.max(1,Math.min(idleMs,remaining())));}
          signal.addEventListener('abort',onAbort,{once:true});
          if(signal.aborted)return onAbort();
          try {
            req=request({
              protocol:'https:',hostname:url.hostname,port:443,path:url.pathname+url.search,method:'GET',
              servername:url.hostname,rejectUnauthorized:true,lookup:pinnedLookup,autoSelectFamily:false,agent,
              headers:{Accept:'image/png,image/jpeg,application/pdf,application/octet-stream','Accept-Encoding':'identity'}
            },response=>{
              res=response;clearTimeout(connectTimer);
              const status=res.statusCode||0;
              if(status!==200)return finish(null,{status,headers:res.headers});
              const declared=normalizeMime(res.headers['content-type']);
              if(!mimeAllowed(declared) || !['','identity'].includes(String(res.headers['content-encoding']||'')))return finish(new ProbeError('UNSUPPORTED_TYPE','Unsupported response type or content encoding.'));
              const len=res.headers['content-length'];
              if(len!==undefined && (!/^\d+$/.test(String(len)) || Number(len)>maxBytes))return finish(new ProbeError('TOO_LARGE','File exceeds the size limit.'));
              let size=0;const chunks=[];resetIdle();
              res.on('data',chunk=>{
                size+=chunk.length;
                if(size>maxBytes)return finish(new ProbeError('TOO_LARGE','File exceeds the size limit.'));
                chunks.push(chunk);resetIdle();
              });
              res.on('end',()=>{
                if(done)return;
                const bytes=Buffer.concat(chunks);let mime;
                try {
                  mime=actualMime(bytes);
                  for(const claimed of [declared,normalizeMime(file.mime_type)]) {
                    if(!mimeAllowed(claimed) || (MIME.has(claimed) && claimed!==mime))throw new ProbeError('UNSUPPORTED_TYPE','Declared MIME does not match the file header.');
                  }
                }catch(e){return finish(e);}
                finish(null,{status,bytes,mime});
              });
              res.on('aborted',()=>finish(new ProbeError('UPSTREAM_RETRYABLE','Upstream response ended early.',{retryable:true,retryAction:'retry_tool'})));
              res.on('error',()=>finish(new ProbeError('UPSTREAM_RETRYABLE','Upstream response failed.',{retryable:true,retryAction:'retry_tool'})));
            });
            req.on('socket',socket=>socket.once('secureConnect',()=>{clearTimeout(connectTimer);resetIdle();}));
            req.on('error',error=>{
              const tlsError=/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/.test(String(error.code||''));
              finish(tlsError?policyError():new ProbeError('UPSTREAM_RETRYABLE','Upstream connection failed.',{retryable:true,retryAction:'retry_tool'}));
            });
            req.end();
          }catch{finish(policyError());}
        });
        observation(result.status===200?'OK':`HTTP_${result.status}`);
        return result;
      }catch(e){if(e.code==='PRIVATE_DESTINATION')ipClass='non_public';observation(e instanceof ProbeError?e.code:'POLICY_REJECTED');throw e;}
    }
    async function attempt() {
      let raw=file.download_url;const visited=new Set();
      for(let hops=0;;hops++) {
        const url=parseURL(raw,rules);
        if(visited.has(url.href))throw policyError();visited.add(url.href);
        const r=await oneRequest(url);
        if(r.status===200)return r;
        if(REDIRECTS.has(r.status)) {
          if(hops>=maxRedirects || !r.headers.location)throw policyError();
          try {raw=new URL(r.headers.location,url).href;}catch{throw policyError();}
          continue;
        }
        if(r.status===403 || r.status===404)throw new ProbeError('LINK_EXPIRED_RETRY_TOOL','Link is expired or unavailable. Invoke the tool again to request a fresh attachment URL.',{retryable:true,retryAction:'refresh_url_and_retry_tool'});
        if(r.status===429 || (r.status>=500 && r.status<=599)) {
          const header=r.headers['retry-after'];let wait=250;
          if(header)wait=/^\d+$/.test(header)?Number(header)*1000:Math.max(0,Date.parse(header)-Date.now());
          throw new ProbeError('UPSTREAM_RETRYABLE','Upstream service is temporarily unavailable.',{retryable:true,retryAction:'retry_tool',internalRetry:true,retryAfterMs:Number.isFinite(wait)?Math.max(250,wait):250});
        }
        throw new ProbeError('POLICY_REJECTED','Upstream HTTP status is not supported.');
      }
    }
    try {
      for(let tries=0;;tries++) {
        try {return await attempt();}catch(e){
          if(!(e instanceof ProbeError) || !e.internalRetry || tries>=1 || e.retryAfterMs>=remaining())throw e;
          await abortable(new Promise(r=>setTimeout(r,e.retryAfterMs)),signal,remaining());
        }
      }
    }finally{clearTimeout(totalTimer);controller.abort();}
  };
}
