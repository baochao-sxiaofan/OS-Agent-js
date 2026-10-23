import { z } from 'zod';
import type { JsonValue } from './json.js';

/** 通用 JSON 边界校验独立于 Agent 业务协议，供持久化与外部适配使用。 */
export const jsonSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(), z.number().finite(), z.boolean(), z.null(),
  z.array(jsonSchema), z.record(jsonSchema),
]));
