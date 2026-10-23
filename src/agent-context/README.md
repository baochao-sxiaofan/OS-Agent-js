# 三级上下文管理

公共入口：`os-agent-js/agent-context`。本模块保存任务、语义记忆、待总结阶段和
收件箱，提供运行时校验与原子持久化；不依赖 scheduler、模型厂商或旧 TCB。
模型请求由 [`agent-round`](../agent-round/README.md) 编排。

| 层级 | 当前任务 | 自身任务链 | 生命周期 |
| --- | --- | --- | --- |
| L1 | 宿主提供的长期职责 | 向 L2 派发阶段 | 永久保留 |
| L2 | 引用 L1 当前任务及计划版本 | 向 L3 派发工作 | 完成总结后归档释放 |
| L3 | 引用 L2 当前任务及计划版本 | 在本层执行步骤 | 完成总结后归档释放 |

三层属于同一个 Agent。当前只支持一条活跃层级链，不包含并行阶段、挂起栈或第四层。
父任务状态只保存在父层任务链中，子层通过版本引用访问，避免双份状态漂移。

## 创建与恢复

```ts
import {
  createAgentContextManager,
  restoreAgentContextManager,
  SqliteContextStore,
} from 'os-agent-js/agent-context';

const store = new SqliteContextStore('./agent-context.sqlite');
const budget = {
  maxTokens: 20_000, compactAtTokens: 15_000, targetTokens: 8_000, maxTasks: 12,
};
const context = createAgentContextManager({
  key: 'agent-1', store,
  instructions: ['遵守宿主工作规则。'],
  objective: '持续处理用户委托',
  policy: {
    budgets: { 1: budget, 2: budget, 3: budget },
    maxSummaryAttempts: 3, maxInbox: 32, maxDeliveryBytes: 10_000,
  },
});

// 重启时使用同一 key 和存储，不再次 create。
const restored = restoreAgentContextManager({ key: 'agent-1', store });
```

这些数值是示例，创建时必须由宿主明确提供。内部身份由管理器生成；测试可注入
`createId`。每个 Agent 只应有一个活跃管理器和一个轮次执行器。存储比较检查点版本，
拒绝陈旧实例覆盖新状态；恢复出来的实例用于替换旧实例。

`snapshot()` 返回 `AgentContext` 独立副本；`checkpoint()` 还包含策略、待总结信息、
收件箱和版本。恢复前校验 JSON 结构、跨层引用、预算与阶段。
ACB 使用 `createAgentControlBlock(initial, context)` 绑定只读快照端口，
避免 ACB 独立保存一份过期 Context。

## 任务动作

`apply(roundKey, cursor, decision, entries?)` 原子提交普通轮语义结果。
`cursor()` 由宿主保存，不能进入模型提示词。`roundKey` 使用调度批次的稳定 ID，
重试成功轮次时读取回执，不重复提交。

| 动作 | 行为 |
| --- | --- |
| `plan` | 安装非空有序计划，生成任务身份；拒绝覆盖未完成任务 |
| `replan` | 归档旧计划，运行项转为 INTERRUPTED，等待项转为 SUPERSEDED，提升版本 |
| `advance` | 选取下一个 WAITING 任务；L1/L2 创建子层，L3 留在本层 |
| `step_completed` | 完成 L3 的一个 RUNNING 步骤并保存结果，不释放本层 |
| `complete` | L2/L3 当前目标完成，进入待总结；任务链必须无未完成项 |
| `interrupt` | 携带原因进入总结，向父层返回 INTERRUPTED 与部分结果 |
| `compact` | 未完成目标的同层压缩，不改变未完成任务及身份 |
| `idle` | L1 工作结束，进入空闲总结；长期职责和宿主指令始终保留 |
| `continue` / `wait` | 继续普通处理或等待；轮次执行器要求 wait 有在途操作 |

动作只能作用于最深活跃层。子层不能修改父层计划、根层指令、预算或 ACB 权限。
`createContextView()` 去除任务、帧与计划版本身份，只保留模型需要的语义数据。
普通轮可以包含多次工具工作的语义记录，实际工具执行和幂等键由宿主执行模块管理。

## 独立总结轮

