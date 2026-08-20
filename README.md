# OS-Agent-js

OS-Agent-js 是一个使用 TypeScript 开发、借鉴操作系统设计思想的 Agent Harness
与运行时实验项目。

当前阶段只验证运行时内核，不直接接入真实 LLM，也不重新实现 RAG、Embedding、
向量数据库和文档解析。

## 核心状态模型

本项目从 Agent 调度视角定义三种活动状态：

- `READY`：任务可以调用模型，但正在等待网络、RPM、TPM、并发额度或预算。
- `RUNNING`：远程 LLM 服务正在处理该任务。
- `BLOCKED`：任务正在等待本地工具、子 Agent、人工审批或其他外部结果。

任务完成、失败或取消后进入 `TERMINATED` 终态。

典型生命周期：

```text
READY -> RUNNING -> BLOCKED -> READY -> RUNNING -> TERMINATED
```

## 第一版能力

- 强类型 `TaskControlBlock`
- 合法状态转换校验
- 支持优先级的全局 Ready Queue
- RPM、TPM、并发额度和任务预算准入控制
- 与模型服务商无关的 `ModelProvider`
- 行为确定的 `FakeModelProvider`
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
├── scheduler/    # Ready Queue、准入控制和调度器
├── tools/        # 工具与 Capability 边界
└── types/        # 通用数据类型
```

## 本地验证

```bash
npm install
npm run check
npm test
npm run demo
```

示例会演示：

```text
READY -> RUNNING -> BLOCKED -> READY -> RUNNING -> TERMINATED
```

## 后续方向

1. 为 RPM/TPM 配额增加自动唤醒定时器。
2. 增加持久化数据库适配器和崩溃恢复测试。
3. 增加人工审批、子 Agent 和资源锁等待类型。
4. 增加真实 OpenAI Provider Adapter。
5. 通过独立 Adapter 接入成熟的 RAG 和上下文压缩方案。

完整的项目约束与设计规则见 [AGENT.md](./AGENT.md)。
