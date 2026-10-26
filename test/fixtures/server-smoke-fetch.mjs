import { readRuntimeRequest } from '../../src/agent-runtime/index.ts';
let index = 0;
let submissions = 0;
const actions = [
  ['context_plan', { objectives: ['整理报告'] }],
  ['context_advance', {}],
  ['context_plan', { objectives: ['读取并写入报告'] }],
  ['context_advance', {}],
  ['file.read', { path: 'workspace://current/input.txt' }],
  ['file.create', { path: 'workspace://current/report.md', content: '项目甲已交付。项目乙仍在测试。' }],
  ['context_complete', {}],
  ['context_complete', {}],
];
// 子进程中的全部 HTTP 请求由此替身接管，冒烟验证不连接真实模型。
globalThis.fetch = async (_url, input) => {
  const body = JSON.parse(String(input?.body));
  const tools = body.tools?.map((tool) => tool.function.name) ?? [];
  const payload = readRuntimeRequest(body);
  let name;
  let parameters;
  if (tools.includes('submit_summary')) {
    name = 'submit_summary';
    parameters = {
      outcome: '报告已完成', observations: [], decisions: [], artifactRefs: [],
      unresolved: [], nextResponsibilities: [], lessonCandidates: [], sourceRefs: payload.allowedRefs.slice(0, 1),
    };
  } else if (index < actions.length) [name, parameters] = actions[index++];
  else {
    submissions++;
    name = 'message_send';
    parameters = { conversationId: payload.conversation?.id ?? payload.destinations[0].id,
      content: submissions === 1 ? '报告已交付' : '已收到后续任务', finish: true };
  }
  if (!tools.includes(name)) throw new Error(`替身拒绝未声明函数：${name}`);
  return Response.json({
    id: `offline-${index}-${submissions}`, model: body.model,
    choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [{
      id: `call-${index}-${submissions}`, type: 'function', function: { name, arguments: JSON.stringify(parameters) },
    }] } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
};
