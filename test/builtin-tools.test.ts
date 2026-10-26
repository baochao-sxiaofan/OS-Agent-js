import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CURRENT_WORKSPACE_RESOURCE,
  directoryListTool,
  createTestRunTool,
  directoryCreateTool,
  directoryDeleteTool,
  fileApplyPatchTool,
  fileCreateTool,
  fileReadTool,
  fileWriteTool,
  registerBuiltinTools,
  ToolRegistry,
  workspaceSearchTool,
  type JsonObject,
  type ToolExecutionContext,
} from '../src/index.js';

function contextFor(workspaceRoot?: string): ToolExecutionContext {
  return {
    taskId: 'task-1',
    signal: new AbortController().signal,
    idempotencyKey: 'task-1:call-1',
    ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
  };
}

async function run(
  tool: typeof fileReadTool,
  input: JsonObject,
  workspaceRoot?: string,
) {
  const validation = tool.validateInput(input);
  if (!validation.valid) {
    throw new Error(validation.error);
  }
  return await tool.execute(input, contextFor(workspaceRoot));
}

describe('builtin workspace tools', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'os-agent-tools-'));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('declares resource-scoped capabilities from the input path', () => {
    const requirements = fileWriteTool.requiredCapabilities?.({
      path: `${CURRENT_WORKSPACE_RESOURCE}src/app.ts`,
      content: 'x',
    });
    expect(requirements).toEqual([
      {
        capability: 'file.write',
        scope: {
          kind: 'exact',
          resource: `${CURRENT_WORKSPACE_RESOURCE}src/app.ts`,
        },
      },
    ]);
  });

  it('writes and reads a file within the mount', async () => {
    mkdirSync(join(workspace, 'notes'));
    await run(
      fileCreateTool,
      {
        path: `${CURRENT_WORKSPACE_RESOURCE}notes/todo.txt`,
        content: 'first line',
      },
      workspace,
    );
    expect(readFileSync(join(workspace, 'notes/todo.txt'), 'utf8')).toBe(
      'first line',
    );
    const read = (await run(
      fileReadTool,
      { path: `${CURRENT_WORKSPACE_RESOURCE}notes/todo.txt` },
      workspace,
    )) as { content: string };
    expect(read.content).toBe('first line');
  });

  it('lists the same mounted root with or without its trailing slash', async () => {
    writeFileSync(join(workspace, 'outline.txt'), 'outline', 'utf8');
    const bare = await run(directoryListTool, { path: 'workspace://current' }, workspace);
    const slash = await run(directoryListTool, { path: 'workspace://current/' }, workspace);
    for (const result of [bare, slash]) expect(result).toMatchObject({ entries: [{ name: 'outline.txt', kind: 'file' }] });
    expect(directoryListTool.validateInput({ path: 'workspace://current-elsewhere' }).valid).toBe(false);
  });

  it('区分UTF-8字节、UTF-16字符和汉字数量，覆盖中文与表情', async () => {
    const path = `${CURRENT_WORKSPACE_RESOURCE}counts.txt`;
    const created = await run(fileCreateTool, { path, content: '小白A🐰\n' }, workspace);
    expect(created).toMatchObject({ bytesWritten: 12, charactersWritten: 6, chineseCharactersWritten: 2 });
    expect(readFileSync(join(workspace, 'counts.txt')).byteLength).toBe(12);
    const overwritten = await run(fileWriteTool, { path, content: '编辑小黑\n' }, workspace);
    expect(overwritten).toMatchObject({ bytesWritten: 13, charactersWritten: 5, chineseCharactersWritten: 4 });
    const read = await run(fileReadTool, { path }, workspace);
    expect(read).toMatchObject({ content: '编辑小黑\n', truncated: false, characters: 5, chineseCharacters: 4 });
    expect(readFileSync(join(workspace, 'counts.txt')).byteLength).toBe(13);
    const patched = await run(fileApplyPatchTool, { path, find: '小黑', replace: '小白🐰' }, workspace);
    expect(patched).toMatchObject({ bytesWritten: 17, charactersWritten: 7, chineseCharactersWritten: 4 });
    expect(readFileSync(join(workspace, 'counts.txt'), 'utf8')).toBe('编辑小白🐰\n');
    expect(readFileSync(join(workspace, 'counts.txt')).byteLength).toBe(17);
  });

  it('separates create from overwrite capabilities', async () => {
    writeFileSync(join(workspace, 'existing.txt'), 'old', 'utf8');
    await run(
      fileWriteTool,
      {
        path: `${CURRENT_WORKSPACE_RESOURCE}existing.txt`,
        content: 'new',
      },
      workspace,
    );
    expect(readFileSync(join(workspace, 'existing.txt'), 'utf8')).toBe(
      'new',
    );
    await expect(
      run(
        fileCreateTool,
        {
          path: `${CURRENT_WORKSPACE_RESOURCE}existing.txt`,
          content: 'replace',
        },
        workspace,
      ),
    ).rejects.toMatchObject({ code: 'EEXIST' });
  });

  it('rejects writing through a symlink that escapes the mount', async () => {
    const outside = `${workspace}-outside.txt`;
    writeFileSync(outside, 'protected', 'utf8');
    symlinkSync(outside, join(workspace, 'escape.txt'));

    await expect(
      run(
        fileWriteTool,
        {
          path: `${CURRENT_WORKSPACE_RESOURCE}escape.txt`,
          content: 'overwritten',
        },
        workspace,
      ),
    ).rejects.toThrow('escapes the workspace');
    expect(readFileSync(outside, 'utf8')).toBe('protected');
    rmSync(outside, { force: true });
  });

  it('applies a unique find/replace patch', async () => {
    writeFileSync(join(workspace, 'code.ts'), 'const a = 1;\n', 'utf8');
    await run(
      fileApplyPatchTool,
      {
        path: `${CURRENT_WORKSPACE_RESOURCE}code.ts`,
        find: 'const a = 1;',
        replace: 'const a = 2;',
      },
      workspace,
    );
    expect(readFileSync(join(workspace, 'code.ts'), 'utf8')).toBe(
      'const a = 2;\n',
    );
  });

  it('rejects a patch whose find text is not unique', async () => {
    writeFileSync(join(workspace, 'dup.ts'), 'x\nx\n', 'utf8');
    await expect(
      run(
        fileApplyPatchTool,
        {
          path: `${CURRENT_WORKSPACE_RESOURCE}dup.ts`,
          find: 'x',
          replace: 'y',
        },
        workspace,
      ),
    ).rejects.toThrow('more than once');
  });

  it('lists directory entries and searches file contents', async () => {
    writeFileSync(join(workspace, 'a.txt'), 'alpha needle', 'utf8');
    writeFileSync(join(workspace, 'b.txt'), 'beta', 'utf8');
    const listing = (await run(
      directoryListTool,
      { path: CURRENT_WORKSPACE_RESOURCE },
      workspace,
    )) as { entries: Array<{ name: string }> };
    expect(listing.entries.map((entry) => entry.name).sort()).toEqual([
      'a.txt',
      'b.txt',
    ]);
    const search = (await run(
      workspaceSearchTool,
      { query: 'needle' },
      workspace,
    )) as { matches: Array<{ path: string; line: number }> };
    expect(search.matches).toHaveLength(1);
    expect(search.matches[0]?.path).toBe(
      `${CURRENT_WORKSPACE_RESOURCE}a.txt`,
    );
  });

  it('搜索可指定单文件，只返回该文件的命中并保持工作区边界', async () => {
    const path = `${CURRENT_WORKSPACE_RESOURCE}方案.md`;
    writeFileSync(join(workspace, '方案.md'), '第一行\n赛程需要校对\n其他内容\n赛程修订完成', 'utf8');
    writeFileSync(join(workspace, '其他.md'), '赛程不应被读取', 'utf8');
    const result = await run(workspaceSearchTool, { query: '赛程', path }, workspace);
    expect(result).toEqual({ query: '赛程', truncated: false, matches: [
      { path, line: 2, text: '赛程需要校对' },
      { path, line: 4, text: '赛程修订完成' },
    ] });
    const outside = `${workspace}-outside.md`;
    writeFileSync(outside, '赛程机密', 'utf8');
    symlinkSync(outside, join(workspace, '越界.md'));
    try {
      await expect(run(workspaceSearchTool, { query: '赛程', path: `${CURRENT_WORKSPACE_RESOURCE}越界.md` }, workspace))
        .rejects.toThrow('escapes the workspace');
    } finally { rmSync(outside, { force: true }); }
  });

  it('creates and deletes directories through explicit tools', async () => {
    await run(
      directoryCreateTool,
      { path: `${CURRENT_WORKSPACE_RESOURCE}generated` },
      workspace,
    );
    const listing = (await run(
      directoryListTool,
      { path: CURRENT_WORKSPACE_RESOURCE },
      workspace,
    )) as { entries: Array<{ name: string }> };
    expect(listing.entries).toContainEqual({
      name: 'generated',
      kind: 'directory',
    });
    await run(
      directoryDeleteTool,
      { path: `${CURRENT_WORKSPACE_RESOURCE}generated` },
      workspace,
    );
    expect(
      (await run(
        directoryListTool,
        { path: CURRENT_WORKSPACE_RESOURCE },
        workspace,
      )) as { entries: Array<{ name: string }> },
    ).toMatchObject({ entries: [] });
  });

  it('refuses to run without a mounted workspace', async () => {
    await expect(
      run(fileReadTool, { path: `${CURRENT_WORKSPACE_RESOURCE}a.txt` }),
    ).rejects.toThrow('requires a mounted workspace');
  });

  it('only allows whitelisted test commands', () => {
    const testRunTool = createTestRunTool({
      run: async () => ({ exitCode: 0 }),
    });
    expect(
      testRunTool.validateInput({ command: 'rm', args: ['-rf', '/'] }).valid,
    ).toBe(false);
    expect(testRunTool.validateInput({ command: 'npm', args: ['test'] }).valid).toBe(
      true,
    );
  });

  it('does not register test.run without an OS-level sandbox', () => {
    const withoutSandbox = new ToolRegistry();
    registerBuiltinTools(withoutSandbox);
    expect(
      withoutSandbox.descriptors().map((tool) => tool.name),
    ).not.toContain('test.run');

    const withSandbox = new ToolRegistry();
    registerBuiltinTools(withSandbox, {
      processSandbox: {
        run: async () => ({ exitCode: 0 }),
      },
    });
    expect(withSandbox.descriptors().map((tool) => tool.name)).toContain(
      'test.run',
    );
  });

  it('delegates test execution to an injected process sandbox', async () => {
    const requests: Array<{
      command: string;
      cwd: string;
    }> = [];
    const testRunTool = createTestRunTool({
      run: async (request) => {
        requests.push({
          command: request.command,
          cwd: request.cwd,
        });
        return { exitCode: 0 };
      },
    });

    await run(
      testRunTool,
      { command: 'npm', args: ['test'] },
      workspace,
    );

    expect(requests).toEqual([
      {
        command: 'npm',
        cwd: realpathSync(workspace),
      },
    ]);
  });
});
