import type { ToolDescriptor } from '../model/model-provider.js';
import type { Tool } from './tool.js';

export class DuplicateToolError extends Error {
  constructor(toolName: string) {
    super(`Tool is already registered: ${toolName}`);
    this.name = 'DuplicateToolError';
  }
}

export class ToolNotFoundError extends Error {
  constructor(toolName: string) {
    super(`Tool is not registered: ${toolName}`);
    this.name = 'ToolNotFoundError';
  }
}

export class ToolRegistry {
  readonly #tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.#tools.has(tool.name)) {
      throw new DuplicateToolError(tool.name);
    }
    if (
      tool.requiredCapability === undefined &&
      tool.requiredCapabilities === undefined
    ) {
      throw new Error(
        `Tool must declare its required capabilities: ${tool.name}`,
      );
    }
    this.#tools.set(tool.name, tool);
  }

  get(toolName: string): Tool {
    const tool = this.#tools.get(toolName);
    if (!tool) {
      throw new ToolNotFoundError(toolName);
    }
    return tool;
  }

  /**
   * 返回当前运行时注册的全局工具。
   *
   * 工具可见性不由 capability 决定；CharacterRegistry 在全局目录上筛选
   * 角色工具集合。CapabilityManager 只负责某一次具体调用能否执行。
   */
  descriptors(): ToolDescriptor[] {
    return [...this.#tools.values()]
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        ...(tool.inputSchema === undefined
          ? {}
          : { inputSchema: structuredClone(tool.inputSchema) }),
      }));
  }

  /** @deprecated Use descriptors(); capability is not a visibility filter. */
  descriptorsFor(_capabilities: readonly string[]): ToolDescriptor[] {
    return this.descriptors();
  }
}
