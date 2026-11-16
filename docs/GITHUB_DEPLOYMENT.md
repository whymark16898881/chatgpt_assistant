# GitHub 管理与 NAS 自动更新

代码仓库： https://github.com/whymark16898881/chatgpt_assistant

## 分支与发布

- `main`：开发代码。
- `stable`：完成验证、允许 NAS 部署的代码。
- `v0.3.4` 等标签：可追溯的版本记录。

开发者完成测试、类型检查和构建后，将验证过的提交推送到 `stable`。NAS 每15分钟检查一次；使用完整 commit SHA 下载对应源码，不在运行中的目录执行 git reset。当前未设置 GitHub Actions 自动晋级；发布由开发者明确推进 stable。

## 首次安装

在已有 CFO 的 NAS SSH 终端运行一次（发布后也可用完整 commit SHA 替换 stable 固定安装脚本）：

```sh
curl -fsSL https://raw.githubusercontent.com/whymark16898881/chatgpt_assistant/stable/scripts/install-github-updater.sh | sudo sh
```

脚本先执行一次真实升级，成功后才启用 systemd 定时检查。无需 GitHub Token，不需要在 NAS 安装 Git。安装要求 Docker Compose、curl、tar、flock 和 systemd。

## 日常操作

```sh
sudo cfo-update           # 立即检查并更新
sudo cfo-update --check   # 只比较 GitHub / NAS 提交
sudo cfo-update --status  # 查看部署提交及本地健康状态
sudo cfo-update --retry   # 排障完成后重试失败版本
sudo journalctl -u cfo-github-update.service -n 80 --no-pager
```

定时服务为 `cfo-github-update.timer`。暂停自动更新：`sudo systemctl disable --now cfo-github-update.timer`。这不会停止 CFO 网站。

## 数据保护与失败处理

升级前备份源码、数据库、票据、应用凭证及私有配置。数据库备份期间会短暂停止应用和该项目的采集器，之后恢复。备份只在 NAS 的 `cfo-backups` 目录，不上传 GitHub。

保留现有 `.env*`、`secrets`、数据库卷、原件卷和只读共享挂载；公网连接器独立运行，不随应用更新。部署状态及下载源码位于独立的 `cfo-deploy` 目录。

构建、版本检查或应用健康检查失败时，记录失败 commit 并尝试恢复旧镜像与 Compose 配置；同一失败版本暂停自动重试。数据库不会自动回退，需检查日志与健康状态后处理。未来涉及不兼容数据库迁移的版本须先制定迁移和回退步骤，不能假定旧镜像支持新 schema。

## 投资结果新鲜度

接收端采用每天两次发布节奏。发布时账户观测必须在90分钟内；允许早晚发布窗口间保留已验证结果，并保留真实 `as_of`。生产端75分钟发布闸提供余量，不能把导出时刻当成余额观测时刻。

失败 manifest 条目保留在 `files[]`，允许缺失元数据并明确失败状态；成功项必须具有完整可验证元数据。失败或过期结果不会变成零余额，也不会自动入账。

## NAS 旧目录清理

首次 GitHub 部署与网页、采集器验收通过后再清理；先用 `docker ps -a` 与容器 Mounts、systemd 的 WorkingDirectory/ExecStart 检查路径引用。

- `cfo`：正式应用目录，保留，包含私有配置与共享挂载。
- `cfo-backups`：恢复备份，保留；后续另行制定保留周期。
- `cfo-deploy`：GitHub 更新状态与源码缓存，保留。
- `cfo-update-0.3.0` 至 `cfo-update-0.3.4`：旧解压安装包；确认无容器挂载或服务引用后可清理。
- `cfo-manifest-check`、`cfo-null-fix`：排障工具目录；确认无挂载或服务引用后可清理。
- `cfo-test`：早期独立测试项目；先确认服务、测试原图与回执是否还需保留，再决定停用与归档，不能随旧安装包一起删除。
- `Open`、`tailscale`：其他项目，不属于 CFO 清理范围。

本说明不执行删除，不删除 Docker 数据卷、只读共享或上游 `_staging`。

## 已验收的 CFO 网页入口与数据路径

CFO 网页已使用 Mark 宿主上的独立 Cloudflare Tunnel（cfo-mark / cfo-public-connector-1），域名为 `cfo.markalpha.net`。网页源站是同宿主 HTTP `127.0.0.1:3200`，映射容器3000；该宿主映射没有对LAN开放。VM `192.168.1.111` 的 localhost 不是此源站，也无法直接访问这个仅回环绑定的端口。

CFO 未通过宿主80/443的NAS界面或自签反代提供网页源站，不需要为这条现有路由配置 `noTLSVerify`。公网使用HTTPS，应用已有密码登录和受保护账本接口；原入口不因 finteam 建立另一条VM隧道而迁移。保留现有子域名DNS及隧道路由，不把同一hostname同时接到VM隧道。

Samba只读共享是独立数据路径：已验证的14文件导出通过宿主挂载进入采集器，不经过网页隧道。`account_results_count`是结果条数，不能当成导出文件数。
