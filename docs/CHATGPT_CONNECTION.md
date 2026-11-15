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

首次需在 NAS 输入新建的正式 OpenAI Tunnel ID（不是 Cloudflare Tunnel ID）。它不是 API 密钥。不要在聊天中发送运行密钥、网页密码或工具鉴权头。

正式运行凭证优先保留 `cfo/secrets/openai-runtime-key.txt`；首次可在 NAS 本地从原测试项目复制，权限0600，不打印值、不改原文件。正式容器随后只挂载自己的凭证，不长期依赖旧测试目录。复制凭证不增加原密钥的权限，正式隧道仍需原运行密钥具备相应访问权。没有本地凭证时脚本停止，需在 NAS 本地配置。

脚本通过本地专用凭证调用正式 MCP 只读验收，然后启动独立的正式 OpenAI 连接器。网页 Cloudflare 连接器不受影响，原测试隧道不复用、不自动停用。

## ChatGPT 端验收

在账号中创建或选择正式 Personal CFO 插件，连接上述正式 OpenAI 隧道；平台设置若有变化，以当前界面为准。将本项目 skill 配置到支持它的对应入口。当前开发窗口不能替用户完成账号内插件安装，技能也不自动向所有设备、所有对话安装。

先调用 `cfo_health`，确认版本与 `database=reachable`；再查看 `cfo_list_accounts`。正式验收使用用户提供的真实交易凭证及记账意图，不往真实账本写入虚构测试交易。

上传截图并说“帮我记账”。明确交易应返回真实 posted；缺少日期、付款账户或汇率时保留 draft 并追问。多图按每次最多3张自动分组；重复上传不应重复生成分录。仅保存原件不是正式入账。

已归档凭证可通过 `cfo_list_documents`、`cfo_read_document` 和 `cfo_record_existing_document`继续处理。批量处理、重复检测、待补充和三表勾稽已有隔离测试，仍须上述真实插件验收。

券商当前是只读账户结果；reference/unavailable期间损益不计利润。自动投资入账还需要已核对的期间、账户映射和可信汇率，不以持仓变化伪造收益。
