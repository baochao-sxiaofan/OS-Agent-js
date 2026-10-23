import { z } from 'zod';
import type { ContextBudget } from '../agent-context/index.js';

/** 宿主可调整的容量；请求容量包含输入及输出预留，层级容量沿用内核保守估算。 */
export type RuntimeTokenSettings = {
  readonly maxRequestTokens: number;
  readonly maxOutputTokens: number;
  readonly tokensPerMinute: number;
  readonly maxTotalTokens: number;
  readonly contextMaxTokens: number;
  readonly contextCompactAtTokens: number;
  readonly contextTargetTokens: number;
};

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const runtimeTokenSettingsSchema = z.object({
  maxRequestTokens: positive, maxOutputTokens: positive,
  tokensPerMinute: positive, maxTotalTokens: positive,
  contextMaxTokens: positive, contextCompactAtTokens: positive, contextTargetTokens: positive,
}).strict().superRefine((value, ctx) => {
  const issue = (path: keyof RuntimeTokenSettings, message: string) =>
    ctx.addIssue({ code: 'custom', path: [path], message });
  if (value.maxOutputTokens >= value.maxRequestTokens) issue('maxOutputTokens', '单次输出必须小于请求容量。');
  if (value.tokensPerMinute < value.maxRequestTokens) issue('tokensPerMinute', '每分钟额度必须容纳一次最大请求。');
  if (value.maxTotalTokens < value.maxRequestTokens) issue('maxTotalTokens', '累计额度必须容纳一次最大请求。');
  if (value.contextTargetTokens >= value.contextCompactAtTokens || value.contextCompactAtTokens >= value.contextMaxTokens) {
    issue('contextTargetTokens', '每层容量必须满足：压缩目标 < 压缩阈值 < 硬上限。');
  }
  if (value.contextMaxTokens > Math.floor((value.maxRequestTokens - value.maxOutputTokens) / 3)) {
    issue('contextMaxTokens', '三层硬上限与输出预留之和不能超过请求容量。');
  }
});

export const defaultTokenSettings: RuntimeTokenSettings = {
  maxRequestTokens: 500_000, maxOutputTokens: 32_768,
  tokensPerMinute: 2_000_000, maxTotalTokens: 10_000_000,
  contextMaxTokens: 140_000, contextCompactAtTokens: 100_000, contextTargetTokens: 50_000,
};

export function tokenContextBudget(settings: RuntimeTokenSettings, maxTasks = 12): ContextBudget {
  return { maxTokens: settings.contextMaxTokens, compactAtTokens: settings.contextCompactAtTokens,
    targetTokens: settings.contextTargetTokens, maxTasks };
}
