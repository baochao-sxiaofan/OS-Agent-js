# 新链路服务器使用说明

要求 Node.js 24 或支持 node:sqlite 的 Node.js 22。单机单进程，SQLite 使用持久目录。
模型首次接入使用 MiniMax，普通轮和总结轮共用同一 requester。
同一个数据库通过独立 SQLite 锁事务限制为一个 Runtime；进程崩溃自动释放锁。
恢复时先校验长期身份、角色、用户授权来源和操作期限，再开放服务。

所有 Agent 都由用户通过控制面创建，彼此没有父子关系。模型可规划自己的工作和
向已有 Agent 发送消息；Agent 的创建、暂停、恢复和取消由用户操作。
L1/L2/L3 是单个 Agent 内部的上下文层级，工作结束后身份保留并进入 SLEEPING。

## 本地启动

```sh
npm ci
npm run build
mkdir -p workspace
cp server.config.example.json server.config.json
```

编辑本地 server.config.json 的工作区和 profile 权限。配置不含凭据，真实 Key 只由
环境变量或部署平台 Secret 注入：

```sh
export MINIMAX_API_KEY='从本地密钥管理器注入'
export OS_AGENT_TOKEN='从本地密钥管理器注入的长随机令牌'
export MINIMAX_MODEL='MiniMax-M2.7'
npm run server
```

配置和环境文件已加入 gitignore 和 dockerignore。默认只监听 127.0.0.1；
远端部署通过可信反向代理提供 TLS，或修改 host 后放到受控网络。
HTTP API 不能传入宿主路径、权限或角色，只能引用宿主注册的 profile。

## HTTP API

除 healthz/readyz 外，每次请求需要 Authorization: Bearer $OS_AGENT_TOKEN。

| 方法 | 路径 | 请求 |
| --- | --- | --- |
| GET | /healthz、/readyz | 健康/就绪检查 |
| POST | /v1/agents | `{"profile":"reporter","objective":"读取 input.txt 并生成 report.md"}` |
| GET | /v1/agents | 当前认证宿主的 Agent 列表 |
| GET | /v1/agents/:id | Agent、Context、用量与状态 |
| POST | /v1/agents/:id/messages | `{"content":"后续任务","idempotencyKey":"client-message-1"}` |
| GET | /v1/agents/:id/messages | 兼容入口：仅本人和该 Agent 的私聊 |
| GET | /v1/conversations | 本人参加的私聊与群聊 |
| POST | /v1/conversations | `{"workspaceId":"work","kind":"group","title":"讨论","agentIds":[1,2],"participation":"all"}` |
| GET | /v1/conversations/:id/messages | 会话消息；管理查看可带 `?inspectAgentId=1` |
| POST | /v1/conversations/:id/messages | `{"content":"请补充","idempotencyKey":"msg-1","mentions":[1],"replyTo":"可选消息ID"}` |
| GET | /v1/conversations/:id/mailboxes | 各成员处理状态；管理查看可带 `?inspectAgentId=1` |
| GET | /v1/agents/:id/conversations | 管理查看该 Agent 参加的会话 |
| GET | /v1/agents/:id/legacy | 只读旧混合历史与内部输出归档 |
| GET | /v1/agents/:id/events?after=0 | 按序列查询输出和执行事件 |
| GET | /v1/agents/:id/interrupts | 故障及处置记录 |
| GET | /v1/agents/:id/approvals | 审批与结果未知操作 |
| POST | /v1/agents/:id/approvals | `{"operationId":"...","allowed":true}` |
| POST | /v1/agents/:id/reconcile | `{"operationId":"...","outcome":"succeeded","result":{}}` |
| POST | /v1/agents/:id/pause、resume、cancel | 宿主控制 |

只有模型显式调用 `message_send` 才产生会话消息，必须指定已授权 conversationId。
`peer:agent-N` 会创建或复用发送方与该 Agent 的独立私聊。模型可关联 replyTo 或
点名 mentions，但不能冒充其他发送者。用户默认列表看不到 Agent 私聊；
管理查看不赋予成员或发件资格。文件产物保存在该 profile 的工作区。

