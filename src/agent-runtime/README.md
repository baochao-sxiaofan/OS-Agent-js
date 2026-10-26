# 服务器长期 Agent Runtime

公共入口 `os-agent-js/agent-runtime`，工厂 `createAgentRuntime(options)`。
连接新 ACB、Context、scheduler、round 和 requester，不依赖旧 TaskScheduler。
同一进程可运行多个 Agent，每个 Agent 只有一条活跃上下文链和一个写入口。
所有 Agent 都由用户创建，是平等且独立的长期身份。新链路没有父子 Agent。

`initialize()` 恢复 SQLite 状态并对账；`start()` 常驻运行；`close()` 停止调度、
取消请求和工具后关闭存储。调用方通过 createAgent、submit、inspect、messages、events、
interrupts、approvals、approve、reconcile、pause、resume、cancel 管理工作。

工作区以宿主预注册名称寻址。创建 Agent 时 capabilities 必须落在角色上限，
文件权限只接受 `workspace://current/` 范围。模型动作只能经过严格的结构解析；
模型既不能指定内部身份，也不能直接修改预算、角色或授权记录。
工具目录来自注册表，角色决定可见性；实际执行前仍由 CapabilityManager 检查资源。
敏感权限只形成 ceiling，人工批准按操作签发单次 Grant。
所有 Grant 的 `delegable` 固定为 false；复用 CapabilityManager 的 root 来源表示
用户经宿主签发的初始权限，不表示存在根 Agent 或任务树。

可信宿主可以调用 `registerWorkspace(id, path)` 登记新的真实目录，已登记的 id
不能重新映射。宿主负责保存映射并在下次初始化时提供；HTTP 与模型不暴露该管理操作。
`createAgent({ ..., startMode: 'on_message' })` 创建后休眠，默认 `immediate`
保持立即运行的兼容行为。`messages(id, owner)` 返回持久输入和 L1 最终回复，
带稳定消息 id、时间与来源，重复幂等输入不会生成第二条消息。

普通模型轮支持上下文动作、工具、消息、输出和历史引用读取。用户通过 createAgent
或认证 HTTP POST /v1/agents 创建 Agent；模型协议没有 spawn 或生命周期管理入口。
L1/L2/L3 的推进、总结和释放都发生在同一个 Agent 内部。工作结束后进入 SLEEPING，
后续任务、协作消息和进程恢复均复用原身份与记忆。

通信对象是同一用户、同一工作区内另一个已有且未取消的 Agent。暂停者可持久接收消息，
用户 resume 后再处理。消息只传资料，不继承发送方权限；回复也需要明确发送 message。
pause/cancel 仅作用于指定 Agent，其协作者可以独立继续工作。
数量限制只有用户创建的长期 Agent 总数 maxAgents，休眠不会释放身份。

模型请求发送前保存请求、预留用量；返回后保存原始 completion。厂商私有
continuation 留在执行存储，不进入语义 Context。进程重启后，已完成回复可重新应用，
无需再次调用模型；每个重试保留同一调度批次 ID。

工具操作先持久登记，再登记 scheduler operation，最后执行。成功结果存档后才通知
scheduler；按工作区串行执行副作用操作。只读操作可在重启后重试，副作用操作若
停留在 RUNNING 则进入 unknown，等待宿主 reconcile，不盲目再次执行。
这保证不会把未知结果误当作失败重做，并不声称任意外部系统恰好一次执行。
外部系统仍应接收操作 ID 作为幂等键，MCP client 会将其放入请求 _meta。

中断按网络、协议、权限、工具、预算、循环等类型保存。网络与可纠正协议错误
按有界退避重试；不可恢复或次数耗尽时保留现场并暂停。pause/resume 不依赖模型总结。
请求准入共用 RPM、TPM 和并发，累计轮数、Token、费用和重复动作也受限制。
定价默认零表示宿主没有配置价格；仍受 Token 和轮数限制。生产使用需明确配置单价。

SQLite 表包含 Context、Agent 元数据、调度快照、消息、工具操作、请求/回复、事件、
中断和产物。Context 事务与其他表写入使用幂等键和启动对账衔接。当前存储为单进程
事实源，不支持两个服务实例同时操作同一数据库，也不支持分布式 worker。
RuntimeAgent 使用版本 2 快照。此前包含父子字段的开发版快照不能直接恢复，也不会
自动将模型创建的身份转为用户创建。保留原数据库用于查阅，在新数据库由用户重新
创建长期 Agent；本次改动不会删除或改写已有数据库。

MCP、Docker 后端分别位于 integrations/mcp-client.ts 和 docker-sandbox.ts，
只有宿主显式注册时才开放。普通工具接口可复用已有内置工具或可信自定义 skill。
未配置 Docker ProcessSandbox 时不注册 test.run，不退化为宿主裸进程。

HTTP 服务用法见 [服务器部署说明](../../docs/server-runtime.md)，验收状态见
[交付清单](../../docs/server-runtime-checklist.md)。

`dismiss(id, owner)` 永久解雇员工；只有用户控制面可调用。状态为 `dismissed`，默认 `list`
不返回该身份，`list(owner, { includeDismissed: true })` 与 `inspect` 可用于历史管理。
暂停、继续不能重新启用离职身份；会话、原文、产物及未知副作用对账记录保留。
普通请求采用固定工具和完整历史前缀，详见[请求布局](../../docs/request-layout.md)。
