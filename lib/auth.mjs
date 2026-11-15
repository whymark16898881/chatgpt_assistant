import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
export function equalSecret(a,b){const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length && timingSafeEqual(x,y);}
export function createAuth(password,{secureCookie=false,now=()=>Date.now()}={}){
 if(password.length<8)throw new Error('Web password must have at least 8 characters');
 const key=createHmac('sha256',password).update('personal-cfo-session-v1').digest();
 const sign=s=>createHmac('sha256',key).update(s).digest('base64url');
 function issue(){const p=Buffer.from(JSON.stringify({expiry:now()+12*3600*1000,nonce:randomBytes(16).toString('hex')})).toString('base64url');return p+'.'+sign(p);}
 function valid(token){try{const [p,s,...rest]=token.split('.');return !rest.length&&equalSecret(s,sign(p))&&JSON.parse(Buffer.from(p,'base64url').toString()).expiry>now();}catch{return false;}}
 function fromRequest(req){const part=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('cfo_session='));return part?.slice('cfo_session='.length)||'';}
 function cookie(token,maxAge=43200){return `cfo_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secureCookie?'; Secure':''}`;}
 return{valid,issue,cookie,fromRequest,checkPassword:value=>equalSecret(value,password)};
}
