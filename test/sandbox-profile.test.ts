import { describe, expect, it } from 'vitest';

import {
  buildSandboxEnvironment,
  buildSeatbeltProfile,
  defaultDeniedReadPaths,
} from '../desktop/main/sandbox/index.js';

describe('seatbelt profile', () => {
  it('denies by default and only opens writes to the given subpaths', () => {
    const profile = buildSeatbeltProfile({
      workspaceRoot: '/tmp/workspace',
      writablePaths: ['/tmp/run'],
      denyReadPaths: [],
    });
    expect(profile).toContain('(deny default)');
    expect(profile).toContain('(allow file-read*)');
    expect(profile).toContain(
      '(allow file-write* (subpath "/tmp/workspace"))',
    );
    expect(profile).toContain('(allow file-write* (subpath "/tmp/run"))');
  });

  it('appends sensitive read denials after the broad read allowance', () => {
    const profile = buildSeatbeltProfile({
      workspaceRoot: '/tmp/workspace',
      writablePaths: [],
      denyReadPaths: ['/Users/x/.ssh'],
    });
    const allowIndex = profile.indexOf('(allow file-read*)');
    const denyIndex = profile.indexOf(
      '(deny file-read* (subpath "/Users/x/.ssh"))',
    );
    expect(allowIndex).toBeGreaterThanOrEqual(0);
    // 后匹配优先：拒绝规则必须排在广开读取之后才能生效。
    expect(denyIndex).toBeGreaterThan(allowIndex);
  });

  it('escapes quotes and backslashes to prevent policy injection', () => {
    const profile = buildSeatbeltProfile({
      workspaceRoot: '/tmp/we"ird\\path',
      writablePaths: [],
      denyReadPaths: [],
    });
    expect(profile).toContain(
      '(allow file-write* (subpath "/tmp/we\\"ird\\\\path"))',
    );
  });

  it('rejects relative paths', () => {
    expect(() =>
      buildSeatbeltProfile({
        workspaceRoot: 'relative/workspace',
        writablePaths: [],
        denyReadPaths: [],
      }),
    ).toThrow('absolute path');
  });

  it('lists common credential locations under the home directory', () => {
    const denied = defaultDeniedReadPaths('/Users/dev');
    expect(denied).toContain('/Users/dev/.ssh');
    expect(denied).toContain('/Users/dev/.aws');
    expect(denied).toContain('/Users/dev/Library/Keychains');
  });
});

describe('sandbox environment', () => {
  it('redirects HOME, TMPDIR, and npm cache into the isolated runtime dir', () => {
    const env = buildSandboxEnvironment({
      workspaceRoot: '/tmp/workspace',
      runtimeDir: '/tmp/run',
      hostPath: '/opt/homebrew/bin:/usr/bin',
    });
    expect(env['HOME']).toBe('/tmp/run');
    expect(env['TMPDIR']).toBe('/tmp/run');
    expect(env['npm_config_cache']).toBe('/tmp/run/npm-cache');
    expect(env['PATH']).toBe('/opt/homebrew/bin:/usr/bin');
    expect(env['PWD']).toBe('/tmp/workspace');
  });

  it('never leaks host secrets from process.env', () => {
    const env = buildSandboxEnvironment({
      workspaceRoot: '/tmp/workspace',
      runtimeDir: '/tmp/run',
    });
    // 只保留白名单变量：不携带任意宿主凭据或代理配置。
    expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(env).not.toHaveProperty('GEMINI_API_KEY');
    expect(env).not.toHaveProperty('HTTP_PROXY');
    expect(env['PATH']).toBe('/usr/bin:/bin:/usr/sbin:/sbin');
  });
});
