import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CURRENT_WORKSPACE_RESOURCE,
  WorkspaceEscapeError,
  WorkspaceResolver,
} from '../src/index.js';

describe('WorkspaceResolver', () => {
  let directory: string;
  let workspace: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'os-agent-fs-'));
    workspace = join(directory, 'workspace');
    mkdirSync(workspace);
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('maps alias paths to host paths inside the mount', async () => {
    const resolver = await WorkspaceResolver.create(workspace);
    const hostPath = resolver.toHostPath(
      `${CURRENT_WORKSPACE_RESOURCE}src/index.ts`,
    );
    expect(hostPath.startsWith(resolver.root)).toBe(true);
    expect(hostPath.endsWith('/src/index.ts')).toBe(true);
    expect(resolver.toAliasPath(hostPath)).toBe(
      `${CURRENT_WORKSPACE_RESOURCE}src/index.ts`,
    );
  });

  it('rejects parent-directory traversal in the alias', async () => {
    const resolver = await WorkspaceResolver.create(workspace);
    expect(() =>
      resolver.toHostPath(`${CURRENT_WORKSPACE_RESOURCE}../secret.txt`),
    ).toThrow(WorkspaceEscapeError);
  });

  it('rejects aliases outside the workspace scheme', async () => {
    const resolver = await WorkspaceResolver.create(workspace);
    expect(() => resolver.toHostPath('file:///etc/passwd')).toThrow(
      WorkspaceEscapeError,
    );
  });

  it('rejects symlinks whose target escapes the mount', async () => {
    const outside = join(directory, 'outside.txt');
    writeFileSync(outside, 'secret', 'utf8');
    symlinkSync(outside, join(workspace, 'link.txt'));
    const resolver = await WorkspaceResolver.create(workspace);
    const hostPath = resolver.toHostPath(
      `${CURRENT_WORKSPACE_RESOURCE}link.txt`,
    );
    // 字符串层通过，但符号链接解析后越界必须被拦截。
    await expect(
      resolver.assertResolvedInsideRoot(hostPath),
    ).rejects.toBeInstanceOf(WorkspaceEscapeError);
  });
});
