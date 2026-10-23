import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAgentRuntime } from '../../src/agent-runtime/index.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { CharacterRegistry } from '../../src/character/character-registry.js';
import { nativeMessage } from './native-message.js';

const path = process.argv[2]!;
const tools = new ToolRegistry();
tools.register({
  name: 'test.write', description: '崩溃恢复探针', effect: 'side_effect', requiredCapability: 'test.write',
  validateInput: () => ({ valid: true }), async execute(_input, context) {
    await appendFile(join(path, 'effects.txt'), `${context.idempotencyKey}\n`);
    process.stdout.write('EFFECT_WRITTEN\n');
    return new Promise(() => {});
  },
});
const characters = new CharacterRegistry([{
  id: 'test', displayName: '测试', promptFragment: '测试',
  visibleToolIds: ['test.write'], capabilityCeiling: ['test.write'],
  requestableCapabilities: ['test.write'], allowedChildCharacters: [],
}]);
const runtime = createAgentRuntime({
  database: join(path, 'runtime.sqlite'), workspaces: { work: path }, tools, characters,
  requester: { provider: 'minimax', model: 'test', async request() {
    return { provider: 'minimax', model: 'test', finishReason: 'stop',
      message: nativeMessage({
        kind: 'tools', calls: [{ name: 'test.write', arguments: {} }],
      }), usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  } },
});
await runtime.initialize();
await runtime.createAgent({
  ownerId: 'owner', workspaceId: 'work', character: 'test', objective: '测试崩溃',
  capabilities: [{ capability: 'test.write', scope: { kind: 'all' } }],
});
runtime.start();
