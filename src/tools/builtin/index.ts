import type { ToolRegistry } from '../tool-registry.js';
import {
  directoryCreateTool,
  directoryDeleteTool,
  directoryListTool,
  fileCreateTool,
  fileDeleteTool,
  fileReadTool,
  fileWriteTool,
} from './file-tools.js';
import { fileApplyPatchTool } from './apply-patch-tool.js';
import { workspaceSearchTool } from './search-tool.js';
import {
  createTestRunTool,
  type ProcessSandbox,
  type SandboxedProcessRequest,
} from './test-run-tool.js';

/** 首批内置工作区 Skills，全部作用于 `workspace://current/` 挂载点。 */
export const BUILTIN_TOOLS = [
  fileReadTool,
  fileWriteTool,
  fileCreateTool,
  fileDeleteTool,
  fileApplyPatchTool,
  directoryListTool,
  directoryCreateTool,
  directoryDeleteTool,
  workspaceSearchTool,
] as const;

export type RegisterBuiltinToolsOptions = {
  processSandbox?: ProcessSandbox;
};

/**
 * 把首批内置工作区 Skills 注册到给定 ToolRegistry。
 *
 * `test.run` 只有在宿主显式注入 OS-level ProcessSandbox 时才注册；禁止退化为
 * 不受约束的 host spawn。
 */
export function registerBuiltinTools(
  registry: ToolRegistry,
  options: RegisterBuiltinToolsOptions = {},
): void {
  for (const tool of BUILTIN_TOOLS) {
    registry.register(tool);
  }
  if (options.processSandbox) {
    registry.register(createTestRunTool(options.processSandbox));
  }
}

export {
  directoryCreateTool,
  directoryDeleteTool,
  directoryListTool,
  fileApplyPatchTool,
  fileCreateTool,
  fileDeleteTool,
  fileReadTool,
  fileWriteTool,
  createTestRunTool,
  type ProcessSandbox,
  type SandboxedProcessRequest,
  workspaceSearchTool,
};
