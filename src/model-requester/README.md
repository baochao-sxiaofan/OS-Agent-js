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
  API code and retry delay. One call sends at most one HTTP request; the caller
  decides whether to retry. Cancellation and timeout use the same error type.
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

Only MiniMax is implemented: non-streaming chat, native function calls,
reasoning continuation, M3 image/video input, a 50 MiB encoded request limit and
a default 180-second timeout. `anthropic`, `openai` and `gemini` are explicit
`not_implemented` stubs in this module. Existing legacy providers are unchanged.

No Agent IDs, ACB/TCB, Graph, permissions, prompt policy, scheduling, persistence
or tool execution enter this module. The existing `MiniMaxModelProvider` remains
an outer compatibility facade that builds Agent prompts and interprets actions.
Its history adapter reads old native snapshots and writes versioned canonical
messages to the existing snapshot field.

Run the standalone two-request tool example with credentials supplied through
the environment:

```sh
npm run demo:model-requester
```

`MINIMAX_API_KEY` is required; `MINIMAX_MODEL` defaults to `MiniMax-M3`.
