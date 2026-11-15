import {promises as fs} from 'node:fs';
import {randomBytes} from 'node:crypto';
const root='/run/cfo';await fs.mkdir(root,{recursive:true});
async function secret(name,value,pattern){const file=root+'/'+name;try{await fs.writeFile(file,value+'\n',{flag:'wx',mode:0o400});await fs.chown(file,1000,1000);}catch(e){if(e.code!=='EEXIST')throw e;if(!pattern.test((await fs.readFile(file,'utf8')).trim()))throw new Error('Invalid existing credential; refusing overwrite');}}
await secret('db-password',randomBytes(32).toString('hex'),/^[a-f0-9]{64}$/);
await secret('mcp-authorization','Bearer '+randomBytes(32).toString('hex'),/^Bearer [a-f0-9]{64}$/);
const password=(await fs.readFile('/run/secrets/web_password','utf8')).trim();if(password.length<8)throw new Error('Web password must have at least 8 characters');
await fs.writeFile(root+'/web-password',password+'\n',{mode:0o400});await fs.chown(root+'/web-password',1000,1000);
await fs.mkdir('/data/originals',{recursive:true});await fs.chown('/data',1000,1000);await fs.chown('/data/originals',1000,1000);
console.log('Private credentials ready; values are not logged.');
