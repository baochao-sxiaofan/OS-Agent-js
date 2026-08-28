import type { CapabilityRequest } from '../capability/capability.js';
import type { JsonValue } from '../types/json.js';

export const AGENT_WORK_NODE_KINDS = [
  'design',
  'implement',
  'inspect',
  'integrate',
  'research',
  'review',
  'verify',
] as const;

export const AGENT_WORK_NODE_STATUSES = [
  'abandoned',
  'blocked',
  'completed',
  'failed',
  'pending',
  'ready',
  'running',
] as const;

export type AgentWorkNodeKind =
  (typeof AGENT_WORK_NODE_KINDS)[number];

export type AgentWorkNodeStatus =
  | 'abandoned'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'pending'
  | 'ready'
  | 'running';

export type AgentWorkNodeAssignee =
  | {
      type: 'self';
    }
  | {
      type: 'character';
      character: string;
      requestedCapabilities: CapabilityRequest[];
    };

export type AgentWorkNodeProposal = {
  alias: string;
  kind: AgentWorkNodeKind;
  objective: string;
  dependsOn: string[];
  assignee: AgentWorkNodeAssignee;
  acceptanceCriteria: string[];
};

export type AgentWorkGraphProposal = {
  goal: string;
  completionCriteria: string[];
  nodes: AgentWorkNodeProposal[];
};

export type AgentWorkNode = AgentWorkNodeProposal & {
  status: AgentWorkNodeStatus;
  startedAt?: number;
  completedAt?: number;
  childTaskId?: string;
  blockedReason?: string;
  waitingFor?: string[];
  result?: JsonValue;
  error?: string;
};

export type AgentWorkGraph = {
  revision: number;
  phase: 'executing' | 'planning';
  goal: string;
  completionCriteria: string[];
  nodes: AgentWorkNode[];
  currentNodeAlias?: string;
  createdAt: number;
  updatedAt: number;
};

export type AgentWorkGraphMode = 'execute' | 'plan' | 'waiting';

export type AgentWorkNodeKindDefinition = {
  id: AgentWorkNodeKind;
  description: string;
  promptFragment: string;
  outputContract: string;
};

export const AGENT_WORK_NODE_DEFINITIONS:
  readonly AgentWorkNodeKindDefinition[] = [
    {
      id: 'inspect',
      description:
        'Inspect the workspace, code, constraints, and existing artifacts.',
      promptFragment:
        'Collect concrete facts about the assigned scope before recommending changes. Report relevant resources, constraints, and unknowns.',
      outputContract:
        'Return findings, relevant resources, constraints, and unresolved unknowns.',
    },
    {
      id: 'research',
      description:
        'Gather information needed to complete the assigned objective.',
      promptFragment:
        'Gather only information relevant to the assigned objective and distinguish evidence from inference.',
      outputContract:
        'Return findings, sources or evidence, and implications for the work.',
    },
    {
      id: 'design',
      description:
        'Design architecture, interfaces, responsibilities, or an implementation approach.',
      promptFragment:
        'Produce a concrete design for the assigned scope. Resolve interfaces, ownership boundaries, constraints, and acceptance implications.',
      outputContract:
        'Return design decisions, interfaces, affected resources, and unresolved risks.',
    },
    {
      id: 'implement',
      description:
        'Create or modify the concrete artifact required by the objective.',
      promptFragment:
        'Implement only the assigned objective using the Agent capabilities and visible tools. Inspect relevant existing artifacts before changing them.',
      outputContract:
        'Return changed resources, satisfied criteria, validation performed, and remaining issues.',
    },
    {
      id: 'integrate',
      description:
        'Integrate outputs from multiple nodes and resolve conflicts between them.',
      promptFragment:
        'Combine the supplied results into one coherent artifact. Resolve interface conflicts and preserve the parent objective.',
      outputContract:
        'Return integrated resources, resolved conflicts, validation performed, and remaining risks.',
    },
    {
      id: 'verify',
      description:
        'Verify the artifact against explicit acceptance criteria.',
      promptFragment:
        'Collect executable or inspectable evidence for each assigned acceptance criterion. Do not claim success without evidence.',
      outputContract:
        'Return criterion-by-criterion evidence, failures, and an overall verification result.',
    },
    {
      id: 'review',
      description:
        'Review the current artifact for defects, risks, omissions, and expectation mismatches.',
      promptFragment:
        'Review independently and report concrete findings. Check correctness, completeness, conflicts, and remaining work.',
      outputContract:
        'Return findings with severity, evidence, affected resources, and recommended follow-up.',
    },
  ];

const NODE_ALIAS_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;
const MAX_GRAPH_NODES = 64;

