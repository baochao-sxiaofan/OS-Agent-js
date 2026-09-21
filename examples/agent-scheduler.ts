import { readFile } from 'node:fs/promises';
import { AgentState, createAgentControlBlock } from '../src/agent-control-block/index.js';
import { createAgentScheduler } from '../src/agent-scheduler/index.js';
import { salesAgent } from './agent-context.js';

// 示例只演示调度协议。模型调用和 Context 更新由调用方通过其他模块实现。
const agent = createAgentControlBlock({ ...salesAgent, state: AgentState.SLEEPING });
const scheduler = createAgentScheduler({ maxConcurrentRuns: 1 });
const resultStore = new Map<string, string>();
scheduler.register(agent);
scheduler.notify(agent.agentId, { eventId: 'read-request', eventRef: 'messages://read-request' });
const firstRun = scheduler.takeNextRun();
if (!firstRun) throw new Error('没有可领取的初始批次。');

// 模拟一轮模型返回了两个读取请求：先统一登记，再启动具体 I/O。
const handles = scheduler.registerOperations(firstRun, [{}, {}]);
const urls = [new URL('../package.json', import.meta.url), new URL('../AGENT.md', import.meta.url)];
const reads = handles.map(async (handle, index) => {
  try {
    const body = await readFile(urls[index]!, { encoding: 'utf8', signal: handle.signal });
    const resultRef = `results://${handle.operation.operationId}`;
    resultStore.set(resultRef, body);
    scheduler.completeOperation(handle.operation, { type: 'succeeded', resultRef });
  } catch (error) {
    scheduler.completeOperation(handle.operation, {
      type: 'failed', error: error instanceof Error ? error.message : '读取失败',
    });
  }
});
scheduler.finishRun(firstRun, 'idle');
await Promise.all(reads);
await scheduler.waitForReady();
const resultRun = scheduler.takeNextRun();
if (!resultRun) throw new Error('读取结果没有生成批次。');
console.log('已封存结果数：', resultRun.batch.results.length);

// 实际发送方在这里按批次引用读取结果、构造模型输入并处理返回。
for (const result of resultRun.batch.results) {
  if (result.outcome.type === 'succeeded') {
    console.log('已读取字数：', resultStore.get(result.outcome.resultRef)?.length);
  }
}
scheduler.finishRun(resultRun, 'idle');
console.log('最终状态：', agent.getState());
scheduler.unregister(agent.agentId);
