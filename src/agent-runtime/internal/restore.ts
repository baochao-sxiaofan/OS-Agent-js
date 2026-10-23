import { CapabilityManager } from '../../capability/capability-manager.js';
import { scopeContains } from '../../capability/capability.js';
import type { CharacterRegistry } from '../../character/character-registry.js';
import type { ToolRegistry } from '../../tools/tool-registry.js';
import type { RuntimeAgent, RuntimeLimits } from '../api.js';

/** 先验证用户创建的全部身份和独立授权，再注册任何长期 Agent。 */
export function validateRestoredAgents(agents: readonly RuntimeAgent[], characters: CharacterRegistry,
  tools: ToolRegistry, limits: RuntimeLimits): void {
  const byId = new Map(agents.map((agent) => [agent.control.agentId, agent]));
  const manager = new CapabilityManager();
  const toolIds = new Set(tools.descriptors().map((tool) => tool.name));
  const fail = () => { throw new Error('恢复数据的身份或用户授权与宿主配置不一致。'); };
  if (byId.size !== agents.length || agents.length > limits.maxAgents) fail();
  for (const agent of agents) {
    const id = agent.control.agentId;
    const subject = `agent:${id}`;
    if (agent.contextKey !== subject && !new RegExp(`^agent:${id}:conversation:[a-f0-9-]{36}$`, 'u').test(agent.contextKey) ||
        agent.control.agentName !== `agent-${id}` ||
        !characters.has(agent.control.character)) fail();
    const character = characters.get(agent.control.character);
    if (characters.capabilityOutsideCeiling(character.id, agent.ceiling) ||
        agent.control.skills.some((tool) => !toolIds.has(tool) || !character.visibleToolIds.includes(tool))) fail();
    if (JSON.stringify(agent.control.capacity) !== JSON.stringify(agent.ceiling.map(({ capability, scope }) =>
      ({ capability, scope })))) fail();
    for (const request of agent.ceiling) {
      if ((request.capability.startsWith('file.') || request.capability.startsWith('directory.')) &&
          (request.scope.kind === 'all' || !request.scope.resource.startsWith('workspace://current/'))) fail();
    }
    for (const grant of agent.grants) {
      if (grant.delegable !== false || grant.subjectTaskId !== subject || !agent.ceiling.some((item) =>
        item.capability === grant.capability && scopeContains(item.scope, grant.scope))) fail();
      if (grant.source.type === 'root') {
        const policy = manager.issueRootGrants(subject, [grant], grant.issuedAt)[0]!;
        if ((grant.execution ?? 'allowed') !== policy.execution) fail();
      } else if (grant.remainingUses !== 0 || !grant.consumedBy ||
          grant.source.approvalRequestId !== grant.consumedBy) fail();
    }
  }
}
