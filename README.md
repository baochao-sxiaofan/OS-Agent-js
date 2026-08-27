# OS-Agent-js

OS-Agent-js 是一个使用 TypeScript 开发、借鉴操作系统设计思想的 Agent Harness
与运行时实验项目。

项目不重新实现模型、RAG、Embedding、向量数据库和文档解析，而是专注于：

- 全局模型请求调度；
- Agent 任务状态管理；
- 子 Agent 委派边界；
- API 配额、成本和并发控制；
- 工具权限与副作用隔离；
- 可恢复的任务快照和事件历史。

当前版本：`2.0.0`

## 核心状态模型

本项目从 Agent 调度视角定义三种活动状态：

- `READY`：任务可以调用模型，但正在等待网络、RPM、TPM、并发额度或预算。
- `RUNNING`：远程 LLM 服务正在处理该任务。
- `BLOCKED`：任务正在等待本地工具、子 Agent、人工审批或其他外部结果。

任务完成、失败、取消或要求父任务处理前置工作后进入 `TERMINATED` 终态。

典型生命周期：

```text
READY -> RUNNING -> BLOCKED -> READY -> RUNNING -> TERMINATED
```

## Agent 池与委派树

每个任务都带有：

- `rootTaskId`：所属根任务；
- `parentTaskId`：直接父任务；
- `depth`：当前委派深度，根任务从 1 开始。

默认运行时限制：

```text
maxLiveAgents      = 20   # 同时存活的 Agent 数
maxDepth           = 3    # root -> middle -> leaf
maxSpawnedPerRoot  = 100  # 每棵任务树累计创建的子 Agent 数
```

这三个限制分别防止：

- 横向并发无限扩张；
- 纵向递归无限嵌套；
- 子任务完成后反复创建新 Agent 绕过存活数量限制。

创建子任务采用“预留槽位 -> 创建并持久化 -> 阻塞父任务”的顺序。任务池已满或深度
达到上限时，父任务不会进入阻塞态，而会收到结构化拒绝信息并继续自行处理。

子任务可以返回：

```text
completed            # 已完成
failed               # 执行失败
cancelled            # 被取消
needs_parent_action  # 需要父任务先完成某项前置工作
```

## 增量异步工作任务板

工具调用和子 Agent 委派统一登记到父任务持久化的 `AsyncWorkGeneration` 中。子 Agent
等待 capability 时也只更新对应 Work Record 为 `waiting_for_capability`，不建立独立
消息或唤醒通道。模型可以通过一次 `async_work` 响应同时启动多个子 Agent 和多个长时
工具，不再需要按类型拆成不同轮次，也不必等待整批工作全部结束。

每个父任务使用按需创建的一次性批处理定时器，默认窗口为 30 秒：

```text
没有新结果
-> 不创建定时器

第一个结果完成或子任务状态更新
-> 写入 Completion Mailbox
-> 启动一次性 batch timer

窗口内更多结果完成
-> 只追加任务板，不重复创建 timer

所有工作提前进入终态
-> 取消 timer
-> 立即唤醒父任务

timer 到期但仍有工作运行
-> 一次投递窗口内全部新结果
-> 同时列出仍在运行的工作
```

投递给模型的 `async_work_update` 包含本批 `results`、当前 `pending` 和
`allFinished`。`pending` 会携带子任务的 capability blocker。父 Agent 处理部分结果
或权限申请后，可以返回 `wait_for_async_work` 继续等待；
如果后台结果恰好在父模型运行期间到达，结果会留在 Mailbox，当前模型轮次结束后立即
重新入队，不会并发修改同一个父任务。

Work Table、已投递标记和 `batchDueAt` 都进入任务快照。恢复时会重建尚未到期的 timer；
如果快照位于“timer 已到期、结果尚未投递”的间隙，则立即补做投递。批处理窗口可通过
以下选项调整：

```ts
const scheduler = new TaskScheduler({
  // 其他运行时依赖
  asyncWorkPolicy: { batchWindowMs: 30_000 },
});
```

## 三级深度感知调度

就绪队列根据委派深度分为三级：

```text
Q3：叶子 Agent，默认权重 4
Q2：中层 Agent，默认权重 2
Q1：根 Agent，默认权重 1
```

默认按 `4:2:1` 加权轮转，而不是使用绝对优先级：

