import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  type BrowserWindowConstructorOptions,
  type OpenDialogOptions,
} from 'electron';

import {
  IPC_CHANNELS,
  PROVIDER_CATALOG,
  type DiscoverModelsInput,
  type ProviderId,
  type ResolveCapabilityApprovalInput,
  type SaveModelSettingsInput,
  type SubmitTaskInput,
} from '../shared/contracts.js';
import { ModelSettingsStore } from './model-settings-store.js';
import {
  discoverProviderModels,
  type ProviderCredentials,
} from './provider-registry.js';
import { RuntimeService } from './runtime-service.js';
import { SafeWebAccess } from './network/safe-web-access.js';
import { ElectronScreenCapture } from './screen/electron-screen-capture.js';
import {
  MacOSProcessSandbox,
  probeMacOSSandbox,
} from './sandbox/index.js';

const currentDirectory = fileURLToPath(new URL('.', import.meta.url));
const localDataDirectory = process.env['OS_AGENT_USER_DATA_DIR'];
const sandboxWorkaround =
  process.env['OS_AGENT_DISABLE_CHROMIUM_SANDBOX'] === '1';

if (localDataDirectory) {
  const resolvedDataDirectory = resolve(localDataDirectory);
  const sessionDataDirectory = join(resolvedDataDirectory, 'session');
  mkdirSync(sessionDataDirectory, { recursive: true });
  app.setPath('userData', resolvedDataDirectory);
  app.setPath('sessionData', sessionDataDirectory);
}
if (sandboxWorkaround) {
  app.commandLine.appendSwitch('no-sandbox');
  app.disableHardwareAcceleration();
}

let mainWindow: BrowserWindow | undefined;

