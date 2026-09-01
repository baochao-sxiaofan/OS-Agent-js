import { describe, expect, it } from 'vitest';

import {
  CharacterRegistry,
  DEVELOPER_CHARACTER,
  UnknownCharacterError,
  type CharacterDefinition,
} from '../src/index.js';

describe('CharacterRegistry', () => {
  it('loads the builtin characters by default', () => {
    const registry = new CharacterRegistry();
    expect(registry.has('developer')).toBe(true);
    expect(registry.has('code_auditor')).toBe(true);
    expect(registry.has('researcher')).toBe(true);
    expect(registry.has('tester')).toBe(true);
    expect(registry.get('developer').id).toBe(DEVELOPER_CHARACTER.id);
  });

  it('throws for unknown characters', () => {
    const registry = new CharacterRegistry();
    expect(() => registry.get('ghost')).toThrow(UnknownCharacterError);
  });

  it('rejects a definition that can request beyond its ceiling', () => {
    const invalid: CharacterDefinition = {
      id: 'broken',
      displayName: 'Broken',
      promptFragment: 'x',
      visibleToolIds: [],
      capabilityCeiling: ['file.read'],
      requestableCapabilities: ['file.write'],
      allowedChildCharacters: [],
    };
    expect(() => new CharacterRegistry([invalid])).toThrow(
      'outside its ceiling',
    );
  });

  it('filters visible tools by character but passes everything without a character', () => {
    const registry = new CharacterRegistry();
    const tools = [
      { name: 'file.read' },
      { name: 'file.write' },
      { name: 'test.run' },
    ];
    expect(
      registry.visibleTools('code_auditor', tools).map((tool) => tool.name),
    ).toEqual(['file.read', 'test.run']);
    expect(registry.visibleTools(undefined, tools)).toHaveLength(3);
  });

  it('enforces the allowed child-character list', () => {
    const parent: CharacterDefinition = {
      id: 'lead',
      displayName: 'Lead',
      promptFragment: 'x',
      visibleToolIds: [],
      capabilityCeiling: ['*'],
      requestableCapabilities: [],
      allowedChildCharacters: ['developer'],
    };
    const registry = new CharacterRegistry([
      parent,
      DEVELOPER_CHARACTER,
    ]);
    expect(registry.canCreateChild('lead', 'developer')).toBe(true);
    expect(registry.canCreateChild('lead', 'code_auditor')).toBe(false);
    // 无 character 的父任务不受名单限制，但仍要求子角色存在。
    expect(registry.canCreateChild(undefined, 'developer')).toBe(true);
    expect(registry.canCreateChild(undefined, 'ghost')).toBe(false);
  });

  it('never exposes or creates a root-only character as a child', () => {
    const manager: CharacterDefinition = {
      id: 'manager',
      displayName: 'Manager',
      rootOnly: true,
      promptFragment: 'Coordinate the root task.',
      visibleToolIds: [],
      capabilityCeiling: ['*'],
      requestableCapabilities: [],
      allowedChildCharacters: ['developer'],
    };
    const parent: CharacterDefinition = {
      id: 'lead',
      displayName: 'Lead',
      promptFragment: 'Delegate specialist work.',
      visibleToolIds: [],
      capabilityCeiling: ['*'],
      requestableCapabilities: [],
      allowedChildCharacters: ['manager', 'developer'],
    };
    const registry = new CharacterRegistry([
      manager,
      parent,
      DEVELOPER_CHARACTER,
    ]);

    expect(registry.availableChildren('lead').map(({ id }) => id)).toEqual([
      'developer',
    ]);
    expect(registry.canCreateChild('lead', 'manager')).toBe(false);
    expect(registry.canCreateChild(undefined, 'manager')).toBe(false);
  });

  it('reports the first capability outside a character ceiling', () => {
    const registry = new CharacterRegistry();
    expect(
      registry.capabilityOutsideCeiling('code_auditor', [
        { capability: 'file.read', scope: { kind: 'all' } },
        { capability: 'file.write', scope: { kind: 'all' } },
      ]),
    ).toBe('file.write');
    expect(
      registry.capabilityOutsideCeiling('code_auditor', [
        { capability: 'file.read', scope: { kind: 'all' } },
      ]),
    ).toBeUndefined();
    // 无 character 时不施加名称限制。
    expect(
      registry.capabilityOutsideCeiling(undefined, [
        { capability: 'anything', scope: { kind: 'all' } },
      ]),
    ).toBeUndefined();
  });

  it('keeps tester read-only while granting sandboxed execution and screen inspection', () => {
    const registry = new CharacterRegistry();
    const tester = registry.get('tester');

    expect(tester.visibleToolIds).toEqual(
      expect.arrayContaining([
        'test.run',
        'screen.capture',
        'artifact.write',
        'git.diff',
      ]),
    );
    expect(tester.visibleToolIds).not.toContain('file.write');
    expect(tester.capabilityCeiling).toEqual(
      expect.arrayContaining([
        'test.run',
        'screen.capture',
        'artifact.write',
      ]),
    );
    expect(tester.capabilityCeiling).not.toContain('file.write');
  });

  it('gives researcher network search without source-code mutation tools', () => {
    const researcher = new CharacterRegistry().get('researcher');

    expect(researcher.visibleToolIds).toEqual(
      expect.arrayContaining([
        'web.search',
        'web.fetch',
        'knowledge.search',
        'artifact.write',
      ]),
    );
    expect(researcher.visibleToolIds).not.toContain('file.apply_patch');
    expect(researcher.visibleToolIds).not.toContain('file.write');
    expect(researcher.capabilityCeiling).not.toContain('file.write');
    expect(researcher.capabilityCeiling).toContain('network.http.read');
  });
});
