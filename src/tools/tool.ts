import type { JsonObject, JsonValue } from '../types/json.js';
import type { CapabilityInput } from '../capability/capability.js';

export type ToolEffect = 'privileged' | 'read_only' | 'side_effect';

export type ToolExecutionContext = {
  taskId: string;
  /** Root task identity supplied by the scheduler; defaults to taskId for legacy hosts. */
  rootTaskId?: string;
  graphNodeAlias?: string;
  signal: AbortSignal;
  idempotencyKey: string;
  /**
   * 当前任务挂载的宿主工作区根目录（已消解符号链接）。
   *
   * 需要访问文件系统或工作区内命令的工具依赖它把 `workspace://current/` 别名
   * 解析为真实路径；未挂载工作区时为 undefined，相关工具应拒绝执行。
   */
  workspaceRoot?: string;
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
  /** Provider-facing JSON Schema for this tool's input. */
  readonly inputSchema?: JsonObject;
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
