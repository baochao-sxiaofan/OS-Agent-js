# Agent context

Public entry: `os-agent-js/agent-context` after `npm run build`.
Repository consumers import `src/agent-context/index.ts`.

This module defines data only. `api.ts` declares read-only, JSON-persistable
snapshots; `index.ts` exports only those public types. There is no manager,
factory, state transition function, prompt builder, summarization request,
storage implementation or TCB adapter yet.

## Three frames

| Field | Current task | Its own task chain | Lifetime |
| --- | --- | --- | --- |
| `level1` | Host-defined ongoing role | Dispatches tasks to level 2 | Persistent root |
| `level2` | Reference to the selected level 1 task | Dispatches tasks to level 3 | Retained until the stage ends |
| `level3` | Reference to the selected level 2 task | Executes steps locally | Retained until the execution ends |

Each frame contains `currentTask`, `taskChain`, `memory` and `budget`.
`level1` also has host-controlled `instructions`. Planning and summarization
must not rewrite those instructions, the root role, or ACB identity/permissions.
The root task is an ongoing responsibility, so it has no completion state.

The lower frames can be `null` before work is dispatched or after results have
been returned. The `AgentContext` union prevents level 3 from existing without
level 2. A waiting or sleeping Agent can still retain unfinished frames;
sleeping never means deleting its work context.

These frames belong to one Agent. They do not create child Agents.

## Task ownership and planning

A chain stores the task definition and its authoritative state exactly once.
Its `currentTaskId` selects an entry in `tasks`. The child frame's `currentTask`
is a `ContextTaskRef` containing the parent's frame ID, plan revision and task
ID. The future manager resolves that reference to construct model input; a
child does not own a second copy of the parent task's state.

Chains are sequential. Array order determines execution order, with no fixed
business node types and no parallel DAG scheduling in this protocol.

- `WAITING -> RUNNING -> COMPLETED` describes ordinary task progress.
- `COMPLETED` carries a `ContextSummary`. The Agent's completion judgment is
  trusted; there is no extra semantic verification stage.
- A replan records a reason and optional partial result, interrupts the current
  task and supersedes unexecuted tasks. Completed results remain in the archived
  revision. `ContextReplan.previousPlanRef` identifies that revision.
- Both normal chain completion and replan return the chain to `PLANNING`.
  `currentTaskId` is then `null`; `EXECUTING` requires a selected task ID.
- Revision `0` means no plan has been installed. Installed plans use increasing
  positive revisions. Old references must not bind to a replacement plan.
- Levels 1 and 2 target the next level. Level 3 targets `'local'`: its steps may
  involve multiple tool calls, but never allocate a fourth context frame.

Task state and ACB scheduling state have different lifetimes. For example, a
task stays `RUNNING` while the Agent is `BLOCKED` waiting for a tool.

If a frame's decomposition is wrong, it replans its own chain. If its assigned
task is itself infeasible, it returns the reason and partial result to its
parent; it cannot replan the parent's chain directly. Command signatures and
the transition implementation are deferred.

## Memory and summaries

`ContextMemory` separates a compact `summary`, retained `lessons`, recent
semantic records and a reference to full stored history. `ContextEntry` covers
user/assistant messages, external events, tool calls/results and explicitly
labeled observations. Large tool output and attachments should be referenced.

`ContextSummary` contains the outcome, facts or hypotheses, decisions, artifact
references, unresolved issues, next responsibilities and lesson candidates.
Sources are references for recall and provenance, not a completion gate.
Summarizing a hypothesis repeatedly does not turn it into a confirmed fact;
retained experience does not become an authoritative system instruction.

When a frame completes its current task, it summarizes itself and returns the
result to its parent. The parent incorporates the relevant result into its own
memory and progresses its chain. Completing one local step need not discard
the entire frame. Capacity-triggered compaction uses the same summary shape
without marking a task complete.

Level 1 retains bounded long-term memory. Level 2 persists across model requests,
sleep and process restarts until its stage ends. Level 3 persists while work
is unfinished, then returns a summary and leaves active context. Finished
frames and original history can be archived without reinserting every record
into future model input. Business records owned by a communication system
remain there; context can keep references and temporary relevant excerpts.

Vendor-private reasoning and `ModelContinuation` are not semantic context.
They remain outside this protocol, managed by the model transport/replay
boundary. This module does not import `ModelMessage`, the old `ContextItem`,
`TaskControlBlock`, scheduler, or model providers.

## Bounds and compatibility

Each frame supplies `maxTokens`, `compactAtTokens`, `targetTokens` and `maxTasks`.
They cover the frame's tasks, results, instructions and active memory. A future
manager must compact before the hard limit, archive old chains, and enforce
`targetTokens < compactAtTokens < maxTokens`. A future prompt builder must
separately enforce the total model budget including inherited context, tools
and output allowance.

These are declarations, not runtime guarantees. Reference integrity, sequential
execution, revision monotonicity, numeric bounds and read-only enforcement
at runtime will require the future manager. No default numeric limits or LLM
call policy are imposed here.

ACB now imports this public contract. The former `src/context/agent-context.ts`
and `src/context/index.ts` paths re-export the same type for source-path
compatibility. The old empty `{}` placeholder is intentionally no longer a
valid `AgentContext`. Existing task-oriented context management is unchanged.

See [the checked three-level example](../../examples/agent-context.ts) for an
ACB whose frames reference each other's tasks. `npm run check` type-checks it.
