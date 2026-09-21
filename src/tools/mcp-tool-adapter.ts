import type { CapabilityInput } from '../capability/capability.js';
import type { JsonObject, JsonValue } from '../types/json.js';
import type {
  Tool,
  ToolEffect,
  ToolExecutionContext,
  ToolInputValidation,
} from './tool.js';

/**
 * 由 MCP 传输适配器实现的最小客户端接口。
 *
 * 核心运行时不依赖特定 MCP SDK 或传输方式。
 * stdio 和 Streamable HTTP 客户端均可实现此接口。
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
  /** 暴露给模型的稳定 OS-Agent 工具名称。 */
  name: string;
  description: string;
  inputSchema: JsonObject;
  effect: ToolEffect;
  serverId: string;
  remoteToolName: string;
  /**
   * 可信宿主策略，将 MCP 调用映射到 OS-Agent 能力。
   *
   * 此映射不能来自不可信的 MCP 服务端本身。
   */
  requiredCapabilities(
    input: JsonObject,
  ): readonly CapabilityInput[];
  validateInput?: (input: JsonObject) => ToolInputValidation;
};

/**
 * 将现有 MCP 工具封装为本地 Tool 协议。
 *
 * 能力检查仍由 TaskScheduler 在 `execute` 前执行；
 * MCP 只负责调用传输，不能作为授权来源。
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