模型可以合并回答本批多条来信，或调用 `context_finish_turn` 静默结束根层本轮；
`message_send` 的 `finish: true` 可在发件后结束。两种结束均要求没有未完成任务、
子层或在途操作。`complete/idle` 仍用于需要独立总结的业务，容量压缩继续执行。
旧 `output` 仅作内部交付兼容，events 中可按 data.level 区分层级，不再生成聊天气泡。
独立总结只能调用 `submit_summary` 输出函数，不可调用业务工具；来源与预算严格验证。
本批静默结束或总结通过后且无其他工作时状态为 SLEEPING，新消息持久登记并聚合后唤醒。
同一消息幂等键不可用于不同正文。审批只能用于该 Agent 的待处理操作。
通信仅限同一用户、同一工作区内的未取消 Agent。
接收方使用自己的权限执行，协作结果通过显式消息回复，完成不会自动回传或销毁身份。
暂停的 Agent 保留收到的消息，用户 resume 后处理；取消一个 Agent 不影响协作者。

默认私聊/点名静默窗口 500ms、普通群聊 1200ms、最大聚合等待 2000ms。
`participation: mentioned` 仅在被点名或收到针对自身消息的回复时唤醒；
`all` 模式让模型自行判断是否需要贡献。每位 Agent 同时只处理一个会话。
邮箱 `aggregating/processing/processed` 表示处理进度，不等于发送了答复；
processedSequence 为实际确认上界，未被唤醒的通知不会伪造已处理回执。
每次用户输入创建的交流阶段默认共享最多 12 条自动发言，跨 Agent、跨会话传播，
达到上限暂停当前发言者并保存现场。SDK 可用 conversationPolicy 配置窗口和上限。
消息正文最多 12000 UTF-8 字节，也不得超过成员 Context 投递容量；拒绝时不会持久写入。
详见[会话运行时设计与验收](conversation-runtime.md)。

## 配额与异常

limits 可以配置 maxConcurrentRequests、requestsPerMinute、tokensPerMinute、
maxRequestTokens、maxOutputTokens、maxRounds、maxTotalTokens、maxCostUsd、
inputUsdPerMillion、outputUsdPerMillion、maxRetries、retryBaseMs、
repeatedActionLimit、maxAgents、toolTimeoutMs。
单位分别为次数、Token、美元和毫秒。配置价格后费用上限才按价格计费。
maxAgents 限制保留的长期身份总数，休眠不释放身份。旧 maxAgentsPerTree/maxDepth
已移除，配置中继续携带这些字段会被拒绝。

容量设置推荐使用配置文件的 `tokenSettings`，它同时配置完整请求、输出预留及三层上下文，
优先于 `limits` 中对应的四项 Token 配置。例如：

```json
"tokenSettings": {
  "maxRequestTokens": 1000000,
  "maxOutputTokens": 65536,
  "tokensPerMinute": 4000000,
  "maxTotalTokens": 20000000,
  "contextMaxTokens": 300000,
  "contextCompactAtTokens": 210000,
  "contextTargetTokens": 105000
}
```

默认完整请求容量500K、最大输出32768、每分钟额度2M、每位 Agent 累计额度10M；
每层硬上限140K、压缩阈值100K、压缩后目标50K。完整请求容量包含输入及输出预留，
单次输出上限直接传给模型，不表示需要生成同样长度的总结。模型的实际窗口和输出上限
仍由供应商决定，宿主设置不能扩大模型本身的能力。上下文容量使用 JSON UTF-8 字节
保守估算，供应商报告的实际 Token 用于执行后的累计计量，两者并非相同的分词器。

设置必须满足压缩目标 < 压缩阈值 < 每层硬上限；三层硬上限与输出预留之和不超过
完整请求容量，每分钟和累计额度必须能容纳一次最大请求。正文、工具 schema 等额外
开销仍由完整请求预检控制。跨会话近期记忆继续使用自己的紧凑预算。

