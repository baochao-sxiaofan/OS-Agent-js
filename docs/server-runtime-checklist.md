# 新链路服务器交付清单

目标：新 ACB、Context、scheduler、round 链路在服务器常驻运行，接受真实任务，
受控执行工具，完成逐层总结，持久返回结果；故障和进程重启后能恢复现场。
这次交付包含单个服务器进程内的多个长期 Agent、通信和隔离，不建设分布式调度集群，
不替换旧桌面 UI，也不建设 RAG 或向量数据库。
新链路 Agent 统一由用户创建，无父子关系；L1/L2/L3 只表示同一个 Agent 的上下文层级。

所有条目由可执行代码、验证和文档共同验收，不能用示例预设动作替代真实模型协议。
测试凭据仅经本地环境注入，源码、文档、日志和测试产物不得包含凭据。

## 1. 调度持久化与异常等待

- [x] 序列化保存封存批次、在途操作、未交付结果、事件、继续意图及等待条件。
- [x] 崩溃中的 RUNNING 请求恢复为待执行，保留原批次 ID 和上下文回执。
- [x] 通用暂停、延迟重试、手动恢复；等待期间不立即重排或占用运行额度。
- [x] 定时器和异步结果恢复；结果先持久化再向模型投递。
- [x] 总结仍走普通 scheduler 路径；不能引入独立总结队列。

证据：`src/agent-scheduler/internal/scheduler.ts`、RuntimeStore；
`test/agent-runtime/scheduler-recovery.test.ts` 和 `recovery.test.ts`。

## 2. 普通模型协议与上下文

- [x] 正式的模型指令、动作 schema、严格响应解析和合法动作集合。
- [x] 真实模型自主规划、推进、工具调用、步骤完成和层级结束。
- [x] 原始回复、工具引用和来源可回溯；厂商续接状态不进入语义 Context。
- [x] 完整请求在发送前检查预算；任务完成后由另一张运行凭据总结。
- [x] 长文本存产物并按引用读取；修复集成中发现的上下文容量或恢复缺陷。

证据：Runtime protocol/schema、agent-round/requests、Context Manager；
`test/agent-context/`、`test/agent-runtime/runtime.test.ts`。
本地真实 MiniMax 冒烟已完成 23 次请求，生成 195 字节报告，三层总结后休眠并再次唤醒。

## 3. 执行器、工具、权限与审批

- [x] 复用工具注册表和 CapabilityManager，工具可见性与授权分别校验。
- [x] 工作区和角色由可信宿主配置；拒绝目录越界、未授权资源和提权。
- [x] 操作持久登记后才执行；幂等键不随请求重试或进程重启变化。
- [x] 副作用结果未知时暂停并允许宿主对账，不能声称任意工具恰好一次执行。
- [x] skill/工具错误形成结构化结果；敏感操作有显式批准/拒绝入口。
- [x] 接入真实 MCP Client（stdio/HTTP）与现有工具适配器。
- [x] 进程工具仅在配置隔离后端时开放；Docker 适配器实现超时和删除容器取消后代。
- [ ] 在 Docker 宿主实际验证进程工具、网络/文件隔离与整个进程树取消。

证据：ToolExecutor、MCP/Docker integrations；`approval-cooperation.test.ts`、
`execution-recovery.test.ts`、`mcp-client.test.ts`（本地真实 stdio 子进程及 HTTP MCP 服务）。
当前机器无 Docker，沙箱实际验收不能标记通过。

## 4. 中断处理与资源治理

- [x] 网络错误、超时、429、协议错误、权限拒绝、工具失败统一记录。
- [x] 依错误分类退避、纠偏、暂停或终止自动执行；次数与期限持久保存。
- [x] RPM、TPM、并发额度在请求前准入；普通轮与总结轮共用限制。
- [x] 持久累计轮数、Token/费用预算和重复动作监督；达到上限不再请求模型。
- [x] 取消、暂停和故障停止无需先成功请求一次总结模型。

证据：Runtime limits/failure、`recovery.test.ts`、`limits-isolation.test.ts`；
429/timeout 的 requester 边界另由 `test/model-requester.test.ts` 验证。

## 5. Runtime 与通信

