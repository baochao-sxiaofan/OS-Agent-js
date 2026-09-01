import type { ArtifactStore } from '../../artifacts/artifact-store.js';
import type { KnowledgeStore } from '../../knowledge/knowledge-store.js';
import type { ToolRegistry } from '../tool-registry.js';
import { createArtifactTools } from './artifact-tools.js';
import { createGitTools } from './git-tools.js';
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
import { createKnowledgeTools } from './knowledge-tools.js';
import {
  createScreenCaptureTool,
  type CapturedScreen,
  type ScreenCapturePort,
} from './screen-capture-tool.js';
import {
  createWebTools,
  type WebAccessPort,
  type WebFetchResult,
  type WebSearchResult,
} from './web-tools.js';
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
  artifactStore?: ArtifactStore;
  knowledgeStore?: KnowledgeStore;
  processSandbox?: ProcessSandbox;
  screenCapture?: ScreenCapturePort;
  webAccess?: WebAccessPort;
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
  if (options.artifactStore) {
    for (const tool of createArtifactTools(options.artifactStore)) {
      registry.register(tool);
    }
  }
  if (options.knowledgeStore) {
    for (const tool of createKnowledgeTools(options.knowledgeStore)) {
      registry.register(tool);
    }
  }
  if (options.webAccess) {
    for (const tool of createWebTools(options.webAccess)) {
      registry.register(tool);
    }
  }
  if (options.screenCapture) {
    registry.register(createScreenCaptureTool(options.screenCapture));
  }
  if (options.processSandbox) {
    registry.register(createTestRunTool(options.processSandbox));
    for (const tool of createGitTools(options.processSandbox)) {
      registry.register(tool);
    }
  }
}

export {
  createArtifactTools,
  createKnowledgeTools,
  createGitTools,
  createScreenCaptureTool,
  createWebTools,
  type CapturedScreen,
  type ScreenCapturePort,
  type WebAccessPort,
  type WebFetchResult,
  type WebSearchResult,
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
