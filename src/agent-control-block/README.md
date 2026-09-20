# Agent control block

Public entry: `os-agent-js/agent-control-block` after `npm run build`.
Repository consumers use `src/agent-control-block/index.ts`.

This module currently defines data only. An ACB represents a persistent Agent
performing an ongoing role. It is independent of the existing task-oriented
`TaskControlBlock` and is not connected to the current scheduler.

```ts
import {
  AgentState,
  type AgentControlBlock,
} from 'os-agent-js/agent-control-block';

const agent: AgentControlBlock = {
  agentId: 1,
  character: 'sales',
  agentName: 'Sales Assistant',
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
      instructions: ['Follow current company sales policies.'],
      currentTask: { id: 'sales-role', objective: 'Perform ongoing sales work.' },
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
```

- `agentId`: persistent positive integer identity. ID allocation and runtime
  validation are not implemented; the TypeScript representation is `number`.
- `character`: registered role identifier. `agentName` is a display name and
  does not replace the numeric identity for communication routing.
- `state`: exactly `READY`, `RUNNING`, `BLOCKED` or `SLEEPING`. These describe
  Agent scheduling, not task status or memory/disk residency.
- `capacity`: filesystem permissions using existing capability names and
  `ResourceScope`. No task grant IDs, task subjects or task delegation chains
  are copied. This is a data shape, not an authorization implementation.
- `skills`: callable tool IDs, independent of resource permissions. Tool
  implementations and schemas stay in their registry.
- `context`: `AgentContext`, supplied by the public `agent-context` module.
  It contains three levels, task references/chains, semantic memory and budgets.
  See [the context contract](../agent-context/README.md). The sample limits above
  are examples, not runtime defaults.
- `createdAt`: Agent creation time in Unix milliseconds (the earlier
  `runningTime` concept), not elapsed execution time or model creation time.
- `modelConfigId`: host model configuration reference, with no API key or
  dependency on any model vendor.

`api.ts` contains the declarations and `index.ts` exposes them. Fields are
read-only at the TypeScript API boundary; this adds no runtime state machine
or deep immutability enforcement.

Future module responsibilities include converting between managed context and
the requester's `ModelMessage` protocol. Conversion signatures and
implementations are deliberately deferred until those protocols are settled.
The ACB module does not implement factories, codecs, task verification, workflow
control, persistence, scheduling or TCB adapters. Task-state declarations belong
to `agent-context`; the four ACB scheduling states remain separate.