```text
Q3, Q3, Q3, Q3, Q2, Q2, Q1, ...
```

这样可以优先完成解除上层阻塞所需的叶子工作，同时保证根任务不会饿死。

额外公平机制：

- **Aging**：等待超过阈值的任务会提升有效调度层级。
- **Parent Wake-up Boost**：父任务收到全部子任务结果后，获得一次最高层调度机会。
- **同层排序**：按入队顺序执行 FIFO 调度，Agent 不能自行提高优先级。

## 模型请求准入

模型调用前统一检查：

- 最大并发模型请求数；
- RPM；
- TPM；
- 单次请求是否永久超过 TPM；
- 任务剩余美元预算；
- 任务模型调用总轮次。

请求获准后获得一个 `AdmissionLease`；请求结束后释放并发槽位。可恢复的速率限制让
任务保持 `READY`，永久不满足的预算或单次 Token 限制会终止任务，避免无限等待。

## 双通道上下文压缩

所有任务在进入 Ready Queue 前都会先完成上下文窗口预检。Provider 必须提供模型上下文
窗口大小和请求 Token 估算，默认策略为：

```text
warning = contextWindowTokens * 0.8
target  = contextWindowTokens * 0.6
```

每次正常模型请求都会携带 `TURN_SUMMARY_PROTOCOL`。Provider Adapter 应把该协议映射为
Prompt 追加指令和严格结构化输出，使模型在正常结果之外同时返回：

```text
turnSummary.request  # 一句话描述本轮需求
turnSummary.outcome  # 一句话描述本轮工作结果
```

这不会增加正常模型请求次数。完整上下文继续只追加保存；摘要以带源索引区间的独立记录
持久化，形成完整记录和压缩记录两个通道。

当上下文超过预警值时，运行时按以下顺序处理：

1. 从最早的轮次开始，用对应摘要替换旧完整记录；
2. 达到目标值后停止替换，因此近期记录仍保留完整内容；
3. 如果“早期摘要 + 近期原文”仍超过目标值，则交给 `ContextCompactor` Adapter
   对混合上下文做二次语义压缩；
4. 二次压缩请求同样经过 RPM、TPM、并发和预算准入；
5. 二次压缩后仍无法达到目标时，任务以明确错误终止，不会进入 Ready Queue
   无限等待或循环压缩。

`FakeContextCompactor` 用于测试该边界。真实 Provider 和压缩 Adapter 尚未接入，
内核不绑定具体模型厂商。

## 工具与权限

工具目录和执行权限相互独立。运行时注册的全局工具构成工具目录；每个 Agent 实际
可见的工具由其 Character 从目录中筛选。工具只声明执行需求，不负责决定调用者是否
有权执行。

- `requiredCapabilities(input)`：根据调用参数推导能力及具体资源范围；
- `requiredCapability`：旧工具使用的全局能力简写；
- `effect`：`read_only`、`side_effect` 或 `privileged`；
- 输入校验；
- 执行函数。

首批内置 workspace 工具包括 `file.read`、`file.write`、`file.create`、`file.delete`、
`file.apply_patch`、`directory.list/create/delete` 和 `workspace.search`，均作用于
`workspace://current/` 挂载点并按调用路径推导 `exact`/`subtree` 资源范围。这些
实现用于 bootstrap 和内核测试；正式接入优先通过 `McpToolAdapter` 复用官方
`@modelcontextprotocol/server-filesystem`。

`test.run` 由 `createTestRunTool(ProcessSandbox)` 创建，只有宿主注入真正的 OS-level
进程沙箱后才会注册并加入 Root Ceiling；禁止降级为裸 `child_process.spawn`。
当前桌面 Runtime 尚未配置 ProcessSandbox，因此不会向模型暴露 `test.run`。

## Character 角色

Character 是内核级角色策略包，而不只是 Prompt。每个角色同时约束四件事：模型可见
的工具、允许持有的能力上限、允许运行时申请的能力，以及允许创建的子角色。首批内置
三个可创建角色，根任务使用 `coordinator`：

- `developer`：在分配目录内读写代码，并在沙箱可用时运行测试；
- `code_auditor`：全工作区只读，发现问题上报父 Agent，不能写文件；
- `researcher`：联网检索资料并写入指定笔记目录，不改源码。

