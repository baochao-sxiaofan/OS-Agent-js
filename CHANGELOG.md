# 更新日志

本项目使用语义化版本号。

## 1.2.0 - 2026-08-24

### 新增

- 新增 `SqliteTaskStore`：基于 Node 内置 `node:sqlite` 的本地持久化实现，
  实现现有 `TaskStore` 接口，内核与调度器零改动即可替换内存存储。
- 单一 SQLite 文件即唯一事实源；快照与事件以 JSON 文本存入 `body` 字段，
  并冗余 `root_task_id`、`status` 等索引列供崩溃恢复查询。
- 每次状态跃迁的「快照 upsert + 事件增量 append」在同一事务内原子落盘，
  事件按 `sequence` 去重，重复 persist 幂等。
- 采用 WAL 模式优化高频小事务写入，由 SQLite 负责刷盘 durability。

### 变更

- 桌面端 `ObservableTaskStore` 改为包装 `SqliteTaskStore`，在持久化之上叠加
  UI 变更通知；主进程将任务库落在 Electron `userData` 目录下的 `tasks.db`。
- `RuntimeService` 新增 `storeLocation` 选项；省略时使用内存库（开发/测试）。

### 说明

- 选用内置 `node:sqlite` 而非原生编译依赖（如 better-sqlite3），避免 Electron
  跨平台重建负担；该 API 在当前 Node 下仍标注为 experimental，但读写、事务与
  JSON 值行为已在内核与 Electron 内置 Node 上验证一致。

### 验证

- 内核与桌面端 TypeScript 类型检查通过。
- 8 个测试文件、51 个测试全部通过，新增 SqliteTaskStore 持久化、事件增量、
  幂等重写与恢复往返用例，并通过跨进程重开的落盘冒烟验证。

## 1.1.0 - 2026-08-24

### 变更

- 统一子 Agent 创建入口为 `TaskControlBlock.createAgent(request, origin)`：`depth`、
  `createdAt`、`rootTaskId`、`parentTaskId` 与初始状态全部由内核依据创建来源派生，
  调用方无法再伪造层级或血缘。
- 移除模型可控的任务 `priority`；同一深度的就绪任务改为纯 FIFO 调度，深度权重、
  等待老化与父任务唤醒加速保持不变。
- 模型请求的 `delegation` 只保留 `canSpawnSubagents`，不再暴露 `currentDepth`、
  `maxDepth` 和 `availableAgentSlots`，落实每层 Agent 对全局深度无感知。

### 并发与可靠性

- 重构子 Agent 创建流程为「同步准入临界区 + 异步发送」两段：AgentPool 扣减、
  Work Table 登记与预留提交在无 `await` 的同步段内原子完成，据此移除
  `spawn_in_progress` 锁及其拒绝原因。
- 子 Agent 发送（持久化并入队）失败时，自动把已占用的 live 槽位释放回 AgentPool，
  清理登记，并向父任务回传失败结果以唤醒其重新规划，避免父任务永久等待。
- 快照恢复时校验 `depth` 与父子关系的一致性，防止非法层级进入运行时。

### 验证

- 内核与桌面端 TypeScript 类型检查通过。
- 7 个测试文件、47 个测试全部通过，新增并发创建不超卖与发送失败回滚槽位的用例。

## 1.0.0 - 2026-08-22

首个可实际使用的桌面正式版本。

### 桌面应用

- 新增 Electron + React 桌面控制台，支持 macOS 本地开发预览和 Windows x64
  NSIS 安装包。
- 新增 Conversation 侧栏、对话流与 Agent 工程拓扑双视图。
- 新增多轮 Conversation；每轮保存独立根任务和完整 Agent 拓扑，可从对应回复跳转
  查看历史轮次工程图。
- 新增任务入口动态光球、节点状态检查器、运行指标和 AgentPool 剩余容量仪表。
- Agent 阻塞时保持尺寸并切换为灰色；恢复运行后变回黑色；完成后短暂变绿并收回
  父节点，根任务最终展开结果。
- 根任务完成后自动切换到对话流；对话流和工程视图均可发起下一轮任务。

### 模型接入

- 新增统一结构化 Agent 响应解析器。
- 新增原生 `AnthropicModelProvider`。
- 新增 `OpenAiCompatibleModelProvider`，覆盖 OpenAI、Kimi、Grok、MiniMax、GLM、
  DeepSeek、Qwen、豆包和 Xiaomi MiMo 等兼容端点。
- 新增 11 家厂商配置入口。OpenAI、Claude、Gemini、Kimi、Grok、MiniMax、
  DeepSeek、Qwen 和 MiMo 支持账号级模型目录发现；GLM 和豆包提供手工模型 ID
  兜底。
- 模型设置采用“选择厂商 -> 填写凭据 -> 获取模型列表 -> 选择并验证”流程。
- 选中的模型必须通过一次低成本 OS-Agent 结构化协议请求后才会启用。
- 模型切换通过稳定 Provider 代理完成，运行中的 Agent 不允许切换模型。

### 安全与工程化

- API Key 只通过受控 IPC 进入 Electron 主进程，不进入 Renderer 快照、任务上下文、
  事件日志或 URL。
