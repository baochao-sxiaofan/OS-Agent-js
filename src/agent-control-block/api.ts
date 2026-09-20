import type { ResourceScope } from '../capability/capability.js';
import type { AgentContext } from '../agent-context/index.js';

/**
 * Persistent Agent identity, independent of task and model request IDs.
 * The future host allocator must assign unique positive safe integers and
 * preserve them on restore. TypeScript's number alone does not enforce this.
 */
export type AgentId = number;

/** Agent scheduling states, independent of task-chain progress. */
export enum AgentState {
  /** An input is ready to process; waiting for model request admission. */
  READY = 'READY',
  /** A model request for this Agent is in progress. */
  RUNNING = 'RUNNING',
  /** Progress depends on pending work, such as a tool call or approval. */
  BLOCKED = 'BLOCKED',
  /** No runnable or blocking work; waiting for a new external event. */
  SLEEPING = 'SLEEPING',
}

/**
 * Host-managed filesystem permission belonging to the containing Agent.
 *
 * Reuses the existing capability name and resource scope representation.
 * This is not a CapabilityRequest or a task-bound CapabilityGrant; Agent
 * grant issuance, validation and revocation are deferred to a later protocol.
 */
export type AgentFilePermission = {
  /** Filesystem operation, e.g. file.read or directory.list. */
  readonly capability: string;
  /** Exact resource, directory subtree or all resources. */
  readonly scope: ResourceScope;
};

/**
 * Data contract for a long-lived Agent performing an ongoing role.
 *
 * Read-only to consumers; mutation will belong to the future runtime API.
 * It contains no TCB, task lifecycle, transport objects or executable tools.
 */
export type AgentControlBlock = {
  readonly agentId: AgentId;
  /** Registered role identifier, e.g. sales, developer or tester. */
  readonly character: string;
  /** Display name for communication; routing uses agentId, not this name. */
  readonly agentName: string;
  readonly state: AgentState;
  /** Filesystem access permissions, separate from callable skills. */
  readonly capacity: readonly AgentFilePermission[];
  /** IDs of callable registered tools; skill definitions remain external. */
  readonly skills: readonly string[];
  /** Three-level work and memory snapshot owned by agent-context. */
  readonly context: AgentContext;
  /** Agent creation time as Unix milliseconds, a nonnegative safe integer. */
  readonly createdAt: number;
  /** Reference to host-owned model configuration; contains no credentials. */
  readonly modelConfigId: string;
};
