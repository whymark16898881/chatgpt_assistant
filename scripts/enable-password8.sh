#!/bin/sh
# In-place source upgrade for existing NAS CFO 0.2.0; does not change any password.
set +x
set -eu
if [ ! -f compose.yaml ] || [ ! -f Dockerfile ]; then echo '请在 /volume1/docker/cfo 中运行'; exit 1; fi
if [ "$(docker inspect -f '{{.State.Health.Status}}' cfo-postgres-1 2>/dev/null)" != healthy ]; then echo '请先确认CFO数据库healthy'; exit 1; fi
docker run --rm --network none --user 0:0 --mount "type=bind,src=$(pwd),dst=/work" \
 --entrypoint node personal-cfo:0.2.0 --input-type=module -e '
import * as fs from "node:fs";import path from "node:path";
const names=["lib/auth.mjs","scripts/init.mjs","scripts/deploy.sh"];
const planned=names.map(name=>{const dest="/work/"+name;if(fs.existsSync(dest)&&!fs.statSync(dest).isFile())throw new Error("Expected regular source file: "+name);const s=fs.readFileSync(fs.existsSync(dest)?dest:"/app/"+name,"utf8");let n=s;
if(name.endsWith(".mjs")){if(!s.includes("password.length<12")&&!s.includes("password.length<8"))throw new Error("Unrecognized password policy; refusing patch");n=s.replaceAll("password.length<12","password.length<8").replaceAll("at least 12 characters","at least 8 characters");}
else n=s.replaceAll("至少12位","至少8位").replaceAll(" -lt 12 "," -lt 8 ");return{dest,s,n};});
const backup="/work/.password8-source-backup-"+Date.now();fs.mkdirSync(backup,{mode:0o700});
for(const p of planned){fs.mkdirSync(path.dirname(p.dest),{recursive:true});fs.writeFileSync(backup+"/"+path.basename(p.dest),p.s,{mode:0o600});fs.writeFileSync(p.dest,p.n,{mode:0o644});}
console.log("Password policy source updated to minimum 8; previous source privately saved. Existing password unchanged.");'
docker compose -f compose.yaml build app
# Verify the actual image before replacing the running app.
docker run --rm --network none --entrypoint node personal-cfo:0.2.0 --input-type=module \
 -e 'import{createAuth}from"/app/lib/auth.mjs";createAuth("Ab12!xyZ");let rejected=false;try{createAuth("Ab12!xy")}catch{rejected=true}if(!rejected)process.exit(1);console.log("PASS: image accepts 8 and rejects 7")'
if [ -s .env.public ]; then
 docker compose --env-file .env.public -f compose.yaml -f compose.https.yaml up -d --no-deps --no-build app
else
 docker compose -f compose.yaml up -d --no-deps --no-build app
fi
echo 'PASSWORD8_ENABLED：现有密码保持不变；现在可以运行 sh ./change-password.sh 设置8位或更长密码。'
