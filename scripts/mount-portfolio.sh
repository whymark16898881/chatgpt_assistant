#!/bin/sh
# Run on Mark only. Mount an existing read-only upstream export; no writer or collector.
set +x
set -eu
umask 077
cfo_root=${CFO_TARGET_DIR:-/volume1/docker/cfo}
cd "$cfo_root"
if [ "$(id -u)" != 0 ]; then echo '请使用 sudo sh ./mount-portfolio.sh'; exit 1; fi
for cfo_command in docker mount findmnt; do
 if ! command -v "$cfo_command" >/dev/null 2>&1; then echo "缺少必要工具：$cfo_command"; exit 1; fi
done
if ! command -v mount.cifs >/dev/null 2>&1; then echo 'NAS未提供mount.cifs，请先使用NAS的SMB远程挂载功能，勿改现有券商服务。'; exit 1; fi
cfo_image=$(docker inspect -f '{{.Config.Image}}' cfo-app-1)
cfo_mount="$cfo_root/portfolio-source"
cfo_cred="$cfo_root/secrets/smb-cfo.cred"
mkdir -p "$cfo_root/secrets" "$cfo_mount"
chmod 700 "$cfo_root/secrets"
if findmnt -rn -M "$cfo_mount" >/dev/null 2>&1; then
 if [ "$(findmnt -rn -M "$cfo_mount" -o FSTYPE)" != cifs ] || [ "$(findmnt -rn -M "$cfo_mount" -o SOURCE)" != '//192.168.1.111/cfo-export' ]; then echo '该目录已挂载其他文件系统，未修改'; exit 1; fi
else
 if [ -n "$(ls -A "$cfo_mount")" ]; then echo '挂载目录非空，未覆盖原文件'; exit 1; fi
 if [ ! -s "$cfo_cred" ]; then
  if [ ! -t 0 ]; then echo '请在NAS交互终端输入cfo只读SMB密码'; exit 1; fi
  trap 'stty echo </dev/tty' EXIT
  printf '输入在jarvis为SMB账号 cfo 设置的密码（不是网页密码；输入不显示）: ' >/dev/tty
  stty -echo </dev/tty
  IFS= read -r cfo_smb_password </dev/tty
  stty echo </dev/tty
  printf '\n' >/dev/tty
  trap - EXIT
  if [ -z "$cfo_smb_password" ]; then echo '密码不能为空，未保存'; exit 1; fi
  cfo_tmp=$(mktemp "$cfo_root/secrets/.smb-cfo.XXXXXX")
  trap 'rm -f "$cfo_tmp"' EXIT
  printf 'username=cfo\npassword=%s\n' "$cfo_smb_password" > "$cfo_tmp"
  chmod 600 "$cfo_tmp"
  mv "$cfo_tmp" "$cfo_cred"
  unset cfo_smb_password
 fi
 chmod 600 "$cfo_cred"
 mount -t cifs '//192.168.1.111/cfo-export' "$cfo_mount" \
  -o "credentials=$cfo_cred,ro,noexec,nosuid,nodev,vers=3.1.1,seal,uid=1000,gid=1000,forceuid,forcegid,file_mode=0440,dir_mode=0550"
fi
for cfo_flag in ro noexec nosuid nodev; do
 if ! findmnt -rn -M "$cfo_mount" -o OPTIONS | grep -Eq "(^|,)$cfo_flag(,|$)"; then echo "现有挂载缺少$cfo_flag，停止检查，不启动同步"; exit 1; fi
done
cfo_summary="$cfo_root/portfolio-source-summary.json"
docker run --rm -i --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
 --user 1000:1000 --mount "type=bind,src=$cfo_mount,dst=/portfolio-source,readonly" \
 --entrypoint node "$cfo_image" --input-type=module > "$cfo_summary" <<'JS'
import {readFile} from 'node:fs/promises';
const m=JSON.parse(await readFile('/portfolio-source/manifest.json','utf8'));
const entries=Array.isArray(m.files)?m.files.map((v,i)=>[String(i),v]):Object.entries(m.files||{});
const allowed=['name','filename','path','status','kept_previous','sha256','source_mtime','size','size_bytes','bytes'];
function pick(v,keys){return Object.fromEntries(keys.filter(k=>v&&Object.hasOwn(v,k)).map(k=>[k,v[k]]));}
const source=pick(m.source,['snapshot_id','generated_at','generated_at_epoch','complete','stale']);
if(m.source?.coverage)source.coverage=Object.fromEntries(Object.entries(m.source.coverage).map(([b,v])=>[b,pick(v,['ok','n_stk','n_opt','started_at'])]));
const out={readonly_mount_verified:true,manifest_fields:Object.keys(m),export_id:m.export_id,exported_at:m.exported_at,source_fields:Object.keys(m.source||{}),source,
 file_count:entries.length,files:entries.map(([key,v])=>({key,fields:typeof v==='object'&&v!==null?Object.keys(v):[typeof v],...pick(v,allowed)}))};
console.log(JSON.stringify(out,null,2));
JS
chmod 600 "$cfo_summary"
if [ -n "${SUDO_UID:-}" ] && [ -n "${SUDO_GID:-}" ]; then
 case "$SUDO_UID:$SUDO_GID" in *[!0-9:]*) :;; *) chown "$SUDO_UID:$SUDO_GID" "$cfo_summary";; esac
fi
echo 'READONLY_EXPORT_MOUNTED：只读挂载与manifest读取成功。尚未启动collector或写入账本。'
printf '非金额结构摘要：%s\n' "$cfo_summary"
echo '请把portfolio-source-summary.json发给Codex；不要发送secrets目录中的凭证。'