父 Agent 在 `spawn_subagents` 时可为子 Agent 指定 `character`，但内核强制校验：
角色必须已注册、必须在父角色的可创建名单内、请求的能力必须落在该角色能力上限内，
再叠加原有的委派衰减和 workspace 边界。实际授权 = 父可转授范围 ∩ 角色能力上限 ∩
本次 assignment 资源范围。工具可见性只影响“看得见”，能否执行仍由 CapabilityManager
在调用前二次校验。

`CapabilityManager` 是授权的唯一裁决入口。授权以 `CapabilityGrant` 持久化，
包含能力名称、URI 风格资源范围、来源链、可转授标记、期限和可选使用次数。
父 Agent 创建子 Agent 时只能缩小自己持有且可转授的 Grant，不能创造权限或扩大
资源范围。

应用会为新 Conversation 提示用户选择 Workspace，也允许暂时跳过。控制平面保存
经过 `realpath` 规范化的宿主路径，但 Agent 和 Capability 只使用
`workspace://current/` 语义挂载点。本地 bootstrap ToolRuntime 在每次访问前把别名解析为宿主路径，
拒绝 `..` 越界，并用 `realpath` 复查符号链接目标仍在挂载目录内。未选择 Workspace
时，Root 不获得文件系统 Capability，仍可执行不涉及文件 I/O 的任务。选择后，每轮
Root Agent 自动获得该挂载点子树内的文件与目录读、写、创建和删除权限，并可将更窄的
子目录范围转授给子 Agent。下一轮 Root 会重新签发上一轮的 Root Authority Ceiling；
一次性人工 Grant 不会跨轮继承。进程执行、网络、Git 推送和 Workspace 外文件系统
权限不包含在这组默认文件权限中。

Agent 缺少能力时只提交 `request_capabilities`，不能选择审批人。Manager 首先检查
Root Authority Ceiling；根任务不覆盖请求能力及资源范围时直接拒绝：

- 普通能力从最近持权祖先开始，沿直接父子关系逐级向下授权；每一级父 Agent 都只能
  决定是否向自己的直接子 Agent 转授；
- capability blocker 作为 Work Table 的非终态进展，沿用 30 秒批处理窗口；
- `git.push`、转账、生产部署等敏感能力在 Root Ceiling 允许后绕过父 Agent，
  直接进入人工审批；
- 等待普通授权时进入 `BLOCKED(capability_request)`；
- 等待敏感授权时进入 `BLOCKED(human_approval)`；
- 人工签发的敏感 Grant 默认只能被一个内核操作消费一次，同一操作可按幂等键恢复。

Tool 调用前和实际执行前都会校验 Grant。缺权、工具不存在或输入非法会作为结构化
拒绝结果返回给 Agent，不会进入工具执行器。只读工具允许并行执行；有副作用或
高权限工具保持串行。

## 当前能力

- 强类型 `TaskControlBlock`
- 合法状态转换校验
- 全局 Agent 池和三类独立上限
- 三级深度感知加权 Ready Queue
- Aging 与父任务唤醒加速
- RPM、TPM、并发额度和任务预算准入控制
- 限流任务基于 `retryAt` 的自动唤醒（`run()`）
- 单任务完成 Promise（`waitForTermination()`）
- 工具与子 Agent 同轮混合启动（`async_work`）
- 持久化 Work Table 与 Completion Mailbox
- 部分结果批量投递和全部完成快速唤醒
- 父模型运行期间的异步结果合并与任务级串行化
- 异步批处理 timer 快照恢复
- 入队前上下文窗口预检
- 正常响应搭载结构化轮次摘要
- 完整上下文与摘要上下文双通道快照
- 早期摘要与近期原文混合构造
- 可替换的二次 `ContextCompactor` Adapter
- 与模型服务商无关的 `ModelProvider`
- 行为确定的 `FakeModelProvider`
- 通过 HTTPS 调用 Gemini 的 `GeminiModelProvider`
- 支持 Claude 的 `AnthropicModelProvider`
- 支持 OpenAI-compatible 协议的通用 Provider
- 账号级模型目录发现与运行时协议验证
- OpenAI、Claude、Gemini、Kimi、Grok、MiniMax、GLM、DeepSeek、Qwen、
  豆包和 Xiaomi MiMo 配置入口
