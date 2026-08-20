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
    this.#tools.set(tool.name, tool);
  }

  get(toolName: string): Tool {
    const tool = this.#tools.get(toolName);
    if (!tool) {
      throw new ToolNotFoundError(toolName);
    }
    return tool;
  }

  descriptorsFor(capabilities: readonly string[]): ToolDescriptor[] {
    const capabilitySet = new Set(capabilities);
    return [...this.#tools.values()]
      .filter((tool) => capabilitySet.has(tool.requiredCapability))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
      }));
  }
}
