#!/bin/sh
set +x
set -eu
umask 077
if [ ! -f compose.yaml ] || [ ! -f scripts/init.mjs ]; then echo '请在完整CFO项目目录运行'; exit 1; fi
if [ ! -t 0 ]; then echo '请在NAS交互终端运行'; exit 1; fi
trap 'stty echo </dev/tty' EXIT
printf '输入新密码（至少8位，输入不显示）: ' >/dev/tty
stty -echo </dev/tty
IFS= read -r cfo_password </dev/tty
printf '\n再次输入: ' >/dev/tty
IFS= read -r cfo_confirm </dev/tty
stty echo </dev/tty
printf '\n' >/dev/tty
trap - EXIT
if [ "$cfo_password" != "$cfo_confirm" ]; then echo '两次输入不同，未修改密码'; exit 1; fi
cfo_app_image=$(docker inspect -f '{{.Config.Image}}' cfo-app-1)
# Pass the password over stdin, never in argv, environment or logs.
printf '%s' "$cfo_password" | docker run --rm -i --network none --entrypoint node "$cfo_app_image" \
 --input-type=module -e 'import{createAuth}from"/app/lib/auth.mjs";let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{if(s!==s.trim())throw new Error("密码首尾不能有空格");createAuth(s)}catch{console.error("当前版本需要至少8位密码且首尾不能有空格；未修改密码。若尚未升级，请先执行enable-password8.sh。");process.exit(1)}})'
cfo_tmp=$(mktemp secrets/.web-password.XXXXXX)
trap 'rm -f "$cfo_tmp"' EXIT
printf '%s\n' "$cfo_password" > "$cfo_tmp"
chmod 600 "$cfo_tmp"
mv "$cfo_tmp" secrets/web-password.txt
unset cfo_password cfo_confirm
docker compose run --rm --no-deps setup
docker compose restart app
echo 'PASSWORD_CHANGED：请用新密码重新登录；旧会话失效。'
