import type { JsonPrimitive } from '../types/json.js';

export type ContextLevel = 1 | 2 | 3;

/** 内部身份由后续管理模块分配，不能由模型输出指定。 */
export type ContextFrameId = string;
export type ContextTaskId = string;

/** 指向已存储历史、产物或来源记录的不透明引用。 */
export type ContextReference = string;

/** 对外只读的 JSON 数据，嵌套对象和数组也不可修改。 */
export type ContextValue =
  | JsonPrimitive
  | readonly ContextValue[]
  | { readonly [key: string]: ContextValue };

/** 动态工作描述，不预设固定的业务 NodeKind。 */
export type ContextTaskDefinition = {
  readonly id: ContextTaskId;
  readonly objective: string;
};

/**
 * 引用所属层任务链中的唯一权威任务记录。
 * 重规划会改变 planRevision，旧引用不能指向新计划。
 * 后续适配器构建 ModelMessage 时，这些身份仍只保留在内核中。
 */
export type ContextTaskRef = {
  readonly frameId: ContextFrameId;
  readonly planRevision: number;
  readonly taskId: ContextTaskId;
};

export type ContextObservation = {
  /** 摘要必须保留事实与假设的区别；重复出现不能作为证据。 */
  readonly kind: 'fact' | 'hypothesis';
  readonly statement: string;
  readonly sourceRefs: readonly ContextReference[];
};

export type ContextLesson = {
  readonly statement: string;
  /** 这条经验适用的条件。 */
  readonly scope: string;
  readonly sourceRefs: readonly ContextReference[];
};

/**
 * 每层总结自身工作，再由父层吸收结果。
 * 同一结构同时支持执行中的压缩和任务完成总结。
 * 来源引用用于回溯，不要求额外的完成验收器。
 */
export type ContextSummary = {
  readonly outcome: string;
  readonly observations: readonly ContextObservation[];
  readonly decisions: readonly string[];
  readonly artifactRefs: readonly ContextReference[];
  readonly unresolved: readonly string[];
  readonly nextResponsibilities: readonly string[];
  /** 候选经验只作为建议，不能自动修改宿主指令。 */
  readonly lessonCandidates: readonly ContextLesson[];
  readonly sourceRefs: readonly ContextReference[];
};

/**
 * 内部任务进度与 ACB 调度状态分开管理。
 * Agent 等待工具或休眠时，内部任务仍可保持 RUNNING。
 * 是否完成由 Agent 判断；管理模块仅进行协议校验。
 */
export type ContextTask = ContextTaskDefinition & (
  | { readonly state: 'WAITING' }
  | { readonly state: 'RUNNING' }
  | {
      readonly state: 'COMPLETED';
      readonly result: ContextSummary;
    }
  | {
      readonly state: 'INTERRUPTED';
      readonly reason: string;
      readonly partialResult?: ContextSummary;
    }
  | { readonly state: 'SUPERSEDED' }
);

export type ContextTaskState = ContextTask['state'];

/** 记录任务链替换原因，已经完成的工作保留在归档版本中。 */
export type ContextReplan = {
  readonly reason: string;
  readonly previousPlanRef: ContextReference;
  readonly partialResult?: ContextSummary;
};

/**
 * 有序串行任务链，同一时间只能运行当前选中的任务。
 *
 * revision 为 0 表示尚未安装计划，已安装版本使用正安全整数。
 * 正常完成和重规划都会回到 PLANNING。
 * 管理模块会归档旧版本，避免任务数组无限增长。
 */
export type ContextTaskChain<
  Target extends 2 | 3 | 'local' = 2 | 3 | 'local',
> = {
  /** 第一、二层向下派发，第三层在本层执行步骤。 */
  readonly target: Target;
  readonly revision: number;
  readonly tasks: readonly ContextTask[];
} & (
  | {
      readonly phase: 'PLANNING';
      readonly currentTaskId: null;
      readonly replan?: ContextReplan;
    }
  | {
      readonly phase: 'EXECUTING';
      readonly currentTaskId: ContextTaskId;
    }
);

export type ContextPhase = ContextTaskChain['phase'];

