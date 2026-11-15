#!/bin/sh
# Managed by Personal CFO GitHub deployment
set +x
set -eu
umask 077
if [ "$(id -u)" != 0 ]; then echo '请使用sudo执行安装命令'; exit 1; fi
if [ ! -f /volume1/docker/cfo/compose.yaml ] || [ ! -s /volume1/docker/cfo/secrets/web-password.txt ]; then echo '请在运行现有CFO的Mark NAS安装'; exit 1;fi
for tool in curl tar docker flock systemctl; do command -v "$tool" >/dev/null || { echo "缺少工具: $tool"; exit 1; };done
repo=whymark16898881/chatgpt_assistant
sha=$(curl -q -fsSL --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 60 --retry 2 -H 'Accept: application/vnd.github.sha' -H 'User-Agent: Personal-CFO-updater' "https://api.github.com/repos/$repo/commits/stable")
case "$sha" in ''|*[!0-9a-f]*) echo 'GitHub发布标识无效'; exit 1;;esac
if [ "${#sha}" != 40 ]; then echo 'GitHub发布标识长度无效'; exit 1;fi
for file in /usr/local/bin/cfo-update /usr/local/lib/personal-cfo/github-update.sh /etc/systemd/system/cfo-github-update.service /etc/systemd/system/cfo-github-update.timer; do
 if [ -e "$file" ] && ! grep -q '^# Managed by Personal CFO GitHub deployment$' "$file"; then echo "存在其他程序的同名文件，未覆盖: $file"; exit 1;fi
done
mkdir -p /usr/local/lib/personal-cfo /usr/local/bin
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
curl -q -fsSL --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 60 --retry 2 "https://raw.githubusercontent.com/$repo/$sha/scripts/github-update.sh" -o "$scratch/github-update.sh"
grep -q '^# Managed by Personal CFO GitHub deployment$' "$scratch/github-update.sh" || { echo '更新器内容不符'; exit 1; }
sh -n "$scratch/github-update.sh"
cp "$scratch/github-update.sh" /usr/local/lib/personal-cfo/github-update.sh.new
chmod 700 /usr/local/lib/personal-cfo/github-update.sh.new
mv /usr/local/lib/personal-cfo/github-update.sh.new /usr/local/lib/personal-cfo/github-update.sh
cat > "$scratch/cfo-update" <<'WRAPPER'
#!/bin/sh
# Managed by Personal CFO GitHub deployment
exec /bin/sh /usr/local/lib/personal-cfo/github-update.sh "$@"
WRAPPER
cp "$scratch/cfo-update" /usr/local/bin/cfo-update.new
chmod 755 /usr/local/bin/cfo-update.new
mv /usr/local/bin/cfo-update.new /usr/local/bin/cfo-update
# Perform the initial real deployment before enabling unattended updates.
/usr/local/bin/cfo-update --retry
cat > /etc/systemd/system/cfo-github-update.service <<'UNIT'
# Managed by Personal CFO GitHub deployment
[Unit]
Description=Update Personal CFO from verified GitHub stable branch
Wants=network-online.target
After=network-online.target docker.service
RequiresMountsFor=/volume1/docker/cfo
[Service]
Type=oneshot
ExecStart=/usr/local/bin/cfo-update --automatic
TimeoutStartSec=1800
UNIT
cat > /etc/systemd/system/cfo-github-update.timer <<'UNIT'
# Managed by Personal CFO GitHub deployment
[Unit]
Description=Check Personal CFO GitHub releases every 15 minutes
[Timer]
OnBootSec=5min
OnUnitInactiveSec=15min
Unit=cfo-github-update.service
Persistent=true
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now cfo-github-update.timer
/usr/local/bin/cfo-update --status
echo 'GITHUB_AUTO_UPDATE_ENABLED：以后发布stable后NAS自动检查更新；手动可运行sudo cfo-update。'