SDK 提供 `runtime.tokenSettings()` 和可信宿主 `runtime.configureTokens(settings)`。
在线修改要求所有 Agent 休眠或暂停且没有模型请求，保存后会应用到已持久化的各会话
上下文及后续模型轮，并在重启后恢复。降低硬上限无法容纳已有现场时会拒绝修改。
配置文件修改需重启服务器；不会重置历史累计用量、删除原文或改变工具授权。

`limits.maxRounds`（默认128）限制一个收件批次或一段连续工作的模型请求数，
普通轮、总结和重试均计入；工作额度持久保存，重启和自动退避不会重置。
新收件批次使用新额度，无新输入的连续工作在休眠且没有待处理工具时结束。
额度耗尽后暂停，可信宿主显式 `resume` 可追加一份额度并记录事件；
长期请求数、Token 和费用统计继续保留，累计 Token 与费用上限独立执行。
旧数据库没有工作额度时为当前工作创建额度，不再用终身请求数阻断长期 Agent。

普通动作、分层总结和会话摘要均通过原生函数调用提交，新的正文 JSON 动作会被拒绝。
恢复旧版持久回复时兼容转换，原始证据与幂等键保留。原生工具历史只续接最近有限的
完整调用组，按 Agent、会话、工作、上下文层级及版本、模型连接隔离；
只有上下文已提交且具有真实工具结果的调用可重放，私有思考状态不进入语义 Context。
活动步骤提供精确的来源枚举，读取聊天原文后登记实际消息来源。
压缩后的已完成任务只保留短结果和封存引用，总结预算预留固定结构及来源还原开销，
完整原文仍保存在历史中；可纠正的总结超限进入有限重试。

临时网络故障和协议错误有界退避；达到上限暂停且保留场景，宿主修复后 resume。
DeepSeek 拒绝请求时，已识别的工具 Schema、工具历史和上下文容量错误会显示具体类别，
不回显服务端原文。升级时未完成的旧格式请求会归档并按当前工具定义重建；
已完成回复仍按原回执恢复，累计用量和副作用幂等键保留。
总结错误会区分输出截断与非法 JSON，并显示最近失败原因。已暂停且存在失败总结时，
用户显式 resume 会归档旧回复并重新开启有限总结尝试，用当前容量完成原总结；
不重做已提交业务、不跳过来源或结构校验。自动退避不会重置总结次数。
权限拒绝作为工具结果返回模型；失败、超时或中断的副作用操作立即暂停等待人工对账。
请先确认外部操作结果，再 reconcile，不能把未知写操作当作安全重试。
reconcile 保存新版本结果和独立交付记录；全部未知操作确认后才允许 resume。
审批超过操作期限或 Agent 已暂停/取消时不能执行。暂停保留运行场景；取消只停止指定 Agent。
工具适配器必须响应 signal；Runtime 能结束对忽略信号的工具等待，但不能证明外部
副作用已停止，这类操作恢复后仍需对账。排队的副作用不会在停机或暂停后开始执行。
存储失败会停止自动执行，readyz 返回 503；恢复需要重启服务并检查持久目录。

## 容器部署

Dockerfile 使用 Node.js 24，以非 root 用户运行。运行配置以只读文件挂载，
数据库目录和工作区分别持久挂载；Key 通过部署 Secret 注入。
配置中的 host 设为 0.0.0.0，数据库路径设为 /data/runtime.sqlite，
工作区映射到 /workspace。不要把本地配置、环境文件或数据库 COPY 到镜像。
收到 SIGTERM/SIGINT 后停止接收新任务，取消当前请求，等待工具退出并关闭数据库。
服务重启会恢复原始批次、待总结、退避期限和未消费消息。