- Gemini 结构化 final、子 Agent 委派、异步等待、父任务协助响应和轮次摘要
- 子任务创建、阻塞、结果回传和父任务唤醒
- Capability 驱动的工具权限控制
- 资源范围化 Capability Grant、父级衰减委派和敏感权限人工路由
- Capability 请求的阻塞、审批、唤醒、快照与审计事件
- Character 注册表、角色 Prompt、工具可见性、能力上限与子角色约束
- `developer`、`code_auditor`、`researcher` 和根 `coordinator`
- bootstrap 工作区文件工具与通用 `McpToolAdapter`
- mock HTTP Provider 到真实文件写入的完整工具调用闭环
- 工具阻塞与事件唤醒
- 任务快照和只追加事件历史
- Conversation、Workspace 映射和多轮 Root Authority Ceiling 持久化
- 单进程内存存储实现
- Electron 桌面控制台与 Windows NSIS 安装包
- Conversation 多轮对话和按轮次查看 Agent 工程拓扑

## 目录

```text
src/
├── capability/   # 资源范围、Grant、审批策略和逐级授权
├── character/    # Character 定义、注册表与内置角色
├── context/      # 上下文窗口策略与二次压缩 Adapter
├── kernel/       # 状态、任务控制块、上下文和事件
├── model/        # Provider 接口与 Fake Provider
├── persistence/  # 任务快照和事件存储
├── scheduler/    # Agent 池、分层 Ready Queue、准入控制和调度器
├── tools/        # 工具、内置 Skills 与工作区路径解析
└── types/        # 通用数据类型

desktop/
├── main/         # Electron 主进程与 Runtime Service
├── preload/      # 隔离的 IPC 白名单桥接
├── renderer/     # React Agent 拓扑控制台
└── shared/       # 主进程与渲染进程共享的数据契约
```

## 本地验证

```bash
npm install
npm run check
npm test
npm run build
npm run demo
npm run demo:hierarchy
npm run benchmark:multi-agent
```

基础示例会演示：

```text
READY -> RUNNING -> BLOCKED -> READY -> RUNNING -> TERMINATED
```

分层示例会演示：

```text
root -> middle -> leaf -> middle -> root
```

### 桌面拓扑控制台

桌面端以 Agent 拓扑而不是聊天消息作为主界面。没有任务时显示任务入口；任务运行后，
根 Agent、子 Agent、状态和连接关系会根据 `TaskSnapshot` 实时更新。点击任意节点可
查看该 Agent 的状态、Token、预算和事件历史。右上角可在对话流和 Agent 工程视图间
切换；根任务完成后自动进入对话流，工程视图仍保留拓扑，并可在同一 Conversation 中
发起下一轮任务。对话流底部也可以直接提交新任务；每轮回复都带有对应的工程图入口，
可以在历史轮次之间独立查看各自的 Agent 执行拓扑。

本地启动：

```bash
npm run desktop:dev
```

没有配置模型时，桌面端使用带网络延迟模拟的 `FakeModelProvider`，用于演示三级
Agent 拓扑和完整状态迁移。点击左侧“模型与 API”，按以下顺序配置真实模型：

```text
选择模型厂商
-> 填写 API Key 和厂商要求的附加参数
-> 获取当前账号可用模型
-> 选择模型并执行 OS-Agent 结构化协议验证
```

OpenAI、Claude、Gemini、Kimi、Grok、MiniMax、DeepSeek、Qwen 和 Xiaomi MiMo
支持在线发现模型。GLM 和豆包因账号模型目录使用不同的管理鉴权体系，当前提供手工
模型 ID 入口。API Key 只通过受控 IPC 进入 Electron 主进程；系统安全存储可用时加密
保存，否则只保留在当前进程内存中。密钥不会进入任务上下文、事件日志或 URL。

桌面生产构建：

```bash
npm run desktop:check
npm run desktop:build
```

推送到 `main` 后，`.github/workflows/windows-desktop.yml` 会在 Windows Runner 上
执行检查和测试，并生成 `OS-Agent-Setup-2.0.0-x64.exe`。也可以在 GitHub Actions
页面手动触发该工作流。

### 最小 Gemini 网络验证

Gemini API Key 只通过当前终端的环境变量传入，不写入仓库：

