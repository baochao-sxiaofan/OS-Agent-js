import { describe, expect, it } from 'vitest';

import {
  CapabilityManager,
  createWorkspaceCapabilityRequests,
  CURRENT_WORKSPACE_RESOURCE,
  extractInheritableRootAuthority,
  TaskControlBlock,
  WORKSPACE_FILESYSTEM_CAPABILITIES,
} from '../src/index.js';

function createManager() {
  let grantSequence = 0;
  let requestSequence = 0;
  return new CapabilityManager({
    grantIdGenerator: () => `grant-${++grantSequence}`,
    requestIdGenerator: () => `request-${++requestSequence}`,
  });
}

describe('CapabilityManager', () => {
  it('creates a workspace-scoped root ceiling and only inherits root grants', () => {
    const manager = createManager();
    const workspaceRequests = createWorkspaceCapabilityRequests();
    const rootGrants = manager.issueRootGrants(
      'root-round-1',
      workspaceRequests,
      10,
    );
    const humanGrant = manager.grantByHuman(
      'root-round-1',
      'approval-1',
      [
        {
          capability: 'git.push',
          scope: {
            kind: 'exact',
            resource: 'git://repo/origin/main',
          },
        },
      ],
      20,
    );

    expect(workspaceRequests.map((request) => request.capability)).toEqual(
      WORKSPACE_FILESYSTEM_CAPABILITIES,
    );
    expect(
      workspaceRequests.every(
        (request) =>
          request.scope.kind === 'subtree' &&
          request.scope.resource === CURRENT_WORKSPACE_RESOURCE,
      ),
    ).toBe(true);
    expect(
      manager.check(
        rootGrants,
        [
          {
            capability: 'file.write',
            scope: {
              kind: 'exact',
              resource: 'workspace://current/src/game.ts',
            },
          },
        ],
        30,
      ),
    ).toMatchObject({ allowed: true });
    expect(
      manager.check(
        rootGrants,
        [
          {
            capability: 'file.write',
            scope: {
              kind: 'exact',
              resource: 'workspace://other/src/game.ts',
            },
          },
        ],
        30,
      ),
    ).toMatchObject({ allowed: false });

    expect(
      extractInheritableRootAuthority(
        [...rootGrants, ...humanGrant],
        30,
      ),
    ).toEqual(workspaceRequests);
    expect(
      createWorkspaceCapabilityRequests({ includeTestRun: true }),
    ).toContainEqual({
      capability: 'test.run',
      scope: {
        kind: 'subtree',
        resource: CURRENT_WORKSPACE_RESOURCE,
      },
    });
  });

  it('allows a parent to delegate only a narrower resource scope', () => {
    const manager = createManager();
    const parentGrants = manager.issueRootGrants(
      'parent',
      [
        {
          capability: 'file.write',
          scope: {
            kind: 'subtree',
            resource: 'file:///repo/src',
          },
        },
      ],
      10,
    );

    const childGrants = manager.delegate(
      'parent',
      parentGrants,
      'child',
      [
        {
          capability: 'file.write',
          scope: {
            kind: 'subtree',
            resource: 'file:///repo/src/auth',
          },
        },
      ],
      20,
    );

    expect(childGrants).toMatchObject([
      {
        subjectTaskId: 'child',
        capability: 'file.write',
        scope: {
          kind: 'subtree',
          resource: 'file:///repo/src/auth',
        },
        source: {
          type: 'parent',
          issuerTaskId: 'parent',
          parentGrantId: parentGrants[0]?.grantId,
        },
      },
    ]);
    expect(() =>
      manager.delegate(
        'parent',
        parentGrants,
        'other-child',
        [
          {
            capability: 'file.write',
            scope: {
              kind: 'subtree',
              resource: 'file:///repo',
            },
          },
        ],
        20,
      ),
    ).toThrow('cannot delegate capability file.write');
  });

  it('routes sensitive capabilities to humans and forbids delegation', () => {
    const manager = createManager();
    const parentGrants = manager.issueRootGrants(
      'parent',
      ['git.push'],
      10,
    );

    expect(parentGrants).toMatchObject([
      {
        delegable: false,
        execution: 'human_approval_required',
      },
    ]);
    expect(
      manager.check(parentGrants, ['git.push'], 20),
    ).toMatchObject({ allowed: false });

    expect(
      manager.planRequest(
        'child',
        [{ taskId: 'parent', grants: parentGrants }],
        [
          {
            capability: 'git.push',
            scope: {
              kind: 'exact',
              resource: 'git://repo/origin/main',
            },
          },
        ],
        20,
      ),
    ).toEqual({
      routed: true,
      route: 'human',
    });
    expect(
      manager.validateDelegation(
        parentGrants,
        ['git.push'],
        20,
      ),
    ).toMatchObject({
      allowed: false,
      capability: 'git.push',
    });
    expect(
      manager.grantByHuman(
        'child',
        'approval-1',
        [
          {
            capability: 'git.push',
            scope: {
              kind: 'exact',
              resource: 'git://repo/origin/main',
            },
          },
        ],
        20,
      ),
    ).toMatchObject([
      {
        delegable: false,
        remainingUses: 1,
      },
    ]);
  });

  it('matches exact and subtree scopes without prefix confusion', () => {
    const manager = createManager();
    const grants = manager.issueRootGrants(
      'developer',
      [
        {
          capability: 'file.read',
          scope: {
            kind: 'subtree',
            resource: 'file:///repo/src/auth',
          },
        },
      ],
      10,
    );

    expect(
      manager.check(
        grants,
        [
          {
            capability: 'file.read',
            scope: {
              kind: 'exact',
              resource: 'file:///repo/src/auth/token.ts',
            },
          },
        ],
        20,
      ),
    ).toMatchObject({ allowed: true });
    expect(
      manager.check(
        grants,
        [
          {
            capability: 'file.read',
            scope: {
              kind: 'exact',
              resource: 'file:///repo/src/authentication.ts',
            },
          },
        ],
        20,
      ),
    ).toMatchObject({
      allowed: false,
    });
    expect(
      manager.check(
        grants,
        [
          {
            capability: 'file.read',
            scope: {
              kind: 'exact',
              resource: 'file:///repo/src/auth/../secrets.txt',
            },
          },
        ],
        20,
      ),
    ).toMatchObject({
      allowed: false,
    });
  });

  it('binds a single-use human grant to one idempotent operation', () => {
    const manager = createManager();
    const request = {
      capability: 'git.push',
      scope: {
        kind: 'exact' as const,
        resource: 'git://repo/origin/main',
      },
    };
    const grants = manager.grantByHuman(
      'release-agent',
      'approval-1',
      [request],
      10,
    );
    const task = TaskControlBlock.createAgent(
      {
        id: 'release-agent',
        goal: 'Publish one commit.',
      },
      { kind: 'root' },
      10,
      grants,
    );

    task.consumeCapabilityGrant(grants[0]?.grantId ?? '', 'push-call-1');

    expect(
      manager.check(
        task.capabilityGrants,
        [request],
        20,
        'push-call-1',
      ),
    ).toMatchObject({ allowed: true });
    expect(
      manager.check(
        task.capabilityGrants,
        [request],
        20,
        'push-call-2',
      ),
    ).toMatchObject({ allowed: false });
  });
});
