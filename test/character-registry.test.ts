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
    ).toEqual(['file.read']);
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
});
