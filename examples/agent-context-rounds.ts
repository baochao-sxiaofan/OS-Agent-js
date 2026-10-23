import {
  createAgentContextManager, InMemoryContextStore, type ContextDecision, type ContextSummary,
} from '../src/agent-context/index.js';
import { AgentState, createAgentControlBlock } from '../src/agent-control-block/index.js';
import { createAgentRoundRunner } from '../src/agent-round/index.js';
import { createAgentScheduler } from '../src/agent-scheduler/index.js';
import { createModelRequester } from '../src/model-requester/index.js';
import { z } from 'zod';

// 使用真实请求器协议及本地模拟 HTTP 响应，不需要网络或凭据。
const budget = { maxTokens: 20_000, compactAtTokens: 15_000, targetTokens: 8_000, maxTasks: 8 };
const context = createAgentContextManager({
  key: 'demo-agent', store: new InMemoryContextStore(), instructions: ['根据可追溯结果推进工作。'],
  objective: '持续完成用户委托',
  policy: { budgets: { 1: budget, 2: budget, 3: budget },
    maxSummaryAttempts: 3, maxInbox: 32, maxDeliveryBytes: 10_000 },
});
const agent = createAgentControlBlock({
  agentId: 1, character: 'demo', agentName: '上下文示例', state: AgentState.READY,
  capacity: [], skills: [], context: context.snapshot(), createdAt: Date.now(), modelConfigId: 'local-demo',
}, context);
const scheduler = createAgentScheduler();
scheduler.register(agent);
const decisions: ContextDecision[] = [
  { type: 'plan', objectives: ['整理本周工作'] },
  { type: 'advance' },
  { type: 'plan', objectives: ['归纳已交付内容'] },
  { type: 'advance' },
  { type: 'complete' },
  { type: 'complete' },
  { type: 'idle' },
];
const requester = createModelRequester({
  provider: 'minimax', model: 'MiniMax-M3', apiKey: 'local-demo-only',
  baseUrl: 'https://provider.invalid/v1',
  fetchImplementation: async () => {
    const pending = context.checkpoint().pendingSummary;
    const summary: ContextSummary = {
      outcome: '已完成本层工作并保留交接内容', observations: [], decisions: [],
      artifactRefs: [], unresolved: [], nextResponsibilities: [], lessonCandidates: [],
      sourceRefs: pending ? [pending.sourceRef] : [],
    };
    const decision = pending ? undefined : decisions.shift()!;
    const { type, ...parameters } = decision ?? { type: 'summary' };
    return new Response(JSON.stringify({ choices: [{
      finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [{
        id: 'demo-call', type: 'function',
        function: { name: pending ? 'submit_summary' : `context_${type}`,
          arguments: JSON.stringify(pending ? summary : parameters) },
      }] },
    }] }));
  },
});
const runner = createAgentRoundRunner({
  agentId: 1, scheduler, context, requester, maxRequestTokens: 50_000, maxOutputTokens: 4_000,
  resolveEvent: async (event) => ({ entries: [{
    id: event.eventId, createdAt: Date.now(), kind: 'message', role: 'user', content: event.eventRef,
  }] }),
  resolveResult: async () => { throw new Error('本示例没有异步工具。'); },
  work: async (round) => {
    const decision = decisions[0]!;
    const completion = await round.request({ messages: [{
      role: 'user', content: JSON.stringify(round.view),
    }], tools: [{ name: `context_${decision.type}`, description: '推进本次示例步骤',
      parameters: { type: 'object' } }], toolChoice: 'required' });
    const call = completion.message.toolCalls[0];
    if (completion.message.toolCalls.length !== 1 || call?.name !== `context_${decision.type}`) {
      throw new Error('本示例只接受当前声明的上下文动作。');
    }
    const parameters = 'objectives' in decision
      ? z.object({ objectives: z.array(z.string().min(1)).min(1) }).strict().parse(call.arguments)
      : z.object({}).strict().parse(call.arguments);
    // 示例自己解释工具协议，低层 Round 不依赖 Runtime 的业务动作解析。
    return { decision: { ...decision, ...parameters } };
  },
});

for (let count = 0; count < 20; count++) {
  const run = scheduler.takeNextRun();
  if (!run) break;
  const level = context.snapshot().level3?.level ?? context.snapshot().level2?.level ?? 1;
  const result = await runner.execute(run);
  console.log(`${result.padEnd(7)} L${level} run=${run.runId} -> ${agent.getState()}`);
}
if (agent.getState() !== AgentState.SLEEPING) throw new Error('演示未正常完成。');
console.log('三级工作已逐层总结，最终状态：SLEEPING');