- 系统安全存储可用时使用 Electron `safeStorage` 加密保存；不可用时只保留在当前
  进程内存中。
- 新增 Provider Header 鉴权和结构化响应解析测试。
- 新增 Windows GitHub Actions，自动执行类型检查、测试并上传 NSIS 安装包。

### 验证

- TypeScript 内核与桌面端类型检查通过。
- 7 个测试文件、45 个测试全部通过。
- Electron 空态、运行态、阻塞/恢复、完成回收、双视图、多轮对话及历史拓扑跳转
  已完成实际渲染验证。
- Windows x64 NSIS 安装包可从 macOS 跨平台构建。

## 0.6.0 - 2026-08-21

### 新增

- Gemini 结构化响应新增 `spawn_subagents`、`wait_for_async_work` 和
  `needs_parent_action`，可驱动真实多 Agent 委派与等待流程。
- Gemini 请求现在携带 `delegation`、工具描述和双通道选择后的上下文。
- 新增 Gemini Provider 的委派权限校验、子任务字段校验和异步等待前置条件校验。
- 新增 Ready Queue 峰值、AgentPool 峰值和模型请求并发峰值观测指标。
- 新增 16-Agent、20 次模型请求的三层 Map-Reduce 确定性基准。
- 新增双通道上下文独立测试，验证完整历史、摘要记录、混合模型上下文和快照恢复。
- 新增真实 Gemini `root -> 2 leaf -> root` 多 Agent 冒烟示例。

### 验证

- 确定性基准在模型并发 1、2、4、8 下均完成 20 次请求，未超过 AgentPool 或
  Provider 并发限制。
- 真实 Gemini 测试成功创建两个 leaf Agent，并行返回 `4` 和 `9`，root 收到结构化
  `async_work_update` 后返回 `4+9=13`。
- 真实测试中 AgentPool 峰值为 3、模型请求并发峰值为 2，任务结束后两者均归零。

## 0.5.0 - 2026-08-21

### 新增

- 新增首个真实模型适配器 `GeminiModelProvider`，通过 Gemini
  `generateContent` REST API 发出 HTTPS 请求。
- 新增 Gemini 结构化输出约束，要求模型返回 `output` 和
  `turnSummary.request/outcome`，并转换为内核 `final` 响应。
- 新增 HTTP 状态、非 JSON 响应、候选结果缺失和结构化字段错误的边界校验。
- 新增 Gemini Token 用量解析、可配置价格估算、取消信号透传和可注入 `fetch`
  实现。
- 新增 `demo:gemini` 最小真实网络示例，仅从 `GEMINI_API_KEY` 环境变量读取凭据。
- 新增 Provider HTTP 单元测试和调度器集成测试。

### 当前边界

- 当前 Gemini Adapter 仅支持结构化 `final` 响应。
- Gemini 原生 Function Calling、工具调用、子 Agent 委派和上下文二次压缩适配器
  尚未接入。
- API Key 不进入源码、示例默认值、测试快照或 Git 仓库。

## 0.4.0 - 2026-08-21

### 新增

- 新增持久化 `AsyncWorkGeneration` Work Table，统一记录工具与子 Agent 的运行状态、
  完成结果、投递状态和批处理截止时间。
- 新增 `async_work` 模型响应，支持同一轮混合启动多个子 Agent 和多个长时工具。
- 新增 `wait_for_async_work` 模型响应，允许父 Agent 处理部分结果后继续等待后台工作。
- 新增 `async_work_update` 上下文，分离本批新增结果、仍在运行的工作和整批完成标记。
- 新增按父任务按需创建的一次性批处理 timer，默认窗口为 30 秒。
- 新增全部工作提前完成的快速路径，无需等待 timer 到期即可唤醒父任务。
- 新增异步工作注册、终态和批量投递事件。

### 变更

- 工具调用和子 Agent 结果统一进入 Completion Mailbox，不再使用整批
  `Promise.all()` barrier 等待。
- 只读工具仍并行执行，有副作用工具仍串行执行，但每项工作完成后会独立写入 Work
  Table。
- 父模型运行期间到达的结果会在当前轮次结束后合并投递，父任务级异步状态修改按顺序
  串行化。
- `TaskSnapshot` 现在包含异步 generation、未投递结果、`deliveredAt` 和
  `batchDueAt`。
- 父任务以任意终态结束时，会中止仍在运行的本地工具并递归取消存活子任务。

### 安全与可靠性

- timer 恢复支持剩余窗口重建，以及“截止时间已清除但尚未投递”崩溃间隙的立即补偿。
- 工作 ID 在创建子任务和提交 AgentPool 预留前校验唯一性，避免留下孤立子任务。
- timer 到期、工具完成和子 Agent 完成对同一父任务的修改经过任务级串行化，避免重复
  timer、重复投递和快照覆盖。
- 工具真正执行前再次检查任务终态，防止排队中的副作用工具在父任务结束后继续启动。
- 新增混合工作部分投递、全部完成快速路径、timer 恢复、到期投递恢复、模型运行中结果
  到达和父任务终止清理测试。

