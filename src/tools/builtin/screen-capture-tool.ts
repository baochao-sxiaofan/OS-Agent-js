import type { CapabilityInput } from '../../capability/capability.js';
import { MODEL_IMAGE_MARKER } from '../../kernel/context.js';
import type { JsonValue } from '../../types/json.js';
import type { Tool } from '../tool.js';

export type CapturedScreen = {
  mimeType: 'image/png' | 'image/jpeg';
  dataBase64: string;
  width: number;
  height: number;
  sourceName: string;
};

export interface ScreenCapturePort {
  capturePrimaryScreen(signal: AbortSignal): Promise<CapturedScreen>;
}

export function createScreenCaptureTool(port: ScreenCapturePort): Tool {
  return {
    name: 'screen.capture',
    description:
      'Capture the primary screen for UI verification. The image is attached to the next model request; use only when visual evidence is required.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    effect: 'privileged',
    validateInput() {
      return { valid: true };
    },
    requiredCapabilities(): readonly CapabilityInput[] {
      return [
        {
          capability: 'screen.capture',
          scope: { kind: 'exact', resource: 'screen://primary' },
        },
      ];
    },
    async execute(_input, context): Promise<JsonValue> {
      const image = await port.capturePrimaryScreen(context.signal);
      return {
        marker: MODEL_IMAGE_MARKER,
        mimeType: image.mimeType,
        dataBase64: image.dataBase64,
        width: image.width,
        height: image.height,
        sourceName: image.sourceName,
      };
    },
  };
}
