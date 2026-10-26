# Model requester

Public entry: `os-agent-js/model-requester` (after `npm run build`).
Inside this repository, import `src/model-requester/index.ts`.

```ts
import { createModelRequester, type ModelMessage } from 'os-agent-js/model-requester';

const requester = createModelRequester({
  provider: 'minimax',
  model: 'MiniMax-M3',
  apiKey: process.env['MINIMAX_API_KEY']!,
});
const messages: ModelMessage[] = [
  { role: 'system', content: 'Answer briefly.' },
  { role: 'user', content: 'Hello.' },
];
const result = await requester.request({ messages }, AbortSignal.timeout(30_000));
console.log(result.message.content, result.finishReason, result.usage);
```

`api.ts` defines the public contracts. `internal/` owns vendor serialization,
deserialization and HTTP transport; implementations are not package exports.

- `ModelMessage`: system/user/assistant/tool messages. User messages support text,
  image URLs and video URLs (including data URLs). Assistant messages contain
  text and parsed JSON tool calls; tool results refer to their exact call IDs.
- `ModelCompletion`: one assistant message, normalized finish reason, token
  usage, provider/model and optional response ID. Unknown or absent finish
  reasons become `unknown`. Missing usage counters become zero.
- `ModelRequesterError`: stable error code, retryability, optional HTTP status,
  API code, retry delay and a safe typed protocol reason. One call sends at most
  one HTTP request; the caller decides whether to retry. Cancellation and timeout
  use the same error type.
- `continuation`: opaque JSON data bound to a provider and model. Persist it
  unchanged with its assistant message. Passing it to another provider/model
  fails explicitly. It may contain private model reasoning; do not display it
  as ordinary assistant text.

For a tool round trip, append `result.message` to the next request, execute and
validate the tool outside this module, then append
`{ role: 'tool', callId: call.id, content: result }`. Tool arguments must be JSON
objects. Malformed/truncated tool arguments fail with `invalid_response`; text
truncation returns `finishReason: 'length'`. Callers must inspect the finish
reason before acting on output.

MiniMax and DeepSeek are implemented: non-streaming chat, native function calls,
reasoning continuation, a 50 MiB encoded request limit and a default 180-second
timeout. MiniMax also supports M3 image/video input; the DeepSeek adapter currently
accepts text only. `anthropic`, `openai` and `gemini` are explicit
`not_implemented` stubs in this module. Existing legacy providers are unchanged.

DeepSeek uses its own codec and transport. It maps restricted function names
(for example `file.read`) to stable API-compatible aliases and restores original
names before returning tool calls. It sends `max_tokens`, defaults to
`thinking: 'enabled'` and `reasoningEffort: 'high'`, and supports `disabled` thinking
or `max` effort. Opaque `reasoning_content` is replayed on tool continuations.
Raw network/provider error bodies are not exposed to the caller.

The live thinking API rejects `tool_choice: 'required'` and named choices.
For `required`, the adapter sends `auto` while preserving thinking. Named choices
(such as a summary submission) retain the declared tool catalog and use non-thinking mode
with the native forced choice, preserving the fixed output contract.
The adapter verifies the original required/named contract before returning the
completion. Missing or wrong tool calls raise retryable `invalid_response`; the
adapter itself never retries or executes tools. Explicit non-thinking mode
retains native tool-choice parameters.

Discover model IDs before choosing one:

```ts
import { listAvailableModels, createModelRequester } from 'os-agent-js/model-requester';

const apiKey = process.env['DEEPSEEK_API_KEY']!;
const catalog = await listAvailableModels({ provider: 'deepseek', apiKey });
const selected = catalog.models[0];
if (!selected) throw new Error('No models available.');
const deepseek = createModelRequester({ provider: 'deepseek', apiKey, model: selected.id });
```

DeepSeek discovery reads the official `/models` endpoint (15-second timeout).
`source: 'api'` identifies the live list. MiniMax discovery returns an explicitly
labelled `source: 'builtin'` catalog and performs no authentication/network call;
account and plan availability can differ. Discovery does not run inference.

No Agent IDs, ACB/TCB, Graph, permissions, prompt policy, scheduling, persistence
or tool execution enter this module. Existing legacy model providers remain
unchanged and do not call this requester.

The new `agent-runtime` builds prompts and interprets actions outside this
transport boundary. Work actions, context summaries and conversation digests
require native function calls; new text-only JSON actions are rejected.
Compatibility conversion is limited to already persisted legacy completions.
Retryable protocol failures rebuild requests with safe correction feedback.

Runtime retains a bounded native journal of complete assistant/tool exchanges,
including original call IDs and opaque continuation data. Replay is scoped to
the Agent, conversation, work batch, context frame/revision and provider/model.
Only committed context rounds with real completed or failed results are replayed;
pending results are never fabricated. The journal stays outside semantic Context,
conversation memory and user-visible messages.

Run the standalone two-request tool example with credentials supplied through
the environment:

```sh
npm run demo:model-requester
```

`MINIMAX_API_KEY` is required; `MINIMAX_MODEL` defaults to `MiniMax-M3`.
