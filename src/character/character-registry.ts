import type { CapabilityRequest } from '../capability/capability.js';
import { BUILTIN_CHARACTERS } from './builtin-characters.js';
import type { CharacterDefinition } from './character.js';
import {
  characterAllowsCapability,
  findCapabilityOutsideCeiling,
} from './character.js';

export class UnknownCharacterError extends Error {
  constructor(readonly characterId: string) {
    super(`Character is not registered: ${characterId}`);
    this.name = 'UnknownCharacterError';
  }
}

/**
 * Character 的唯一注册与查询入口。
 *
 * 注册表由内核持有，Agent 和模型只能引用已注册的 characterId，不能凭空定义
 * 新角色或提升角色权限上限。默认装载首批内置角色。
 */
export class CharacterRegistry {
  readonly #characters = new Map<string, CharacterDefinition>();

  constructor(
    definitions: readonly CharacterDefinition[] = BUILTIN_CHARACTERS,
  ) {
    for (const definition of definitions) {
      this.register(definition);
    }
  }

  register(definition: CharacterDefinition): void {
    if (this.#characters.has(definition.id)) {
      throw new Error(`Character is already registered: ${definition.id}`);
    }
    for (const capability of definition.requestableCapabilities) {
      if (
        !characterAllowsCapability(
          definition.capabilityCeiling,
          capability,
        )
      ) {
        throw new Error(
          `Character ${definition.id} can request ${capability} outside its ceiling.`,
        );
      }
    }
    this.#characters.set(definition.id, definition);
  }

  has(characterId: string): boolean {
    return this.#characters.has(characterId);
  }

  get(characterId: string): CharacterDefinition {
    const definition = this.#characters.get(characterId);
    if (!definition) {
      throw new UnknownCharacterError(characterId);
    }
    return definition;
  }

  list(): CharacterDefinition[] {
    return [...this.#characters.values()];
  }

  availableChildren(
    parentCharacterId: string | undefined,
  ): CharacterDefinition[] {
    if (parentCharacterId === undefined) {
      return this.list().filter((definition) => !definition.rootOnly);
    }
    return this.get(parentCharacterId).allowedChildCharacters
      .map((characterId) => this.get(characterId))
      .filter((definition) => !definition.rootOnly);
  }

  /**
   * 判断 `parentCharacterId` 是否允许创建 `childCharacterId`。
   *
   * 未声明 character 的父 Agent（例如宿主直接创建的根任务）不受名单约束，
   * 以保持与现有无 Character 行为兼容。
   */
  canCreateChild(
    parentCharacterId: string | undefined,
    childCharacterId: string,
  ): boolean {
    if (!this.has(childCharacterId)) {
      return false;
    }
    if (this.get(childCharacterId).rootOnly) {
      return false;
    }
    if (parentCharacterId === undefined) {
      return true;
    }
    return this.get(parentCharacterId).allowedChildCharacters.includes(
      childCharacterId,
    );
  }

  /**
   * 返回一组能力请求中第一个越过角色能力上限的能力名称。
   *
   * 未声明 character 时不施加名称限制，仅由委派衰减和 workspace 边界约束。
   */
  capabilityOutsideCeiling(
    characterId: string | undefined,
    requests: readonly CapabilityRequest[],
  ): string | undefined {
    if (characterId === undefined) {
      return undefined;
    }
    return findCapabilityOutsideCeiling(
      this.get(characterId).capabilityCeiling,
      requests,
    );
  }

  requestableCapabilityOutsidePolicy(
    characterId: string | undefined,
    requests: readonly CapabilityRequest[],
  ): string | undefined {
    if (characterId === undefined) {
      return undefined;
    }
    const allowed = this.get(characterId).requestableCapabilities;
    for (const request of requests) {
      if (!characterAllowsCapability(allowed, request.capability)) {
        return request.capability;
      }
    }
    return undefined;
  }

  /**
   * 过滤出角色可见的工具描述。
   *
   * 未声明 character 时返回全部工具，保持旧行为；声明后仅保留角色 visibleToolIds
   * 中确实注册过的工具。
   */
  visibleTools<TTool extends { name: string }>(
    characterId: string | undefined,
    tools: readonly TTool[],
  ): TTool[] {
    if (characterId === undefined) {
      return [...tools];
    }
    const visible = new Set(this.get(characterId).visibleToolIds);
    return tools.filter((tool) => visible.has(tool.name));
  }
}