- [x] 常驻调度循环、Agent 创建/恢复/查询/取消/恢复和结果返回。
- [x] 持久任务提交与消息收件/发件；消息重复投递不重复执行。
- [x] 用户控制面创建长期 Agent；移除模型创建入口、父子字段和深度/任务树限制。
- [x] 平等 Agent 按用户、工作区寻址通信；消息不转授权限，取消不影响协作者。
- [x] 长期身份受 maxAgents 总数限制，休眠、唤醒、消息回复和重启保留身份。
- [x] 旧父子快照拒绝自动恢复并保留原数据；由用户在新库创建长期 Agent。
- [x] 数据按宿主身份与工作区隔离；API 调用方不能任意指定宿主路径或扩权。
- [x] Runtime、Context、调度和执行记录启动对账，未知副作用不自动重放。

证据：Runtime restore 和通信协议；`user-created-agents.test.ts`、
`approval-cooperation.test.ts`、`limits-isolation.test.ts`、`execution-recovery.test.ts`。
覆盖模型伪造创建动作拒绝、两个用户创建身份的重启消息往返、权限独立与取消隔离。
SIGKILL 后保留原工具幂等键且对账后不重复执行。

## 6. HTTP 服务与部署

- [x] 认证后的任务/Agent/消息/结果/中断/审批 API，以及健康和就绪检查。
- [x] 请求体、错误和日志边界校验；凭据脱敏。
- [x] 配置、持久目录、启动命令、容器/进程守护示例和 Linux 使用说明。
- [x] SIGTERM/SIGINT 停止接收新工作、取消/等待执行、关闭存储。
- [x] 结构化运行日志、请求用量与操作状态查询；历史备份和维护说明。
- [ ] 在目标 Linux 宿主安装 systemd 服务，验证持久挂载、信号停机和重启探针。
- [ ] 构建并实际启动 Docker 镜像，验证持久数据、API 和非 root 权限。

证据：`src/server/`、`http.test.ts`、存储故障 readyz 503 测试；
`Dockerfile`、`deploy/os-agent.service`、[部署说明](server-runtime.md)。
服务器 CLI 的信号处理与 API close 共用关闭链路；Linux/Docker 实际运行仍需目标环境。

## 7. 验证

- [x] 确定性集成验证：真实协议、文件工具、审批、通信、预算和异常。
- [x] SQLite 关闭重开/进程重启：业务轮、总结轮、工具执行和延迟重试。
- [x] HTTP API 的认证、隔离、输入校验和停机验证。
- [x] 本地真实 API 冒烟：读取指定目录并生成报告，三层总结、休眠、再次唤醒。
- [x] 全仓测试、类型检查、桌面兼容检查、构建、包导出和凭据扫描。

2026-10-19 本地验证：245 个测试、33 个测试文件通过；`npm run check`、
`npm run desktop:check`、`npm run build` 通过。三级 Context、scheduler 及旧 Runtime
演示通过；9 个公共包入口可导入，内部路径被 exports 阻断。
源码、配置、文档及本地日志的凭据模式扫描无命中，`git diff --check` 通过。
未执行 commit、push；真实测试凭据未写入代码、文档或日志。

2026-10-20 架构纠正：移除新链路父子 Agent。既有真实 MiniMax 冒烟记录验证的是
单 Agent 文件读写与三层上下文，不是新平等 Agent 通信；本次通信改动使用确定性集成测试验证。
纠正后全仓 250 个测试、34 个文件通过；类型检查、桌面类型检查、核心构建、
Runtime/server 包导出与内部路径隔离检查通过。新链路集成测试共 36 个用例。

2026-10-21 会话改造：独立用户/Agent 私聊和群聊、会话上下文、持久聚合与静默处理、
共享自动发言预算、显式发件、HTTP 只读查看及桌面群聊已实现。
全仓 276 项测试、38 个文件通过；新 Runtime 集成测试 62 项，覆盖持久批次、
按上界确认、在途新消息、发件后断电、双向私聊隔离和循环预算熔断。
核心及新旧桌面类型检查、核心和新桌面构建通过；实际 Electron 使用隔离演示数据验证。
本次没有调用真实 API，模型自主判断群内相关性的效果留待业务试用。
详见[会话清单](conversation-runtime.md)。

## 执行顺序

先实现 1 的调度基础，再完成 2 和 3 的真实闭环；接入 4、5 的运行监督与持久恢复；
随后完成 6 的服务器边界，最后执行 7。测试随每个阶段补齐，不等到最后才验证。
遇到真实 API 或本地隔离后端不可用时记录准确阻碍，继续其他可执行验证。
