/** 独立请求器示例，不依赖调度器、ACB、工作图或工具运行时。 */
import {
  createModelRequester,
  type ModelMessage,
} from '../src/model-requester/index.js';

const apiKey = process.env['MINIMAX_API_KEY']?.trim();
if (!apiKey) throw new Error('Set MINIMAX_API_KEY in the environment.');
const requester = createModelRequester({
  provider: 'minimax',
  model: process.env['MINIMAX_MODEL'] ?? 'MiniMax-M3',
  apiKey,
});
const messages: ModelMessage[] = [
  { role: 'system', content: 'Use the add tool to calculate the result, then reply briefly.' },
  { role: 'user', content: 'What is 21 + 21?' },
];
const first = await requester.request({
  messages,
  maxOutputTokens: 4096,
  tools: [{
    name: 'add',
    description: 'Add two numbers.',
    parameters: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
      additionalProperties: false,
    },
  }],
  toolChoice: 'required',
});
if (first.finishReason !== 'tool_calls' || first.message.toolCalls.length !== 1) {
  throw new Error(`Expected one tool call, received ${first.finishReason}.`);
}
messages.push(first.message);
for (const call of first.message.toolCalls) {
  const { a, b } = call.arguments;
  if (call.name !== 'add' || typeof a !== 'number' || typeof b !== 'number') {
    throw new Error('Unexpected tool call.');
  }
  // 调用方负责执行工具，请求器只传输工具消息。
  messages.push({ role: 'tool', callId: call.id, content: { sum: a + b } });
}
const final = await requester.request({ messages, maxOutputTokens: 4096 });
if (final.finishReason !== 'stop') throw new Error(`Unexpected finish reason: ${final.finishReason}.`);
console.log(JSON.stringify({
  content: final.message.content,
  finishReason: final.finishReason,
  usage: final.usage,
}, null, 2));