/**
 * 语义执行记录，与模型厂商的消息格式无关。
 * 模型私有推理和 ModelContinuation 不能进入此结构。
 * 大体积内容和附件应使用存储引用。
 */
export type ContextEntry = {
  readonly id: string;
  /** Unix 毫秒时间戳。 */
  readonly createdAt: number;
} & (
  | {
      readonly kind: 'message';
      readonly role: 'user' | 'assistant';
      readonly content: string;
      readonly attachmentRefs?: readonly ContextReference[];
    }
  | {
      readonly kind: 'event';
      readonly name: string;
      readonly data: ContextValue;
    }
  | {
      readonly kind: 'tool_call';
      readonly callId: string;
      readonly toolName: string;
      readonly input: ContextValue;
    }
  | {
      readonly kind: 'tool_result';
      readonly callId: string;
      readonly toolName: string;
      readonly output: ContextValue;
    }
  | {
      readonly kind: 'observation';
      readonly observation: ContextObservation;
    }
);

/** 容量受限的活跃记忆，不包含整个生命周期的完整事件日志。 */
export type ContextMemory = {
  readonly summary: ContextSummary | null;
  /** 本层保留的经验，与权威规则分开管理。 */
  readonly lessons: readonly ContextLesson[];
  readonly recentEntries: readonly ContextEntry[];
  /** 完整历史保存在活跃记忆之外，压缩时不会被删除。 */
  readonly historyRef: ContextReference | null;
};

/**
 * 每层预算覆盖指令、任务描述、结果和记忆。
 * 所有值必须为正安全整数，并满足
 * targetTokens < compactAtTokens < maxTokens，由后续管理模块强制校验。
 * 后续提示词构造器还需检查组装后的完整请求预算。
 */
export type ContextBudget = {
  readonly maxTokens: number;
  readonly compactAtTokens: number;
  readonly targetTokens: number;
  readonly maxTasks: number;
};

type ContextFrameData = {
  readonly id: ContextFrameId;
  readonly memory: ContextMemory;
  readonly budget: ContextBudget;
};

/** 永久保留的根层，由宿主提供长期职责和指令。 */
export type LevelOneContext = ContextFrameData & {
  readonly level: 1;
  /** 任务规划和记忆总结不得改写这些指令。 */
  readonly instructions: readonly string[];
  readonly currentTask: ContextTaskDefinition;
  readonly taskChain: ContextTaskChain<2>;
};

/**
 * 工作阶段层，跨模型请求、休眠和进程恢复保留。
 * 当前任务完成后，向父层提交总结并归档。
 */
export type LevelTwoContext = ContextFrameData & {
  readonly level: 2;
  /** 引用第一层任务链中选中的任务，不复制其状态。 */
  readonly currentTask: ContextTaskRef;
  readonly taskChain: ContextTaskChain<3>;
};

/**
 * 短期执行层，任务链中的步骤在本层执行，可以涉及多次工具调用。
 * 此层不能继续创建第四层上下文。
 */
export type LevelThreeContext = ContextFrameData & {
  readonly level: 3;
  /** 引用第二层任务链中选中的任务。 */
  readonly currentTask: ContextTaskRef;
  readonly taskChain: ContextTaskChain<'local'>;
};

export type ContextFrame =
  | LevelOneContext
  | LevelTwoContext
  | LevelThreeContext;

/**
 * 单个 Agent 活跃上下文的只读公共快照，可按 JSON 持久化。
 * 根层始终存在，只有工作向下派发后才创建下层。
 * 第三层不能脱离第二层存在。已完成的层应存入外部归档，
 * 父层只保留容量受限的摘要。
 *
 * 这里定义数据协议，不是 ModelMessage，也不允许模型直接替换运行时状态。
 * 引用完整性、预算和状态转换仍需后续管理模块校验，
 * 单靠 TypeScript 类型声明不能强制保证这些约束。
 */
export type AgentContext = {
  readonly schemaVersion: 1;
  readonly level1: LevelOneContext;
} & (
  | {
      readonly level2: null;
      readonly level3: null;
    }
  | {
      readonly level2: LevelTwoContext;
      readonly level3: LevelThreeContext | null;
    }
);
