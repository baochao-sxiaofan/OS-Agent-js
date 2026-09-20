import type { JsonPrimitive } from '../types/json.js';

export type ContextLevel = 1 | 2 | 3;

/** Internal identities assigned by the future manager, not by model output. */
export type ContextFrameId = string;
export type ContextTaskId = string;

/** Opaque reference to stored history, an artifact or a source record. */
export type ContextReference = string;

/** JSON data exposed without mutable nested objects or arrays. */
export type ContextValue =
  | JsonPrimitive
  | readonly ContextValue[]
  | { readonly [key: string]: ContextValue };

/** Dynamic work description; there is no fixed business NodeKind. */
export type ContextTaskDefinition = {
  readonly id: ContextTaskId;
  readonly objective: string;
};

/**
 * References one authoritative task in its owner's chain.
 * Replanning changes planRevision; an old reference must not target a new plan.
 * These identities stay internal when a future adapter builds ModelMessage.
 */
export type ContextTaskRef = {
  readonly frameId: ContextFrameId;
  readonly planRevision: number;
  readonly taskId: ContextTaskId;
};

export type ContextObservation = {
  /** Preserve this distinction when summarizing; repetition is not evidence. */
  readonly kind: 'fact' | 'hypothesis';
  readonly statement: string;
  readonly sourceRefs: readonly ContextReference[];
};

export type ContextLesson = {
  readonly statement: string;
  /** Conditions under which this experience is applicable. */
  readonly scope: string;
  readonly sourceRefs: readonly ContextReference[];
};

/**
 * A frame summarizes its own work; its parent incorporates the result.
 * The same shape supports intermediate compaction and task completion.
 * Source references support recall, not a mandatory completion verifier.
 */
export type ContextSummary = {
  readonly outcome: string;
  readonly observations: readonly ContextObservation[];
  readonly decisions: readonly string[];
  readonly artifactRefs: readonly ContextReference[];
  readonly unresolved: readonly string[];
  readonly nextResponsibilities: readonly string[];
  /** Learning suggestions, not automatic changes to host instructions. */
  readonly lessonCandidates: readonly ContextLesson[];
  readonly sourceRefs: readonly ContextReference[];
};

/**
 * Task progress is separate from the ACB's scheduling state.
 * A task can remain RUNNING while the Agent waits for a tool or sleeps.
 * Completion trusts the Agent's judgment; only protocol checks are intended.
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

/** Why a chain was replaced; completed work remains in the archived revision. */
export type ContextReplan = {
  readonly reason: string;
  readonly previousPlanRef: ContextReference;
  readonly partialResult?: ContextSummary;
};

/**
 * An ordered, sequential chain. Only the selected task may run.
 *
 * Revision 0 means no plan has been installed yet; installed revisions are
 * positive safe integers. Normal completion and replan both return to PLANNING.
 * The manager will archive old revisions instead of growing this array forever.
 */
export type ContextTaskChain<
  Target extends 2 | 3 | 'local' = 2 | 3 | 'local',
> = {
  /** Levels 1/2 dispatch downward; level 3 executes its steps locally. */
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
 * Semantic execution records, independent of vendor message formats.
 * Private reasoning and ModelContinuation must stay outside this structure.
 * Large payloads and attachments should use storage references.
 */
export type ContextEntry = {
  readonly id: string;
  /** Unix milliseconds. */
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

/** Bounded active memory, not the full lifetime event log. */
export type ContextMemory = {
  readonly summary: ContextSummary | null;
  /** Experience retained by this level, separate from authoritative rules. */
  readonly lessons: readonly ContextLesson[];
  readonly recentEntries: readonly ContextEntry[];
  /** Complete history lives outside active memory and survives compaction. */
  readonly historyRef: ContextReference | null;
};

/**
 * Per-frame limits covering instructions, task descriptions, results and memory.
 * All values must be positive safe integers, with
 * targetTokens < compactAtTokens < maxTokens. The future manager enforces them.
 * A future prompt builder must also check the total assembled request budget.
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

/** Persistent root; the host supplies its ongoing role and instructions. */
export type LevelOneContext = ContextFrameData & {
  readonly level: 1;
  /** Must not be rewritten by task planning or memory summarization. */
  readonly instructions: readonly string[];
  readonly currentTask: ContextTaskDefinition;
  readonly taskChain: ContextTaskChain<2>;
};

/**
 * A working stage. Retain it across requests, sleep and process restoration
 * until its current task finishes; then summarize upward and archive it.
 */
export type LevelTwoContext = ContextFrameData & {
  readonly level: 2;
  /** The selected task in level 1's chain, not another copy of that task. */
  readonly currentTask: ContextTaskRef;
  readonly taskChain: ContextTaskChain<3>;
};

/**
 * Short-lived execution frame. Its chain contains locally executed steps,
 * which may involve multiple tool calls; it never creates a fourth level.
 */
export type LevelThreeContext = ContextFrameData & {
  readonly level: 3;
  /** The selected task in level 2's chain. */
  readonly currentTask: ContextTaskRef;
  readonly taskChain: ContextTaskChain<'local'>;
};

export type ContextFrame =
  | LevelOneContext
  | LevelTwoContext
  | LevelThreeContext;

/**
 * Read-only, JSON-persistable public snapshot of one Agent's active frames.
 * The root always exists; lower frames are absent until work is dispatched.
 * Level 3 cannot exist without level 2. Completed frames belong in an external
 * archive, with only bounded summaries retained in their parents.
 *
 * This is a data contract, not a ModelMessage or a model-authored replacement
 * for runtime state. Reference integrity, budgets and state transitions require
 * the future manager; TypeScript declarations alone do not enforce them.
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
