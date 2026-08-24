import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  type BrowserWindowConstructorOptions,
} from 'electron';

import {
  IPC_CHANNELS,
  PROVIDER_CATALOG,
  type DiscoverModelsInput,
  type ProviderId,
  type SaveModelSettingsInput,
  type SubmitTaskInput,
} from '../shared/contracts.js';
import { ModelSettingsStore } from './model-settings-store.js';
import {
  discoverProviderModels,
  type ProviderCredentials,
} from './provider-registry.js';
import { RuntimeService } from './runtime-service.js';

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
    IPC_CHANNELS.cancelTask,
    async (_event, taskId: unknown) => {
      if (typeof taskId !== 'string' || taskId.length === 0) {
        throw new Error('Invalid task ID.');
      }
      return await runtime.cancelTask(taskId);
    },
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
  const runtime = new RuntimeService(savedConfig, {
    storeLocation: join(app.getPath('userData'), 'tasks.db'),
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
    typeof input !== 'object' ||
    input === null ||
    !('conversationId' in input) ||
    !('task' in input) ||
    typeof input.conversationId !== 'string' ||
    typeof input.task !== 'string'
  ) {
    throw new Error('Invalid task submission.');
  }
  return {
    conversationId: input.conversationId,
    task: input.task,
  };
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