export function validateAgentWorkGraphProposal(
  proposal: AgentWorkGraphProposal,
): void {
  if (!proposal.goal.trim()) {
    throw new Error('Agent work graph goal must not be empty.');
  }
  if (
    proposal.completionCriteria.length === 0 ||
    proposal.completionCriteria.some((criterion) => !criterion.trim())
  ) {
    throw new Error(
      'Agent work graph must define non-empty completion criteria.',
    );
  }
  if (proposal.nodes.length === 0) {
    throw new Error('Agent work graph must contain at least one node.');
  }
  if (proposal.nodes.length > MAX_GRAPH_NODES) {
    throw new Error(
      `Agent work graph cannot contain more than ${MAX_GRAPH_NODES} nodes.`,
    );
  }

  const aliases = new Set<string>();
  for (const node of proposal.nodes) {
    if (!NODE_ALIAS_PATTERN.test(node.alias)) {
      throw new Error(
        `Agent work node alias is invalid: ${node.alias}`,
      );
    }
    if (aliases.has(node.alias)) {
      throw new Error(
        `Agent work node alias is duplicated: ${node.alias}`,
      );
    }
    aliases.add(node.alias);
    if (!AGENT_WORK_NODE_KINDS.includes(node.kind)) {
      throw new Error(`Agent work node kind is unsupported: ${node.kind}`);
    }
    if (!node.objective.trim()) {
      throw new Error(
        `Agent work node objective must not be empty: ${node.alias}`,
      );
    }
    if (node.acceptanceCriteria.length === 0) {
      throw new Error(
        `Agent work node must define acceptance criteria: ${node.alias}`,
      );
    }
    if (
      node.acceptanceCriteria.some((criterion) => !criterion.trim())
    ) {
      throw new Error(
        `Agent work node acceptance criteria must not be empty: ${node.alias}`,
      );
    }
    if (
      node.assignee.type === 'character' &&
      !node.assignee.character.trim()
    ) {
      throw new Error(
        `Agent work node character must not be empty: ${node.alias}`,
      );
    }
  }

  for (const node of proposal.nodes) {
    for (const dependency of node.dependsOn) {
      if (!aliases.has(dependency)) {
        throw new Error(
          `Agent work node ${node.alias} depends on unknown node ${dependency}.`,
        );
      }
      if (dependency === node.alias) {
        throw new Error(
          `Agent work node ${node.alias} cannot depend on itself.`,
        );
      }
    }
  }

  assertAcyclic(proposal.nodes);
}

export function createAgentWorkGraph(
  proposal: AgentWorkGraphProposal,
  revision: number,
  now: number,
): AgentWorkGraph {
  validateAgentWorkGraphProposal(proposal);
  return {
    revision,
    phase: 'executing',
    goal: proposal.goal,
    completionCriteria: [...proposal.completionCriteria],
    nodes: proposal.nodes.map((node) => ({
      ...structuredClone(node),
      status: 'pending',
    })),
    createdAt: now,
    updatedAt: now,
  };
}

export function validateAgentWorkGraph(graph: AgentWorkGraph): void {
  validateAgentWorkGraphProposal({
    goal: graph.goal,
    completionCriteria: graph.completionCriteria,
    nodes: graph.nodes.map((node) => ({
      alias: node.alias,
      kind: node.kind,
      objective: node.objective,
      dependsOn: node.dependsOn,
      assignee: node.assignee,
      acceptanceCriteria: node.acceptanceCriteria,
    })),
  });
  if (!Number.isInteger(graph.revision) || graph.revision <= 0) {
    throw new Error('Agent work graph revision must be a positive integer.');
  }
  if (graph.phase !== 'executing' && graph.phase !== 'planning') {
    throw new Error('Agent work graph phase is invalid.');
  }
  for (const node of graph.nodes) {
    if (!AGENT_WORK_NODE_STATUSES.includes(node.status)) {
      throw new Error(
        `Agent work node status is invalid: ${node.alias}`,
      );
    }
  }
  if (graph.currentNodeAlias === undefined) {
    return;
  }
  if (graph.phase !== 'executing') {
    throw new Error(
      'Agent work graph cannot have an active node in plan phase.',
    );
  }
  const current = graph.nodes.find(
    (node) => node.alias === graph.currentNodeAlias,
  );
  if (!current || current.assignee.type !== 'self') {
    throw new Error(
      'Agent work graph current node must reference a self assignment.',
    );
  }
  if (
    current.status !== 'ready' &&
    current.status !== 'running' &&
    current.status !== 'blocked'
  ) {
    throw new Error(
      'Agent work graph current node has an invalid runtime status.',
    );
  }
}

export function readyAgentWorkNodes(
  graph: AgentWorkGraph,
): AgentWorkNode[] {
  const completed = new Set(
    graph.nodes
      .filter(
        (node) =>
          node.status === 'completed' || node.status === 'abandoned',
      )
      .map((node) => node.alias),
  );
  return graph.nodes
    .filter(
      (node) =>
        (node.status === 'pending' || node.status === 'ready') &&
        node.dependsOn.every((dependency) => completed.has(dependency)),
    )
    .map((node) => structuredClone(node));
}

export function agentWorkGraphMode(
  graph: AgentWorkGraph | undefined,
): AgentWorkGraphMode {
  if (!graph) {
    return 'plan';
  }
  if (graph.phase === 'planning') {
    return 'plan';
  }
  if (graph.currentNodeAlias !== undefined) {
    return 'execute';
  }
  return 'waiting';
}

export function isAgentWorkGraphComplete(
  graph: AgentWorkGraph,
): boolean {
  return graph.nodes.every(
    (node) =>
      node.status === 'completed' || node.status === 'abandoned',
  );
}

function assertAcyclic(nodes: readonly AgentWorkNodeProposal[]): void {
  const dependencies = new Map(
    nodes.map((node) => [node.alias, node.dependsOn] as const),
  );
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (alias: string): void => {
    if (visiting.has(alias)) {
      throw new Error('Agent work graph dependencies contain a cycle.');
    }
    if (visited.has(alias)) {
      return;
    }
    visiting.add(alias);
    for (const dependency of dependencies.get(alias) ?? []) {
      visit(dependency);
    }
    visiting.delete(alias);
    visited.add(alias);
  };

  for (const node of nodes) {
    visit(node.alias);
  }
}
