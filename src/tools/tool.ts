import type { JsonObject, JsonValue } from '../types/json.js';
import type { CapabilityInput } from '../capability/capability.js';
import type { OperationStore } from '../persistence/operation-store.js';

export type ToolEffect = 'privileged' | 'read_only' | 'side_effect';

export type ToolExecutionContext = {
  taskId: string;
  /** 调度器提供的根任务身份；兼容旧宿主时默认使用 taskId。 */
  rootTaskId?: string;
  graphNodeAlias?: string;
  signal: AbortSignal;
  idempotencyKey: string;
  operationStore?: OperationStore;
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
  /** 提供给模型服务商的工具输入 JSON Schema。 */
  readonly inputSchema?: JsonObject;
  /** 作用于全部资源的能力简写，用于兼容旧调用方。 */
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
