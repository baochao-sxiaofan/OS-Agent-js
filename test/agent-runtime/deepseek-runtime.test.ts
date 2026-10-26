import { readRuntimeRequest } from '../../src/agent-runtime/index.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createAgentRuntime } from '../../src/agent-runtime/index.js';
import { createModelRequester } from '../../src/model-requester/index.js';
import { summary } from '../agent-context/helpers.js';

it('DeepSeek 原生工具调用完成实际读写、独立总结和重启恢复', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deepseek-runtime-'));
  let ordinary = 0;
  let summaries = 0;
  let sawReadResult = false;
  const requester = createModelRequester({ provider: 'deepseek', model: 'fixture-model', apiKey: 'fixture-only-key',
    fetchImplementation: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: { role: string; content: string; reasoning_content?: string;
          tool_calls?: { id: string }[]; tool_call_id?: string }[];
        tools: { function: { name: string; description: string } }[];
        thinking: { type: string };
        tool_choice: string | { function: { name: string } };
      };
      // 私有状态仅在原生 assistant 消息续接，语义快照和总结输入始终不含推理。
      expect(body.messages.slice(0, 2).map((message) => message.role)).toEqual(['system', 'user']);
      expect(JSON.stringify(body.messages.filter((message) => message.role !== 'assistant'))).not.toContain('私有推理内容');
      for (const [index, item] of body.messages.entries()) if (item.role === 'assistant') {
        expect(item.reasoning_content).toBe('私有推理内容');
        expect(body.messages[index + 1]).toMatchObject({ role: 'tool', tool_call_id: item.tool_calls![0]!.id });
      }
      let message: object;
      const toolCall = (name: string, args: object) => ({ content: null, reasoning_content: '私有推理内容',
        tool_calls: [{ id: `call-${ordinary}-${summaries}`, type: 'function',
          function: { name, arguments: JSON.stringify(args) } }] });
      if (body.tools.some((tool) => tool.function.name === 'submit_summary')) {
        expect(body.messages).toHaveLength(2);
        summaries++;
        expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'submit_summary' } });
        expect(body.thinking.type).toBe('disabled');
        expect(body.tools).toHaveLength(1);
        const payload = readRuntimeRequest(body) as { sourceRef: string };
        message = toolCall('submit_summary', summary(payload.sourceRef));
      } else {
        expect(body.thinking.type).toBe('enabled');
        expect(body.tool_choice).toBe('auto');
        ordinary++;
        if (ordinary === 1) {
          const name = body.tools.find((tool) => tool.function.description.startsWith('Read a UTF-8'))!.function.name;
          expect(name).not.toBe('file.read');
          message = toolCall(name, { path: 'workspace://current/input.txt' });
        } else if (ordinary === 2) {
          expect(body.messages.find((item) => item.role === 'tool')?.content).toContain('可核对的输入资料');
          sawReadResult = JSON.stringify(readRuntimeRequest(body)).includes('可核对的输入资料');
          const name = body.tools.find((tool) => tool.function.description.startsWith('Create a new UTF-8'))!.function.name;
          message = toolCall(name, { path: 'workspace://current/output.txt', content: '真实工具写入的测试结果' });
        } else {
          expect(JSON.stringify(readRuntimeRequest(body))).toContain('bytesWritten');
          message = toolCall('context_idle', {});
        }
      }
      return Response.json({ choices: [{ finish_reason: 'tool_calls', message }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } });
    } });
  const options = { database: join(directory, 'runtime.sqlite'), workspaces: { work: directory }, requester };
  let runtime = createAgentRuntime(options);
  try {
    await writeFile(join(directory, 'input.txt'), '可核对的输入资料');
    await runtime.initialize();
    await runtime.createAgent({ ownerId: 'owner', workspaceId: 'work', character: 'developer',
      objective: '读取输入并创建报告', capabilities: ['file.read', 'file.create'].map((capability) => ({
        capability, scope: { kind: 'subtree', resource: 'workspace://current/' },
      })) });
    runtime.start();
    const deadline = Date.now() + 5000;
    while (runtime.inspect(1, 'owner').control.state !== 'SLEEPING') {
      if (runtime.inspect(1, 'owner').status === 'paused' || Date.now() > deadline) {
        throw new Error(JSON.stringify(runtime.interrupts(1, 'owner')));
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(ordinary).toBe(3);
    expect(summaries).toBe(1);
    expect(sawReadResult).toBe(true);
    expect(await readFile(join(directory, 'output.txt'), 'utf8')).toBe('真实工具写入的测试结果');
    expect(runtime.interrupts(1, 'owner')).toEqual([]);
    expect(JSON.stringify(runtime.inspect(1, 'owner').control.context)).not.toContain('私有推理内容');
    await runtime.close();
    runtime = createAgentRuntime(options);
    await runtime.initialize();
    expect(runtime.inspect(1, 'owner').control.state).toBe('SLEEPING');
    expect(runtime.inspect(1, 'owner').control.context.level1.memory.summary).not.toBeNull();
    expect(ordinary).toBe(3);
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});