function registerIpcHandlers(
  runtime: RuntimeService,
  settingsStore: ModelSettingsStore,
): void {
  ipcMain.handle(IPC_CHANNELS.getSnapshot, () => runtime.getSnapshot());
  ipcMain.handle(IPC_CHANNELS.getModelSettings, () =>
    settingsStore.view(runtime.isBusy),
  );
  ipcMain.handle(IPC_CHANNELS.createConversation, () =>
    runtime.createConversation(),
  );
  ipcMain.handle(
    IPC_CHANNELS.selectWorkspace,
    async (_event, conversationId: unknown) => {
      if (typeof conversationId !== 'string' || !conversationId) {
        throw new Error('Invalid Conversation ID.');
      }
      const workspacePath = await selectWorkspaceDirectory();
      return workspacePath === undefined
        ? undefined
        : await runtime.setConversationWorkspace(
            conversationId,
            workspacePath,
          );
    },
  );
  ipcMain.handle(IPC_CHANNELS.selectImages, async () =>
    await selectImageAttachments(),
  );
  ipcMain.handle(
    IPC_CHANNELS.discoverModels,
    async (_event, input: unknown) => {
      const parsed = parseDiscoverModelsInput(input);
      const savedCredential = settingsStore.credentialFor(
        parsed.providerId,
      );
      const credentials = resolveCredentials(parsed, savedCredential);
      return {
        providerId: parsed.providerId,
        models: await discoverProviderModels(credentials),
        usedStoredCredential: !parsed.apiKey?.trim(),
      };
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.saveModelSettings,
    async (_event, input: unknown) => {
      const parsed = parseSaveModelSettingsInput(input);
      const savedCredential = settingsStore.credentialFor(
        parsed.providerId,
      );
      const credentials = resolveCredentials(parsed, savedCredential);
      const config = {
        ...credentials,
        modelId: parsed.modelId,
      };
      const verification =
        await runtime.verifyAndConfigureModel(config);
      await settingsStore.save(config);
      return {
        settings: settingsStore.view(runtime.isBusy),
        verification,
        snapshot: runtime.getSnapshot(),
      };
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.submitTask,
    async (_event, input: unknown) =>
      await runtime.submitTask(parseSubmitTaskInput(input)),
  );
  ipcMain.handle(
    IPC_CHANNELS.resolveCapabilityApproval,
    async (_event, input: unknown) => {
      const parsed = parseCapabilityApprovalInput(input);
      return await runtime.resolveCapabilityApproval(
        parsed.requestId,
        parsed.decision,
        parsed.reason,
      );
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.cancelTask,
    async (_event, taskId: unknown) => {
      if (typeof taskId !== 'string' || taskId.length === 0) {
        throw new Error('Invalid task ID.');
      }
      return await runtime.cancelTask(taskId);
    },
  );
}

/**
 * 在 darwin 上探测 Seatbelt 后端，仅当真实负向验证通过时才注入进程沙箱。
 *
 * 探测失败时返回 undefined：RuntimeService 因此不会注册 test.run，也不会降级为
 * 不受约束的裸执行。
 */
function resolveProcessSandbox(): MacOSProcessSandbox | undefined {
  const probe = probeMacOSSandbox();
  if (!probe.available) {
    console.warn(
      `[os-agent] Process sandbox disabled; test.run unavailable: ${probe.reason}`,
    );
    return undefined;
  }
  console.info('[os-agent] macOS process sandbox verified; test.run enabled.');
  return new MacOSProcessSandbox();
}

async function selectWorkspaceDirectory(): Promise<string | undefined> {
  const options: OpenDialogOptions = {
    title: '选择 Conversation Workspace',
    buttonLabel: '选择 Workspace',
    properties: ['openDirectory', 'createDirectory'],
  };
  const selection = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  return selection.canceled ? undefined : selection.filePaths[0];
}

async function selectImageAttachments() {
  const options: OpenDialogOptions = {
    title: '选择图片上下文',
    buttonLabel: '添加图片',
    properties: ['openFile', 'multiSelections'],
    filters: [
      {
        name: 'Images',
        extensions: ['png', 'jpg', 'jpeg', 'webp'],
      },
    ],
  };
  const selection = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  if (selection.canceled) {
    return [];
  }
  if (selection.filePaths.length > 4) {
    throw new Error('每轮最多添加 4 张图片。');
  }
  return await Promise.all(
    selection.filePaths.map(async (filePath) => {
      const bytes = await readFile(filePath);
      if (bytes.byteLength > 8 * 1024 * 1024) {
        throw new Error('单张图片不能超过 8 MB。');
      }
      const extension = extname(filePath).toLowerCase();
      const mimeType =
        extension === '.png'
          ? 'image/png'
          : extension === '.webp'
            ? 'image/webp'
            : 'image/jpeg';
      return {
        id: randomUUID(),
        name: filePath.split(/[\\/]/u).at(-1) ?? 'image',
        mimeType,
        dataBase64: bytes.toString('base64'),
      };
    }),
  );
}

async function createWindow(): Promise<void> {
  const windowOptions: BrowserWindowConstructorOptions = {
    width: 1380,
    height: 880,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    backgroundColor: '#f5f5f2',
    webPreferences: {
      preload: join(currentDirectory, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: !sandboxWorkaround,
    },
  };

  if (process.platform === 'darwin') {
    windowOptions.titleBarStyle = 'hiddenInset';
  } else {
    windowOptions.titleBarStyle = 'hidden';
    windowOptions.titleBarOverlay = {
      color: '#f5f5f2',
      symbolColor: '#1b1b1a',
      height: 46,
    };
  }

  mainWindow = new BrowserWindow(windowOptions);
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });
  mainWindow.on('closed', () => {
    mainWindow = undefined;
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });

  const rendererUrl = process.env['ELECTRON_RENDERER_URL'];
  if (rendererUrl) {
    await mainWindow.loadURL(rendererUrl);
  } else {
    await mainWindow.loadFile(
      join(currentDirectory, '../renderer/index.html'),
    );
  }
}

app.whenReady().then(async () => {
  app.setName('OS Agent');
  const settingsStore = new ModelSettingsStore(
    join(app.getPath('userData'), 'model-settings.json'),
  );
  const savedConfig = await settingsStore.load(
    process.env['GEMINI_API_KEY'],
  );
  const processSandbox = resolveProcessSandbox();
  const runtime = new RuntimeService(savedConfig, {
    storeLocation: join(app.getPath('userData'), 'tasks.db'),
    screenCapture: new ElectronScreenCapture(),
    webAccess: new SafeWebAccess(),
    ...(processSandbox === undefined ? {} : { processSandbox }),
  });
  await runtime.initialize();
  let shutdownStarted = false;
  let shutdownComplete = false;
  app.on('before-quit', (event) => {
    if (shutdownComplete) {
      return;
    }
    event.preventDefault();
    if (shutdownStarted) {
      return;
    }
    shutdownStarted = true;
    void runtime.close().finally(() => {
      shutdownComplete = true;
      app.quit();
    });
  });
  registerIpcHandlers(runtime, settingsStore);
  runtime.subscribe((snapshot) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(
        IPC_CHANNELS.snapshotChanged,
        snapshot,
      );
    }
  });
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

function parseSubmitTaskInput(input: unknown): SubmitTaskInput {
  if (
    !isRecord(input) ||
    typeof input['conversationId'] !== 'string' ||
    typeof input['task'] !== 'string'
  ) {
    throw new Error('Invalid task submission.');
  }
  const preferences = parseTaskPreferences(input['preferences']);
  const attachments = parseImageAttachments(input['attachments']);
  return {
    conversationId: input['conversationId'],
    task: input['task'],
    ...(preferences === undefined ? {} : { preferences }),
    ...(attachments.length === 0 ? {} : { attachments }),
  };
}

function parseTaskPreferences(
  value: unknown,
): SubmitTaskInput['preferences'] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error('Invalid model preferences.');
  }
  const maxContextTokens = value['maxContextTokens'];
  const temperature = value['temperature'];
  const reasoningEffort = value['reasoningEffort'];
  if (
    maxContextTokens !== undefined &&
    (!Number.isInteger(maxContextTokens) ||
      Number(maxContextTokens) < 4_096 ||
      Number(maxContextTokens) > 2_000_000)
  ) {
    throw new Error('Invalid context length.');
  }
  if (
    temperature !== undefined &&
    (typeof temperature !== 'number' ||
      temperature < 0 ||
      temperature > 2)
  ) {
    throw new Error('Invalid model temperature.');
  }
  if (
    reasoningEffort !== undefined &&
    !['auto', 'low', 'medium', 'high'].includes(
      String(reasoningEffort),
    )
  ) {
    throw new Error('Invalid reasoning effort.');
  }
  return {
    ...(typeof maxContextTokens === 'number'
      ? { maxContextTokens }
      : {}),
    ...(typeof temperature === 'number' ? { temperature } : {}),
    ...(typeof reasoningEffort === 'string'
      ? {
          reasoningEffort: reasoningEffort as
            | 'auto'
            | 'low'
            | 'medium'
            | 'high',
        }
      : {}),
  };
}

