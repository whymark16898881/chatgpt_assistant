import {readFile,mkdir,open,rename,chmod,chown} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
const token=(await readFile('/run/secrets/cloudflare_tunnel_token','utf8')).trim();
if(!/^[A-Za-z0-9_+/=-]{40,8192}$/.test(token))throw new Error('Invalid token file format; value is not logged');
const dir='/run/cfo-cloudflare';await mkdir(dir,{recursive:true});await chmod(dir,0o700);await chown(dir,65532,65532);
const tmp=dir+'/.token-'+randomUUID();const h=await open(tmp,'wx',0o400);
try{await h.writeFile(token+'\n');await h.sync();await h.chown(65532,65532);}finally{await h.close();}
await rename(tmp,dir+'/tunnel-token');
console.log('Connector credential prepared; value is not logged.');