DockerProcessSandbox 支持受限 test.run：固定镜像、关闭网络、只挂载指定工作区、
只读根文件系统、禁止提权、限制进程数量/CPU/内存。超时删除整个容器。
它要求服务器宿主可使用 Docker；Docker 不可用时不开放进程工具。
MCP Client 可经公共 integrations 入口注入 stdio/HTTP 连接，再把可信本地
McpToolBinding 注册到 ToolRegistry；远端工具不能自行声明权限。

## Linux 进程守护

[systemd 示例](../deploy/os-agent.service) 使用专用 os-agent 用户、
`/opt/os-agent` 程序目录、`/var/lib/os-agent` 数据目录及
`/srv/os-agent/workspace` 工作区。`/etc/os-agent/server.config.json` 配置这些绝对路径；
`/etc/os-agent/runtime.env` 由部署 Secret 生成，权限设为 0600，包含模型 Key 和服务令牌。
安装构建产物后将 unit 放到 `/etc/systemd/system/os-agent.service`，执行：

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now os-agent
sudo systemctl status os-agent
```

服务异常退出由 systemd 重启。Runtime 内部故障会保持进程供查询健康状态，
通过 readyz 503 告知探针；排查存储原因后执行 `systemctl restart os-agent`。
默认 unit 未开放 Docker socket；需要进程工具时由宿主单独配置后端权限。

## 数据维护与验证

备份 SQLite 时使用 SQLite 在线 backup，或停机后连同 WAL/SHM 一起处理；
不要在运行中只复制主数据库。历史当前只追加，保留期应由宿主维护策略决定。
日志仅输出事件序号、类型和 Agent 身份；原始业务内容不直接写启动日志。
数据库包含业务资料和厂商续接状态，按本地工作数据保护。协议纠偏前的请求和原始回复
保存在 `runtime_request_history`，不会被修复动作删除。操作结果版本保存在 metadata
及 artifacts，事件序列、模型实际用量和审批状态可通过 API 查询。
新 RuntimeAgent 快照版本为 2。之前含 parentId、parentTarget、childKey、depth 的
开发版快照会被拒绝，原数据库保留；请使用新数据库，由用户重新创建所需的长期 Agent。
不会自动将此前由模型创建的 Agent 改为用户身份，也不会自动删除旧记录。

```sh
npm run check
npm run desktop:check
npm test
npm run build
npm run demo:agent-context
```

真实 API 冒烟仅显式执行：`npx tsx examples/server-live-smoke.ts`，Key 从本地环境读取。
测试建立独立临时工作区，执行真实文件读写及逐层总结，结束后清理。
默认测试不调用付费 API。

当前实现单机长期 Agent 和按用户、工作区隔离的通信；不提供分布式 worker、
任意技能市场加载或通用 shell。已有工具契约可接入业务 skill，授权仍由内核裁决。
本机桌面通过相同公共 API 运行，见[新桌面说明](desktop-next.md)。
本次在 macOS 完成自动化、真实模型、MCP HTTP/stdio 与 SIGKILL 恢复验证。
本机没有 Docker，容器构建、沙箱进程树取消及 Linux systemd 启动需在目标服务器验收；
交付清单保留这些环境验证为未完成。

## 模型请求失败时

- HTTP 529 表示本次模型服务请求未被正常处理，不能据此判断 Key 无效。
  有 Retry-After 时遵守该期限；没有时默认等待 30 秒，再按有限重试策略处理。
  重试耗尽后保留原消息和运行现场，稍后调用 resume 或点击桌面的“继续”。
- HTTP 401 优先检查凭据，403 检查模型权限，429 检查限流窗口与账号额度。
  错误记录包含 provider、错误类型、HTTP/API 状态码及中文提示，不保存供应商原始正文。
- 已看到业务回复但仍处于运行/暂停状态时，应检查独立总结轮的中断记录。
  模型省略空列表现在会在协议边界补齐；缺少必填来源、显式类型错误或伪造引用仍拒绝。
- 桌面系统安全存储不可用时，界面输入的 Key 仅在本次会话内有效；
  重启后需要重新输入或由本地环境提供，配置文件不会保存明文 Key。
