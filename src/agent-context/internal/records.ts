import type { ContextRecord } from '../management.js';
import { validateCheckpoint, validateDelivery } from './checkpoint.js';
import { keys, object, requireContext, text, validateSummary } from './validation.js';

/** 存储记录按不可信 JSON 处理，不让类型断言绕过恢复校验。 */
export function validateRecord(value: unknown): asserts value is ContextRecord {
  object(value);
  switch (value.kind) {
    case 'history':
      keys(value, ['kind', 'delivery']);
      validateDelivery(value.delivery);
      return;
    case 'summary':
      keys(value, ['kind', 'sourceRef', 'summary']);
      text(value.sourceRef);
      validateSummary(value.summary);
      return;
    case 'frame': {
      keys(value, ['kind', 'context']);
      object(value.context);
      object(value.context.level1);
      const rootBudget = value.context.level1.budget;
      const lowerBudget = (level: 2 | 3): unknown => {
        const frame = (value.context as Record<string, unknown>)[`level${level}`];
        if (frame === null) return rootBudget;
        object(frame);
        return frame.budget;
      };
      validateCheckpoint({
        schemaVersion: 1, revision: 0, context: value.context, runnable: true,
        pendingSummary: null, inbox: [],
        policy: { budgets: { 1: rootBudget, 2: lowerBudget(2), 3: lowerBudget(3) },
          maxSummaryAttempts: 1, maxInbox: 1, maxDeliveryBytes: 1 },
      });
      return;
    }
    default:
      requireContext(false, '未知的历史记录类型。');
  }
}
