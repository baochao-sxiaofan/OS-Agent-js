# 长期 Agent 控制块

公共入口：构建后通过 `os-agent-js/agent-control-block` 导入，
仓库内通过 `src/agent-control-block/index.ts` 导入。

ACB 表示持续履行角色职责的长期 Agent，与面向单次任务的 `TaskControlBlock` 独立。
本模块提供数据契约、实例工厂和状态转换接口，由新的 `agent-scheduler` 调用，
目前尚未接入旧桌面运行链路。

```ts
import {
  AgentState,
  createAgentControlBlock,
  type AgentControlBlock,
} from 'os-agent-js/agent-control-block';

const initial: AgentControlBlock = {
  agentId: 1,
  character: 'sales',
  agentName: '销售助理',
  state: AgentState.SLEEPING,
  capacity: [
    {
      capability: 'file.read',
      scope: { kind: 'subtree', resource: 'workspace://current/products' },
    },
  ],
  skills: ['file.read'],
  context: {
    schemaVersion: 1,
    level1: {
      id: 'sales-root',
      level: 1,
      instructions: ['遵循公司当前的销售政策。'],
      currentTask: { id: 'sales-role', objective: '持续开展销售工作。' },
      taskChain: {
        target: 2,
        revision: 0,
        phase: 'PLANNING',
        currentTaskId: null,
        tasks: [],
      },
      memory: {
        summary: null,
        lessons: [],
        recentEntries: [],
        historyRef: null,
      },
      budget: {
        maxTokens: 8_000,
        compactAtTokens: 6_000,
        targetTokens: 4_000,
        maxTasks: 12,
      },
    },
    level2: null,
    level3: null,
  },
  createdAt: 1_789_862_400_000,
  modelConfigId: 'sales-default',
};

const agent = createAgentControlBlock(initial);
const snapshot = agent.snapshot();
```

- `agentId`：持久身份，由宿主分配；工厂验证它是正安全整数，恢复时保留原值。
- `character`：已注册的角色标识。`agentName` 用于展示，通信寻址使用数字身份。
- `state`：固定为 `READY`、`RUNNING`、`BLOCKED`、`SLEEPING`，
  表示 Agent 调度状态，与内部任务进度和内存驻留位置无关。
- `capacity`：复用既有能力名称和 `ResourceScope` 的文件系统权限。
  这里仅定义数据形状，权限签发、撤销和执行校验留待后续实现。
- `skills`：可调用工具的 ID；与资源权限独立，工具实现和参数定义保留在注册表。
- `context`：公共 `agent-context` 模块定义的三级上下文，包含任务引用、任务链、
  语义记忆和预算。见[上下文协议](../agent-context/README.md)。
  上述预算仅是示例，不是运行时默认值。
- `createdAt`：Agent 创建时的 Unix 毫秒时间戳，工厂验证它是非负安全整数。
- `modelConfigId`：宿主管理的模型配置引用，不包含凭据，不依赖具体模型厂商。

## 状态接口

`createAgentControlBlock(initial)` 复制初始数据并返回 `ManagedAgentControlBlock`。
公开身份在运行时冻结；`snapshot()` 返回独立副本，修改副本不会改变内部数据。
`getState()` 读取状态，`transition(next)` 按以下规则同步转换：

- SLEEPING → READY。
- READY → RUNNING。
- RUNNING → READY、BLOCKED 或 SLEEPING。
- BLOCKED → READY。

重复转换和非法状态边抛出 `InvalidAgentTransitionError`。
`canAgentTransition(from, to)` 仅查询状态边是否允许。
调度器持有较窄的 `AgentSchedulingHandle` 接口，不读取 Context 或权限。
ACB 校验状态边，调度器依据队列、双 Map 和在途批次决定转换时机；
状态接口只能交给可信宿主组件，同一实例不得由多个调度器同时管理。

`api.ts` 定义公共协议，`index.ts` 统一导出，内部实现不作为独立包路径暴露。
这里尚未实现 Context 修改、请求消息转换、工作流执行、权限裁决、持久化或 TCB 适配。
Context 仍是数据协议，其引用完整性、预算和内部任务状态由后续管理模块负责。
