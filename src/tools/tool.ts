import type { JsonObject, JsonValue } from '../types/json.js';

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
  readonly requiredCapability: string;
  readonly effect: ToolEffect;

  validateInput(input: JsonObject): ToolInputValidation;

  execute(
    input: JsonObject,
    context: ToolExecutionContext,
  ): Promise<JsonValue>;
}
