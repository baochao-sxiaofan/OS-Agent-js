import type { CapabilityInput } from '../capability/capability.js';
import type { JsonObject, JsonValue } from '../types/json.js';
import type {
  Tool,
  ToolEffect,
  ToolExecutionContext,
  ToolInputValidation,
} from './tool.js';

/**
 * Minimal client port implemented by an MCP transport adapter.
 *
 * The core runtime intentionally does not depend on a specific MCP SDK or
 * transport. A stdio or Streamable HTTP client can implement this interface.
 */
export interface McpClientPort {
  callTool(request: {
    serverId: string;
    toolName: string;
    arguments: JsonObject;
    signal: AbortSignal;
    idempotencyKey: string;
    workspaceRoot?: string;
  }): Promise<JsonValue>;
}

export type McpToolBinding = {
  /** Stable OS-Agent tool name exposed to the model. */
  name: string;
  description: string;
  inputSchema: JsonObject;
  effect: ToolEffect;
  serverId: string;
  remoteToolName: string;
  /**
   * Trusted host policy mapping an MCP call to OS-Agent capabilities.
   *
   * This mapping cannot come from the untrusted MCP server itself.
   */
  requiredCapabilities(
    input: JsonObject,
  ): readonly CapabilityInput[];
  validateInput?: (input: JsonObject) => ToolInputValidation;
};

/**
 * Wraps an existing MCP tool in the local Tool contract.
 *
 * Capability checks still happen in TaskScheduler before `execute`; MCP is an
 * implementation transport, never an authorization source.
 */
export function createMcpToolAdapter(
  client: McpClientPort,
  binding: McpToolBinding,
): Tool {
  return {
    name: binding.name,
    description: binding.description,
    inputSchema: structuredClone(binding.inputSchema),
    effect: binding.effect,
    validateInput: binding.validateInput ?? (() => ({ valid: true })),
    requiredCapabilities: binding.requiredCapabilities,
    async execute(input, context: ToolExecutionContext): Promise<JsonValue> {
      return await client.callTool({
        serverId: binding.serverId,
        toolName: binding.remoteToolName,
        arguments: structuredClone(input),
        signal: context.signal,
        idempotencyKey: context.idempotencyKey,
        ...(context.workspaceRoot === undefined
          ? {}
          : { workspaceRoot: context.workspaceRoot }),
      });
    },
  };
}
