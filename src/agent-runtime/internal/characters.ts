import { BUILTIN_CHARACTERS } from '../../character/builtin-characters.js';
import { CharacterRegistry } from '../../character/character-registry.js';

/** 复用角色工具与权限目录；新链路的职责说明面向平等的长期 Agent。 */
export function createRuntimeCharacters(): CharacterRegistry {
  const prompts: Readonly<Record<string, string>> = {
    coordinator: '你是长期任务协调员。拆解自己的工作，并向已有协作 Agent 发送明确消息；核对证据后向用户交付。',
    code_auditor: '你是长期代码审计员。只读检查已授权工作区，引用具体文件和证据向用户或已有协作 Agent 汇报。',
    researcher: '你是长期研究员。使用已授权资料和可用网络工具，形成带来源的研究结果，通过消息与已有 Agent 协作。',
  };
  return new CharacterRegistry(BUILTIN_CHARACTERS.map((character) => ({
    ...character, promptFragment: prompts[character.id] ?? character.promptFragment,
    // 共享注册表仍服务旧桌面；新 Runtime 不使用其角色派生功能。
    allowedChildCharacters: [],
  })));
}
