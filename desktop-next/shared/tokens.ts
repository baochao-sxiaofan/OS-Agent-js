/** 浏览器仅接收容量数据，不能导入 Node Runtime 实现。 */
export type TokenSettings = {
  maxRequestTokens: number; maxOutputTokens: number;
  tokensPerMinute: number; maxTotalTokens: number;
  contextMaxTokens: number; contextCompactAtTokens: number; contextTargetTokens: number;
};

export const tokenPresets: Readonly<Record<'500K' | '1M', TokenSettings>> = {
  '500K': { maxRequestTokens: 500_000, maxOutputTokens: 32_768, tokensPerMinute: 2_000_000,
    maxTotalTokens: 10_000_000, contextMaxTokens: 140_000, contextCompactAtTokens: 100_000, contextTargetTokens: 50_000 },
  '1M': { maxRequestTokens: 1_000_000, maxOutputTokens: 32_768, tokensPerMinute: 4_000_000,
    maxTotalTokens: 20_000_000, contextMaxTokens: 300_000, contextCompactAtTokens: 210_000, contextTargetTokens: 105_000 },
};
