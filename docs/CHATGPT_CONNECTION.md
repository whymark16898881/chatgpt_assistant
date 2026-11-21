# 正式 ChatGPT 记账入口

目标体验：用户上传一张或多张截图，说“帮我记账”；AI自行识别、查账户、归档、去重和入账，不明确的事实才集中追问。网站负责结果与报表。技能文件在 `skills/personal-cfo/SKILL.md`。

## 必须区分三个检查

1. 网站 `/health` ready：网页应用与数据库正常。
2. `formal_mcp_local_check` ready：应用内部的正式 MCP、专用鉴权及记账工具清单正常。该检查只读取健康与工具清单，不读取金额、不生成账目。
3. 在真实 ChatGPT 对话调用 `cfo_health` 与上传凭证：正式插件及附件传输实际验收。前两项不能替代此项；只有 `cfo_probe_*` 的 Test 插件只是归档探针。

## NAS 端连接准备

既有网站和自动更新配置保持原样。在正式目录运行：

```sh
cd /volume1/docker/cfo
sudo sh scripts/connect-chatgpt.sh
```

默认复用现有 Personal CFO Test 插件的 OpenAI 隧道，无需新建或卸载插件。脚本核对已经确认的原连接器身份与隧道ID，先检查正式工具并准备新容器，再停止旧客户端、关闭它的自动重启，最后启动正式客户端。同一隧道不能同时跑两个客户端，重启NAS也不应恢复旧客户端竞争连接。

正式运行凭证优先保留 `cfo/secrets/openai-runtime-key.txt`；首次可在 NAS 本地从原测试项目复制，权限0600，不打印值、不改原文件。正式容器只挂载自己的凭证。复制凭证不改变原密钥权限。

新客户端必须实际出现隧道元数据获取与轮询启动记录，脚本才输出 `CHATGPT_CONNECTOR_SWITCHED`。这只代表连接器启动；真实 ChatGPT 工具调用仍需后续验收。若启动失败或等待超时，脚本停止新客户端、关闭它的自动重启，恢复旧客户端的原重启策略及原运行状态。遇到其他正式隧道配置时停止，绝不覆盖。

手动回退（保留全部账本、票据和凭证）：

```sh
cd /volume1/docker/cfo
sudo sh scripts/connect-chatgpt.sh --rollback
```

原测试应用、数据库、原件均保留；仅原测试隧道客户端停止。网页的 Cloudflare 连接器不受影响。迁移记录位于私有 `secrets/chatgpt-migration`。脚本与 GitHub 更新器互斥运行，遇到升级任务时请完成后重试。

仅当用户明确希望另建独立插件时，才使用 `sudo sh scripts/connect-chatgpt.sh --new`，并在NAS输入新正式OpenAI Tunnel ID；不要把Cloudflare ID、API密钥混入。

## ChatGPT 端验收

迁移成功后，在现有 Personal CFO Test 的管理页点击“刷新工具”，在新对话选择它即可。名称可以暂时保留；判断依据是实际工具变成 `cfo_health`、`cfo_capture` 等，而非旧的 `cfo_probe_*`。无需另建插件。将本项目 skill 配置到支持它的对应入口。当前开发窗口不能替用户完成账号内插件安装，技能也不自动向所有设备、所有对话安装。

先调用 `cfo_health`，确认版本与 `database=reachable`；再查看 `cfo_list_accounts`。正式验收使用用户提供的真实交易凭证及记账意图，不往真实账本写入虚构测试交易。

上传截图并说“帮我记账”。明确交易应返回真实 posted；缺少日期、付款账户或汇率时保留 draft 并追问。多个附件按每次最多6个自动分组；重复上传不应重复生成分录。PDF 可直接上传：有文本层按页返回真实文本，扫描件返回该页渲染图片。仅保存原件不是正式入账。

已归档凭证可通过 `cfo_list_documents`、`cfo_read_document` 和 `cfo_record_existing_document`继续处理。批量处理、重复检测、待补充和三表勾稽已有隔离测试，仍须上述真实插件验收。

券商当前是只读账户结果；reference/unavailable期间损益不计利润。自动投资入账还需要已核对的期间、账户映射和可信汇率，不以持仓变化伪造收益。
