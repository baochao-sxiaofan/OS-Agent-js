import type { ContextBudget, ContextEntry, ContextSummary } from '../api.js';
import { AgentContextError } from '../management.js';

export function requireContext(condition: unknown, message: string,
  code: AgentContextError['code'] = 'invalid_input'): asserts condition {
  if (!condition) throw new AgentContextError(code, message);
}

export function object(value: unknown): asserts value is Record<string, unknown> {
  requireContext(value !== null && typeof value === 'object' && !Array.isArray(value), '需要 JSON 对象。');
}

export function text(value: unknown): asserts value is string {
  requireContext(typeof value === 'string' && value.trim().length > 0, '字符串不能为空。');
}

export function integer(value: unknown, minimum = 0): asserts value is number {
  requireContext(typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum,
    `数值必须为不小于 ${minimum} 的安全整数。`);
}

export function strings(value: unknown): asserts value is string[] {
  requireContext(Array.isArray(value), '需要字符串数组。');
  value.forEach(text);
}

export function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  requireContext(Object.keys(value).every((key) => allowed.includes(key)), '对象包含未支持的字段。');
}

export function json(value: unknown): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    requireContext(Number.isFinite(value), 'JSON 数值必须有限。');
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(json);
    return;
  }
  object(value);
  requireContext(Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null, '只能保存普通 JSON 对象。');
  Object.values(value).forEach(json);
}

/** 使用 UTF-8 字节数作为保守容量单位；模型适配器仍需检查完整请求。 */
export function estimateContextTokens(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

export function validateBudget(value: unknown): asserts value is ContextBudget {
  object(value);
  keys(value, ['maxTokens', 'compactAtTokens', 'targetTokens', 'maxTasks']);
  for (const field of ['maxTokens', 'compactAtTokens', 'targetTokens', 'maxTasks']) integer(value[field], 1);
  requireContext(Number(value.targetTokens) < Number(value.compactAtTokens) &&
    Number(value.compactAtTokens) < Number(value.maxTokens), '预算必须满足 target < compactAt < max。');
}

export function validateSummary(value: unknown, allowedRefs?: readonly string[]): asserts value is ContextSummary {
  object(value);
  keys(value, ['outcome', 'observations', 'decisions', 'artifactRefs', 'unresolved',
    'nextResponsibilities', 'lessonCandidates', 'sourceRefs']);
  text(value.outcome);
  for (const field of ['decisions', 'artifactRefs', 'unresolved', 'nextResponsibilities', 'sourceRefs']) {
    strings(value[field]);
  }
  const checkRefs = (refs: unknown): void => {
    strings(refs);
    if (allowedRefs) requireContext(refs.every((ref) => allowedRefs.includes(ref)), '总结引用不属于封存来源。');
  };
  checkRefs(value.sourceRefs);
  checkRefs(value.artifactRefs);
  requireContext(Array.isArray(value.observations), 'observations 必须为数组。');
  for (const item of value.observations) {
    object(item);
    keys(item, ['kind', 'statement', 'sourceRefs']);
    requireContext(item.kind === 'fact' || item.kind === 'hypothesis', '观察必须区分事实与假设。');
    text(item.statement);
    checkRefs(item.sourceRefs);
    requireContext(item.kind !== 'fact' || (item.sourceRefs as string[]).length > 0, '事实必须带来源。');
  }
  requireContext(Array.isArray(value.lessonCandidates), 'lessonCandidates 必须为数组。');
  for (const item of value.lessonCandidates) {
    object(item);
    keys(item, ['statement', 'scope', 'sourceRefs']);
    text(item.statement);
    text(item.scope);
    checkRefs(item.sourceRefs);
  }
}

export function validateEntry(value: unknown): asserts value is ContextEntry {
  object(value);
  text(value.id);
  integer(value.createdAt);
  const base = ['id', 'createdAt', 'kind'];
  switch (value.kind) {
    case 'message':
      keys(value, [...base, 'role', 'content', 'attachmentRefs']);
      requireContext(value.role === 'user' || value.role === 'assistant', '非法消息角色。');
      text(value.content);
      if (value.attachmentRefs !== undefined) strings(value.attachmentRefs);
      return;
    case 'event':
      keys(value, [...base, 'name', 'data']);
      text(value.name);
      json(value.data);
      return;
    case 'tool_call':
    case 'tool_result':
      keys(value, [...base, 'callId', 'toolName', value.kind === 'tool_call' ? 'input' : 'output']);
      text(value.callId);
      text(value.toolName);
      json(value.kind === 'tool_call' ? value.input : value.output);
      return;
    case 'observation':
      keys(value, [...base, 'observation']);
      validateSummary({
        outcome: '观察校验', observations: [value.observation], decisions: [], artifactRefs: [],
        unresolved: [], nextResponsibilities: [], lessonCandidates: [], sourceRefs: [],
      });
      return;
    default:
      throw new AgentContextError('invalid_input', '不支持的语义记录。');
  }
}