function parseCapabilityApprovalInput(
  input: unknown,
): ResolveCapabilityApprovalInput {
  if (
    !isRecord(input) ||
    typeof input['requestId'] !== 'string' ||
    !input['requestId'].trim() ||
    (input['decision'] !== 'approve' &&
      input['decision'] !== 'deny') ||
    !isOptionalString(input['reason'])
  ) {
    throw new Error('Invalid capability approval.');
  }
  return {
    requestId: input['requestId'],
    decision: input['decision'],
    ...(input['reason'] === undefined
      ? {}
      : { reason: input['reason'] }),
  };
}

function parseImageAttachments(
  value: unknown,
): NonNullable<SubmitTaskInput['attachments']> {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > 4) {
    throw new Error('Invalid image attachments.');
  }
  return value.map((candidate) => {
    if (
      !isRecord(candidate) ||
      typeof candidate['id'] !== 'string' ||
      typeof candidate['name'] !== 'string' ||
      !['image/jpeg', 'image/png', 'image/webp'].includes(
        String(candidate['mimeType']),
      ) ||
      typeof candidate['dataBase64'] !== 'string' ||
      candidate['dataBase64'].length > 12_000_000
    ) {
      throw new Error('Invalid image attachment.');
    }
    return {
      id: candidate['id'],
      name: candidate['name'],
      mimeType: candidate['mimeType'] as
        | 'image/jpeg'
        | 'image/png'
        | 'image/webp',
      dataBase64: candidate['dataBase64'],
    };
  });
}

function parseDiscoverModelsInput(input: unknown): DiscoverModelsInput {
  if (
    !isRecord(input) ||
    !isProviderId(input['providerId']) ||
    !isOptionalString(input['apiKey']) ||
    !isOptionalString(input['workspaceId'])
  ) {
    throw new Error('模型发现参数无效。');
  }
  return {
    providerId: input['providerId'],
    ...(input['apiKey'] === undefined
      ? {}
      : { apiKey: input['apiKey'] }),
    ...(input['workspaceId'] === undefined
      ? {}
      : { workspaceId: input['workspaceId'] }),
  };
}

function parseSaveModelSettingsInput(
  input: unknown,
): SaveModelSettingsInput {
  if (
    !isRecord(input) ||
    !isProviderId(input['providerId']) ||
    typeof input['modelId'] !== 'string' ||
    !input['modelId'].trim() ||
    !isOptionalString(input['apiKey']) ||
    !isOptionalString(input['workspaceId'])
  ) {
    throw new Error('模型设置参数无效。');
  }
  return {
    providerId: input['providerId'],
    modelId: input['modelId'].trim(),
    ...(input['apiKey'] === undefined
      ? {}
      : { apiKey: input['apiKey'] }),
    ...(input['workspaceId'] === undefined
      ? {}
      : { workspaceId: input['workspaceId'] }),
  };
}

function resolveCredentials(
  input: DiscoverModelsInput | SaveModelSettingsInput,
  saved:
    | Pick<ProviderCredentials, 'apiKey' | 'workspaceId'>
    | undefined,
): ProviderCredentials {
  const apiKey = input.apiKey?.trim() || saved?.apiKey;
  if (!apiKey) {
    throw new Error('请填写该厂商的 API Key。');
  }
  const workspaceId =
    input.workspaceId?.trim() || saved?.workspaceId;
  return {
    providerId: input.providerId,
    apiKey,
    ...(workspaceId === undefined ? {} : { workspaceId }),
  };
}

function isProviderId(value: unknown): value is ProviderId {
  return (
    typeof value === 'string' &&
    PROVIDER_CATALOG.some((provider) => provider.id === value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}