## 0.3.1 - 2026-08-21

### 修复

- 修复部分风险。

## 0.3.0 - 2026-08-20

### 新增

- 新增 `TURN_SUMMARY_PROTOCOL`，每次正常模型请求都要求模型在主结果之外搭载结构化
  `turnSummary.request` 和 `turnSummary.outcome`。
- 新增完整上下文与摘要上下文双通道存储。轮次摘要记录其对应的原始上下文索引区间，
  不覆盖或删除完整历史。
- 新增 `ContextWindowManager`，默认在模型上下文窗口达到 80% 时触发压缩，并以 60%
  作为压缩目标。
- 新增早期摘要与近期完整记录的混合上下文构造。运行时从最旧轮次开始逐段替换，
  达到目标后停止，避免不必要地损失近期细节。
- 新增可替换的 `ContextCompactor` 接口及 `FakeContextCompactor`。本地轮次摘要仍不足
  时，可把混合上下文交给模型厂商进行二次语义压缩。
- 新增轮次摘要与二次压缩事件，并将摘要记录纳入任务快照和恢复流程。
- 新增搭车摘要、混合上下文、二次压缩、压缩失败和子任务预检失败回传测试。

### 变更

- 所有进入 Ready Queue 的路径现在都必须先通过上下文窗口预检，包括任务提交、恢复、
  工具唤醒、模型重试、子任务创建、Spawn 拒绝恢复和父任务唤醒。
- `ModelProvider` 现在必须声明 `contextWindowTokens`，`ModelRequest` 新增
  `summaryProtocol`；Provider Adapter 负责映射为厂商 Prompt 和结构化输出能力。
- `FakeModelProvider` 支持按请求动态估算 Token，便于验证不同上下文组合。
- 二次压缩请求与普通模型请求共享 RPM、TPM、并发和预算准入控制，压缩费用计入任务
  总预算，但不消耗任务的正常模型轮次。
- 子任务创建顺序调整为“注册子任务 -> 父任务建立等待关系 -> 子任务上下文预检”，
  确保预检失败的子任务仍能把失败结果回传给父任务。

### 安全与可靠性

- 超过预警值且无法压缩的请求不会进入 Ready Queue，避免任务轮到发送时才突然失败。
- 二次压缩后仍超过目标值时会确定性终止，不会形成无限压缩循环。
- 二次压缩输入自身超过 Compactor 上下文窗口时会在调用前失败。
- 压缩等待状态纳入 `runUntilIdle()` 的 pending/stalled 统计，避免形成不可见悬挂任务。

## 0.2.0 - 2026-08-20

### 新增

- 新增全局 `AgentPool`，分别限制：
  - 同时存活的 Agent 数量；
  - 每棵任务树累计创建的子 Agent 数量；
  - 子 Agent 委派树的最大深度。
- 新增根任务、父任务和委派深度元数据，并将其纳入任务快照。
- 新增 `spawn_subagents` 模型响应和批量子任务创建流程。
- 新增 `needs_parent_action` 子任务结果，允许叶子 Agent 把无法独立完成的前置工作
  结构化返回给父任务。
- 新增子任务创建、结果回传和拒绝原因事件。
- 新增三级深度感知就绪队列，默认采用 `Q3:Q2:Q1 = 4:2:1` 加权轮转。
- 新增等待老化机制，长期等待的浅层任务会逐级提升有效调度层级。
- 新增父任务唤醒加速，父任务收到全部子任务结果后可获得一次最高层调度机会。
- 新增 Capability 衰减检查，子任务不能获取父任务没有的能力。
- 新增 Agent 池、分层队列和三层委派流程测试。

### 变更

- `maxModelAttempts` 现在作为任务模型调用总轮次上限实际生效，防止反复委派或
  重试形成无限循环。
- 模型请求现在携带当前深度、最大深度、剩余 Agent 槽位以及是否允许继续委派。
- 子任务创建改为先检查并预留所有槽位，再创建子任务，最后才阻塞父任务。
- 任务终止后会释放 Agent 池槽位，并把结构化结果写回父任务上下文。
- `ReadyQueue` 从单数组静态优先级升级为深度加权调度，同时保留同层任务优先级和
  FIFO 顺序。

### 安全与可靠性

- 最大深度到达后，即使仍有空闲 Agent 槽位，也会拒绝继续委派。
- Agent 池已满时，父任务保持可运行，不会进入等待不存在子任务的阻塞态。
- 每棵任务树的累计创建额度不会因为子任务结束而重置。
- 禁止重复使用任务 ID，避免覆盖任务快照、事件和父子关系。
- 同一父任务的并发创建请求通过父任务级锁串行化，避免重复分支和等待关系覆盖。
- 父任务取消时会向下取消当前存活的子任务。

## 0.1.0 - 2026-08-19

### 新增

- 初始三态任务模型：`READY`、`RUNNING`、`BLOCKED`。
- `TERMINATED` 终态和受控状态转换。
- `TaskControlBlock`、任务快照和只追加事件历史。
- 单队列优先级调度、RPM/TPM/并发/预算准入控制。
- Provider 抽象、Fake Model Provider 和 Capability 工具权限。
