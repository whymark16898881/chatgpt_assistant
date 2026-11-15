#!/bin/sh
# Run in the new /volume1/docker/cfo folder. Prompts locally; never prints secrets.
set +x
set -eu
if [ ! -f Dockerfile ] || [ ! -f compose.yaml ] || [ ! -f lib/ledger.mjs ]; then
  echo '请先进入完整的新 cfo 文件夹'; exit 1
fi
if [ "$(basename "$(pwd)")" = cfo-test ]; then echo '请勿在旧 cfo-test 中安装正式账本'; exit 1; fi
umask 077
mkdir -p secrets
chmod 700 secrets
if [ ! -s secrets/web-password.txt ]; then
 if [ ! -t 0 ]; then echo '请在交互式NAS终端运行，以便设置网页密码'; exit 1; fi
 trap 'stty echo' EXIT
 printf '设置网页密码（至少8位，输入不显示）: '
 stty -echo
 IFS= read -r cfo_web_password
 printf '\n再次输入: '
 IFS= read -r cfo_web_confirm
 stty echo
 printf '\n'
 trap - EXIT
 if [ "${#cfo_web_password}" -lt 8 ] || [ "$cfo_web_password" != "$cfo_web_confirm" ]; then echo '密码长度不足或两次不一致，未保存'; exit 1; fi
 printf '%s\n' "$cfo_web_password" > secrets/web-password.txt
 chmod 600 secrets/web-password.txt
 unset cfo_web_password cfo_web_confirm
fi
if [ -s .env.public ]; then
 docker compose --env-file .env.public -f compose.yaml -f compose.https.yaml up -d --build
 docker compose --env-file .env.public -f compose.yaml -f compose.https.yaml ps
else
 docker compose up -d --build
 docker compose ps
fi
