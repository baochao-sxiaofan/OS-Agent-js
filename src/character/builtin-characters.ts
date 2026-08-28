import type { CharacterDefinition } from './character.js';

/**
 * 首批内置 Character 使用的基础工具标识。
 *
 * 与 `src/tools/builtin` 中注册的工具名称保持一致；工具可见性由这里的角色
 * 定义决定，能否执行仍由 CapabilityManager 校验。
 */
export const BUILTIN_TOOL_IDS = {
  fileRead: 'file.read',
  fileWrite: 'file.write',
  fileCreate: 'file.create',
  fileDelete: 'file.delete',
  fileApplyPatch: 'file.apply_patch',
  directoryList: 'directory.list',
  directoryCreate: 'directory.create',
  directoryDelete: 'directory.delete',
  workspaceSearch: 'workspace.search',
  webFetch: 'web.fetch',
  testRun: 'test.run',
} as const;

/** 根协调角色：自主拆解任务并在已授权范围内创建专业子 Agent。 */
export const COORDINATOR_CHARACTER: CharacterDefinition = {
  id: 'coordinator',
  displayName: '任务协调员',
  promptFragment: [
    'You are the root coordinator for this conversation.',
    'In plan mode, assess the goal and generate a dependency-aware work graph before acting.',
    'Choose self assignments, delegated Character assignments, or a mixture according to the actual work.',
    'Delegate bounded objectives rather than forwarding the complete parent goal to one child.',
    'Give each child only the minimum capability scope required for its assignment.',
    'Use integration and verification nodes when independent results must become one deliverable.',
    'After graph execution returns to plan, inspect the evidence and remain accountable for the final answer.',
  ].join(' '),
  visibleToolIds: Object.values(BUILTIN_TOOL_IDS),
  capabilityCeiling: ['*'],
  requestableCapabilities: ['*'],
  allowedChildCharacters: [
    'coordinator',
    'developer',
    'code_auditor',
    'researcher',
  ],
};

/**
 * 开发角色：在分配到的目录范围内读写代码并运行测试。
 */
export const DEVELOPER_CHARACTER: CharacterDefinition = {
  id: 'developer',
  displayName: '开发工程师',
  promptFragment: [
    'You are a software developer working inside the mounted workspace.',
    'Read the relevant existing code before changing anything.',
    'Only create, edit, or delete files inside the directories you were granted.',
    'Run tests to validate your changes when a test capability is available.',
    'Never attempt to reach files or resources outside the workspace mount.',
  ].join(' '),
  visibleToolIds: [
    BUILTIN_TOOL_IDS.fileRead,
    BUILTIN_TOOL_IDS.fileWrite,
    BUILTIN_TOOL_IDS.fileCreate,
    BUILTIN_TOOL_IDS.fileDelete,
    BUILTIN_TOOL_IDS.fileApplyPatch,
    BUILTIN_TOOL_IDS.directoryList,
    BUILTIN_TOOL_IDS.directoryCreate,
    BUILTIN_TOOL_IDS.directoryDelete,
    BUILTIN_TOOL_IDS.workspaceSearch,
    BUILTIN_TOOL_IDS.testRun,
  ],
  capabilityCeiling: [
    'file.read',
    'file.write',
    'file.create',
    'file.delete',
    'directory.read',
    'directory.create',
    'directory.delete',
    'test.run',
  ],
  requestableCapabilities: [
    'file.read',
    'file.write',
    'file.create',
    'file.delete',
    'directory.read',
    'directory.create',
    'directory.delete',
    'test.run',
  ],
  allowedChildCharacters: [],
};

/**
 * 代码审计角色：全工作区只读，负责发现问题并上报，不允许修改文件。
 */
export const CODE_AUDITOR_CHARACTER: CharacterDefinition = {
  id: 'code_auditor',
  displayName: '代码审计员',
  promptFragment: [
    'You are a code auditor with read-only access to the workspace.',
    'Inspect code across the whole workspace to find conflicts, bugs, and risks.',
    'You cannot modify any file; report findings back to the parent Agent instead.',
    'Be specific: cite files and line ranges so the parent can act on your report.',
  ].join(' '),
  visibleToolIds: [
    BUILTIN_TOOL_IDS.fileRead,
    BUILTIN_TOOL_IDS.directoryList,
    BUILTIN_TOOL_IDS.workspaceSearch,
  ],
  capabilityCeiling: ['file.read', 'directory.read'],
  requestableCapabilities: ['file.read', 'directory.read'],
  allowedChildCharacters: [],
};

/**
 * 研究角色：联网检索资料，并把整理结果写入指定的资料目录。
 */
export const RESEARCHER_CHARACTER: CharacterDefinition = {
  id: 'researcher',
  displayName: '研究员',
  promptFragment: [
    'You are a researcher who gathers information and organizes findings.',
    'Inspect workspace sources and use a network tool only when one is visible and authorized.',
    'Write summaries only into the notes directory you were granted.',
    'Do not modify source code; hand structured findings to the parent Agent.',
  ].join(' '),
  visibleToolIds: [
    BUILTIN_TOOL_IDS.fileRead,
    BUILTIN_TOOL_IDS.fileWrite,
    BUILTIN_TOOL_IDS.fileCreate,
    BUILTIN_TOOL_IDS.directoryList,
    BUILTIN_TOOL_IDS.directoryCreate,
    BUILTIN_TOOL_IDS.workspaceSearch,
    BUILTIN_TOOL_IDS.webFetch,
  ],
  capabilityCeiling: [
    'file.read',
    'file.write',
    'file.create',
    'directory.read',
    'directory.create',
    'network.http.read',
  ],
  requestableCapabilities: [
    'file.read',
    'file.write',
    'file.create',
    'directory.read',
    'directory.create',
    'network.http.read',
  ],
  allowedChildCharacters: [],
};

/** 首批内置 Character，供默认 CharacterRegistry 装载。 */
export const BUILTIN_CHARACTERS: readonly CharacterDefinition[] = [
  COORDINATOR_CHARACTER,
  DEVELOPER_CHARACTER,
  CODE_AUDITOR_CHARACTER,
  RESEARCHER_CHARACTER,
];
