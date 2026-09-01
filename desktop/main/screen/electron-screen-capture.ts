import { desktopCapturer, screen } from 'electron';

import type {
  CapturedScreen,
  ScreenCapturePort,
} from '../../../src/index.js';

const MAX_CAPTURE_WIDTH = 1_920;

export class ElectronScreenCapture implements ScreenCapturePort {
  async capturePrimaryScreen(
    signal: AbortSignal,
  ): Promise<CapturedScreen> {
    if (signal.aborted) {
      throw new Error('Screen capture was cancelled.');
    }
    const display = screen.getPrimaryDisplay();
    const scale = Math.min(1, MAX_CAPTURE_WIDTH / display.size.width);
    const thumbnailSize = {
      width: Math.max(1, Math.round(display.size.width * scale)),
      height: Math.max(1, Math.round(display.size.height * scale)),
    };
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize,
      fetchWindowIcons: false,
    });
    if (signal.aborted) {
      throw new Error('Screen capture was cancelled.');
    }
    const source =
      sources.find(
        (candidate) => candidate.display_id === String(display.id),
      ) ?? sources[0];
    if (!source || source.thumbnail.isEmpty()) {
      throw new Error('The primary screen could not be captured.');
    }
    const size = source.thumbnail.getSize();
    return {
      mimeType: 'image/png',
      dataBase64: source.thumbnail.toPNG().toString('base64'),
      width: size.width,
      height: size.height,
      sourceName: 'primary-screen',
    };
  }
}