```bash
export GEMINI_API_KEY="your-key"
npm run demo:gemini
```

可选指定模型：

```bash
export GEMINI_MODEL="gemini-3.5-flash-lite"
```

该示例只提交一句极短任务，并要求 Gemini 返回严格 JSON：

```json
{
  "action": "final",
  "output": "pong",
  "turnSummary": {
    "request": "一句话需求摘要",
    "outcome": "一句话结果摘要"
  }
}
```

真实多 Agent 冒烟测试：

```bash
export GEMINI_API_KEY="your-key"
npm run demo:gemini:multi-agent
```

该示例执行：

```text
root -> leaf-2 + leaf-3 -> root
```

两个 leaf 并行计算 `2²` 和 `3²`，root 收到结构化 `async_work_update` 后汇总为
`4+9=13`。

### 多 Agent 调度基准

```bash
npm run benchmark:multi-agent
```

基准使用固定延迟 Fake Provider，构造 1 个 root、3 个 middle、12 个 leaf，共
16 个 Agent 和 20 次模型请求，并分别测试并发度 1、2、4、8。它验证：

- 模型请求峰值不超过准入并发上限；
- AgentPool 存活数量不越界且任务结束后归零；
- Ready Queue 按深度权重工作且没有任务丢失；
- root/middle 收到完整的异步结果；
- 完整上下文和摘要上下文分别保留；
- 模型请求深度分布固定为 `2/6/12`。

## 当前边界

- Gemini、Anthropic 和 OpenAI-compatible Provider 已支持真实 HTTPS 与 OS-Agent
  结构化协议；不同厂商对 JSON Mode、模型目录和参数的兼容程度仍由保存时的真实请求
  验证。
- GLM 和豆包当前使用手工模型 ID；Qwen 模型目录需要华北 2 业务空间 ID。
- 模型配置切换仅影响后续任务，存在活动 Agent 时禁止切换 Provider。
- 任务快照与事件已通过 SQLite 持久化；应用启动时会批量恢复任务树，把失效的
  `RUNNING` 请求退回 `READY`，并重建 AgentPool、Work Table 结果投递和 timer。
- 保存过完整 `tool_call` 上下文的运行中本地工具会使用原 `idempotencyKey` 重启；
  没有调用上下文的外部工作仍需对应恢复 Adapter 接管。
- 新建 Conversation 会提示选择 Workspace，也可以暂时不选择；未挂载时仍可继续
  对话，但 Root 不持有文件系统 Capability。空闲时可从侧栏设置入口更换 Workspace。
- `workspace://current/` 到宿主目录的映射已由控制平面持久化；bootstrap 文件工具
  已接入并执行路径与符号链接检查，后续将用官方 filesystem MCP 替换其实现。
- `test.run` 需要宿主注入 OS-level `ProcessSandbox`；当前桌面 Runtime 未配置该
  后端，因此不会暴露命令执行工具。
- `researcher` 的联网能力边界已经定义，但 Web/MCP 搜索工具尚未接入。
- 真实目标模型 API 的工具调用兼容性尚未冒烟验证；当前只完成 mock HTTP Provider
  的完整写文件闭环验证。
- Capability 人工审批已提供内核查询与决议 API，桌面审批界面尚未接入；资源锁仍仅
  预留状态。
- 轮次摘要和二次压缩已定义 Provider/Adapter 协议，但尚未连接真实模型服务。
- RAG 仍将在后续通过 Adapter 接入成熟方案。

## 后续方向

1. 接入官方 filesystem MCP 与通用 MCP stdio/Streamable HTTP Client。
2. 为 `ProcessSandbox` 接入可按 Conversation 隔离的 OS-level 后端。
3. 接入 Web 搜索和本地预览/UI 检查 Skills。
4. 增加人工审批和资源锁对应的阻塞/唤醒协议。
5. 增加 Provider 级能力探测和更细粒度的模型兼容性矩阵。
6. 增加真实 `ContextCompactor` Adapter。
7. 通过独立 Adapter 接入成熟的 RAG 方案。

完整的项目约束与设计规则见 [AGENT.md](./AGENT.md)，版本变更见
[CHANGELOG.md](./CHANGELOG.md)，本轮多 Agent 测试过程与结果见
[OS-Agent-js 0.6.0 测试报告](./docs/test-report-0.6.0.md)。
