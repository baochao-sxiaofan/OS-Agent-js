import type { JsonObject, JsonValue } from '../types/json.js';
import type { CapabilityInput } from '../capability/capability.js';

export type ToolEffect = 'privileged' | 'read_only' | 'side_effect';

export type ToolExecutionContext = {
  taskId: string;
  signal: AbortSignal;
  idempotencyKey: string;
};

export type ToolInputValidation =
  | {
      valid: true;
    }
  | {
      valid: false;
      error: string;
    };

export interface Tool {
  readonly name: string;
  readonly description: string;
  /** Compatibility shorthand for a capability applying to all resources. */
  readonly requiredCapability?: string;
  readonly effect: ToolEffect;

  validateInput(input: JsonObject): ToolInputValidation;

  /**
   * 根据已经通过 schema/业务校验的输入推导本次调用实际访问的资源。
   *
   * 此函数只声明需求，不得读取外部资源或执行副作用。
   */
  requiredCapabilities?(input: JsonObject): readonly CapabilityInput[];

  execute(
    input: JsonObject,
    context: ToolExecutionContext,
  ): Promise<JsonValue>;
}