```text
普通 AgentRun：业务结果 → complete / idle → 持久化待总结 → finishRun(continue)
下一 AgentRun：只请求总结 → 校验 → 原子归档并回传 → finishRun(continue / idle)
```

`PendingContextSummary` 保存目的、来源快照引用、允许引用集合、计划版本及尝试次数。
源场景封存后，新的输入只进入收件箱。请求前调用 `beginSummaryAttempt()` 持久化次数；
失败记录错误并保留现场。重试上限到达后抛出 `retry_exhausted`，由宿主处理，不能
吞错无限重试或错误地标记休眠。

可信宿主可用 `configureBudget()` 修改各层容量，任务与原文保持不变；待总结场景会
另行封存新的预算版本，旧引用不可覆盖。宿主显式恢复可调用 `retrySummary()` 重开有限
尝试，自动重试不得重置计数。Runtime 的 resume 会同时归档旧失败响应并重建请求，
不跳回业务轮；在线设置与服务器配置见[使用说明](../../docs/server-runtime.md)。

`commitSummary()` 校验结构、来源、版本和预算，不增加额外的语义验收模型。
成功时在同一事务中写入摘要、更新父层任务结果、释放子层和保存轮次回执。
父层下一普通轮读取子层结果，决定继续派发、规划还是结束自己的目标。
根层空闲总结成功且收件箱为空时，Context 才返回无继续工作。

总结包含结果、事实或假设、决定、产物、未决项、后续责任和可选经验。
事实要求来源；所有引用必须来自封存集合，不能虚构引用。
管理器不判断事实在业务上是否正确，也不自动提升假设或将候选经验写入宿主指令。
总结输出不得带额外字段；`ModelContinuation` 和厂商私有推理不写入语义上下文。

## 输入与完整历史

来源系统先持久保存消息，再调用 scheduler.notify。编排层解析封存事件和工具结果，
转换为 `ContextDelivery` 并调用 `receive()`。每项提供稳定键与语义记录；
针对任务的结果必须携带操作发起时的 `ContextCursor`，默认目标为根层。

投递记录、去重键和收件箱同事务保存。重复键不重复加入，重复键绑定不同正文会报错。
`prepare()` 只把属于当前执行层的输入加入近期记忆，祖先输入等待该层重新获得执行权。
旧版本或已释放帧的结果作为 `stale_context_input` 引用交给根层，不直接写入新计划。
大内容应先存为外部产物，用附件或观察来源引用传入；超限时来源系统保留并重投。

`historyRef` 链接历史快照和摘要来源。计划替换、压缩、释放子层均保留原始历史；
完整记录与有界活跃记忆分离。外部存储随历史增长，当前没有自动删除或保留期策略。

## 容量、持久化与边界

各层强制满足 `targetTokens < compactAtTokens < maxTokens` 及任务数量上限。
当前用 JSON 的 UTF-8 字节数做保守 Token 估算，不是模型 tokenizer 的精确计数。
`prepare()` 达到阈值后安排压缩；压缩后整层必须回到目标容量，否则拒绝提交并保留场景。
不能压缩的超大指令、任务或单条内容需要宿主缩小输入；不会静默截断。
父层吸收总结也必须满足硬上限，过长总结会被拒绝。完整请求还由编排层检查输入、
工具定义和输出预留容量。

`InMemoryContextStore` 适合演示；`SqliteContextStore` 使用 SQLite 事务、WAL、
FULL 同步与检查点版本比较。它们原子保存检查点、追加记录和轮次回执。
内存状态只在存储成功后发布。自定义 `ContextStore` 必须遵守同步原子提交约定。

恢复后保留待总结、来源和次数；宿主应将有继续工作的 Agent 重新登记为 READY。
本模块不恢复 scheduler 的在途操作、定时器、供应商准入配额，也不提供业务副作用的
跨进程恰好一次执行。工具执行模块仍需稳定幂等键及自己的恢复协议。
旧 `TaskControlBlock` 与桌面运行链路保持独立。

运行完整演示：`npm run demo:agent-context`。实现按任务、总结、收件箱、校验、存储拆分，
入口管理器只负责协调和事务发布。
