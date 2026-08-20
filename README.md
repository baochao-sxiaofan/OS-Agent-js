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

当前版本：`0.2.0`

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
- RAG 和上下文压缩将在后续通过 Adapter 接入成熟方案。

## 后续方向

1. 为 RPM/TPM 配额增加自动唤醒定时器。
2. 增加持久化数据库 Adapter、Agent 池快照和崩溃恢复测试。
3. 增加人工审批和资源锁对应的阻塞/唤醒协议。
4. 增加真实 OpenAI Provider Adapter。
5. 通过独立 Adapter 接入成熟的 RAG 和上下文压缩方案。

完整的项目约束与设计规则见 [AGENT.md](./AGENT.md)，版本变更见
[CHANGELOG.md](./CHANGELOG.md)。
