#!/bin/sh
# Keep the formal connector independent of the historical cfo-test directory.
set +x
set -eu
umask 077
cd "${CFO_TARGET_DIR:-/volume1/docker/cfo}"
mkdir -p secrets
destination=secrets/openai-runtime-key.txt
if [ -e "$destination" ] || [ -L "$destination" ]; then
 if [ ! -f "$destination" ] || [ ! -s "$destination" ] || [ -L "$destination" ]; then echo '正式运行凭证无效，未覆盖；请在NAS本地检查'; exit 1; fi
 chmod 600 "$destination"
 echo '正式运行凭证已存在，保持原值；未输出凭证。'
 exit 0
fi
source=${CFO_RUNTIME_KEY_SOURCE:-../cfo-test/secrets/openai-runtime-key.txt}
if [ ! -f "$source" ] || [ ! -s "$source" ]; then echo '未找到可复用的运行凭证，请在NAS本地配置；不要发到聊天'; exit 1; fi
temporary=$(mktemp secrets/.openai-runtime-key.XXXXXX)
trap 'rm -f "$temporary"' EXIT
cat "$source" > "$temporary"
chmod 600 "$temporary"
# Atomic no-clobber publication; do not replace a credential created concurrently.
ln "$temporary" "$destination"
echo '正式运行凭证已在NAS本地准备；原测试凭证未修改，凭证未输出。'
