#!/bin/sh
# Run on Mark from /volume1/docker/cfo after Cloudflare hostname/token are ready.
set +x
set -eu
umask 077
if [ ! -f compose.yaml ] || [ ! -f compose.https.yaml ] || [ ! -f compose.cloudflare.yaml ]; then
 echo '请先进入 /volume1/docker/cfo 并上传完整公网配置包'; exit 1
fi
if [ ! -s secrets/web-password.txt ]; then echo '请先完成原 CFO 部署并设置网页密码'; exit 1; fi
if [ ! -s .env.public ]; then
 if [ ! -t 0 ]; then echo '请在NAS交互终端设置域名'; exit 1; fi
 printf 'CFO完整HTTPS网址（例如 https://cfo.example.com）: '
 IFS= read -r cfo_public_origin
 # Validate using the pinned Node image already used by CFO; not a shell eval.
 docker run --rm --network none --env CFO_PUBLIC_ORIGIN="$cfo_public_origin" \
  node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 \
  node -e 'const s=process.env.CFO_PUBLIC_ORIGIN;try{const u=new URL(s);if(u.protocol!=="https:"||u.origin!==s||u.port||u.username||u.password||!/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(u.hostname))throw 0;}catch{console.error("请输入完整HTTPS域名，不带末尾斜杠、端口、用户名或路径");process.exit(1)}'
 printf 'CFO_PUBLIC_ORIGIN=%s\n' "$cfo_public_origin" > .env.public
 chmod 600 .env.public
fi
mkdir -p secrets
chmod 700 secrets
if [ ! -s secrets/cloudflare-tunnel-token.txt ]; then
 if [ ! -t 0 ]; then echo '请在NAS交互终端输入Tunnel token'; exit 1; fi
 trap 'stty echo' EXIT
 printf '粘贴页面完整安装命令或仅Token（输入不显示，不会执行安装命令）: '
 stty -echo
 IFS= read -r cfo_install_text
 stty echo
 printf '\n'
 trap - EXIT
 # Treat pasted installation commands only as text; never eval or execute them.
 case "$cfo_install_text" in
  *' --token '*) cfo_tunnel_token=${cfo_install_text##* --token };;
  *' --token='*) cfo_tunnel_token=${cfo_install_text##* --token=};;
  *' service install '*) cfo_tunnel_token=${cfo_install_text##* service install };;
  *) cfo_tunnel_token=$cfo_install_text;;
 esac
 unset cfo_install_text
 case "$cfo_tunnel_token" in *[!A-Za-z0-9_+/=-]*|'') echo 'Token格式错误，未保存'; exit 1;; esac
 if [ "${#cfo_tunnel_token}" -lt 40 ] || [ "${#cfo_tunnel_token}" -gt 8192 ]; then echo 'Token长度错误，未保存'; exit 1; fi
 printf '%s\n' "$cfo_tunnel_token" > secrets/cloudflare-tunnel-token.txt
 chmod 600 secrets/cloudflare-tunnel-token.txt
 unset cfo_tunnel_token
fi
# Public configuration applies to an existing deployment only; do not rerun setup.
if [ "$(docker inspect -f '{{.State.Health.Status}}' cfo-postgres-1 2>/dev/null)" != healthy ]; then
 echo '正式CFO数据库尚未healthy，请先恢复原应用部署；本脚本不初始化数据库'; exit 1
fi
# Prepare/validate credential before changing the running application's HTTPS mode.
docker compose -f compose.cloudflare.yaml run --rm --no-deps prepare
# All paths and project/volume names are unchanged. No image rebuild or database move.
docker compose --env-file .env.public -f compose.yaml -f compose.https.yaml up -d --no-deps --no-build app
cfo_attempt=0
until curl -fsS http://127.0.0.1:3200/health >/dev/null; do
 cfo_attempt=$((cfo_attempt + 1))
 if [ "$cfo_attempt" -ge 30 ]; then echo 'CFO本地健康检查未通过，请检查app日志；公网连接器尚未启动'; exit 1; fi
 sleep 1
done
docker compose -f compose.cloudflare.yaml up -d --force-recreate connector
docker compose --env-file .env.public -f compose.yaml -f compose.https.yaml ps
docker compose -f compose.cloudflare.yaml ps
echo 'PUBLIC_SETUP_STARTED：请再验证域名、连接器healthy及网页登录。此消息不是公网验收成功。'
