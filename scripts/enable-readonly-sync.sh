#!/bin/sh
# Mark NAS only. Adds one CFO-specific systemd unit; existing server/share unchanged.
set +x
set -eu
umask 077
cfo_root=/volume1/docker/cfo
cd "$cfo_root"
if [ "$(id -u)" != 0 ]; then echo '请使用sudo运行'; exit 1; fi
if ! curl -fsS http://127.0.0.1:3200/health | grep -q '"version":"0.4.1"'; then echo '请先升级CFO到0.4.1'; exit 1; fi
for cfo_tool in docker mount findmnt systemctl; do command -v "$cfo_tool" >/dev/null || { echo "缺少$cfo_tool"; exit 1; }; done
if ! findmnt -rn -M "$cfo_root/portfolio-source" >/dev/null 2>&1 || [ ! -s secrets/smb-cfo.cred ]; then echo '请先完成只读挂载'; exit 1; fi
printf 'CFO_PORTFOLIO_DIR=%s\n' "$cfo_root/portfolio-source" > .env.portfolio
chmod 600 .env.portfolio
# Verify a complete batch locally first. Quarantined/stale data stays read-only.
docker compose --env-file .env.portfolio -f compose.yaml -f compose.portfolio.yaml run --rm --no-deps portfolio-sync node scripts/sync-investment-source.mjs
cfo_unit=/etc/systemd/system/cfo-portfolio.service
if [ -e "$cfo_unit" ] && ! grep -q '^# Managed by Personal CFO readonly collector$' "$cfo_unit"; then echo '存在非本项目管理的同名服务，未覆盖'; exit 1; fi
cfo_tmp=$(mktemp /etc/systemd/system/.cfo-portfolio.XXXXXX)
trap 'rm -f "$cfo_tmp"' EXIT
cat > "$cfo_tmp" <<'UNIT'
# Managed by Personal CFO readonly collector
[Unit]
Description=Personal CFO readonly portfolio mount and collector
Wants=network-online.target
After=network-online.target
RequiresMountsFor=/volume1/docker/cfo

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/volume1/docker/cfo
ExecStart=/bin/sh /volume1/docker/cfo/scripts/portfolio-service-start.sh
ExecStop=/bin/sh /volume1/docker/cfo/scripts/portfolio-service-stop.sh
TimeoutStartSec=180
TimeoutStopSec=45
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
UNIT
chmod 644 "$cfo_tmp"
mv "$cfo_tmp" "$cfo_unit"
systemctl daemon-reload
systemctl enable cfo-portfolio.service
if systemctl is-active --quiet cfo-portfolio.service; then systemctl restart cfo-portfolio.service;else systemctl start cfo-portfolio.service;fi
docker compose --env-file .env.portfolio -f compose.yaml -f compose.portfolio.yaml ps portfolio-sync
echo 'READONLY_SYNC_STARTED：每15分钟只读核验，已设置开机恢复。未生成投资账本分录。'
echo '仍需验证上游自动导出已部署：跨轮比较export_id与source.generated_at，旧数据会明确标记过期。'
