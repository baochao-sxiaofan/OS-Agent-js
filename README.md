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

当前版本：`0.3.1`

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
- **同层排序**：先比较用户优先级，再按 FIFO 调度。

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

工具声明：

- `requiredCapability`：调用所需能力；
- `effect`：`read_only`、`side_effect` 或 `privileged`；
- 输入校验；
- 执行函数。

子任务的 Capability 必须是父任务 Capability 的子集。只读工具允许并行执行；
有副作用或高权限工具保持串行，避免共享状态竞争。每次工具调用都获得幂等键和
取消信号。

## 当前能力

- 强类型 `TaskControlBlock`
- 合法状态转换校验
- 全局 Agent 池和三类独立上限
- 三级深度感知加权 Ready Queue
- Aging 与父任务唤醒加速
- RPM、TPM、并发额度和任务预算准入控制
- 限流任务基于 `retryAt` 的自动唤醒（`run()`）
- 单任务完成 Promise（`waitForTermination()`）
- 入队前上下文窗口预检
- 正常响应搭载结构化轮次摘要
- 完整上下文与摘要上下文双通道快照
- 早期摘要与近期原文混合构造
- 可替换的二次 `ContextCompactor` Adapter
- 与模型服务商无关的 `ModelProvider`
- 行为确定的 `FakeModelProvider`
- 子任务创建、阻塞、结果回传和父任务唤醒
- Capability 驱动的工具权限控制
- 工具阻塞与事件唤醒
- 任务快照和只追加事件历史
- 单进程内存存储实现

## 目录

```text
src/
├── context/      # 上下文窗口策略与二次压缩 Adapter
├── kernel/       # 状态、任务控制块、上下文和事件
├── model/        # Provider 接口与 Fake Provider
├── persistence/  # 任务快照和事件存储
├── scheduler/    # Agent 池、分层 Ready Queue、准入控制和调度器
├── tools/        # 工具与 Capability 边界
└── types/        # 通用数据类型
```

## 本地验证

```bash
npm install
npm run check
npm test
npm run build
npm run demo
npm run demo:hierarchy
```

基础示例会演示：

```text
READY -> RUNNING -> BLOCKED -> READY -> RUNNING -> TERMINATED
```

分层示例会演示：

```text
root -> middle -> leaf -> middle -> root
```

## 当前边界

- 模型仍使用 Fake Provider，尚未连接真实 LLM。
- Agent 池与任务存储仍为单进程内存实现。
- Agent 池运行态计数尚未持久化，数据库恢复将在后续版本实现。
- 人工审批和资源锁已预留状态，但尚未完成协议。
- 轮次摘要和二次压缩已定义 Provider/Adapter 协议，但尚未连接真实模型服务。
- RAG 仍将在后续通过 Adapter 接入成熟方案。

## 后续方向

1. 增加持久化数据库 Adapter、Agent 池快照和崩溃恢复测试。
2. 增加人工审批和资源锁对应的阻塞/唤醒协议。
3. 增加真实 OpenAI Provider Adapter，并映射结构化轮次摘要协议。
4. 增加 OpenAI Responses Compaction 等真实 `ContextCompactor` Adapter。
5. 通过独立 Adapter 接入成熟的 RAG 方案。

完整的项目约束与设计规则见 [AGENT.md](./AGENT.md)，版本变更见
[CHANGELOG.md](./CHANGELOG.md)。
