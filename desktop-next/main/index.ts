import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, safeStorage } from 'electron';
import { z } from 'zod';
import { CHANNEL, CHANGED } from '../shared/contracts.js';
import { DesktopService } from './service.js';

const currentDirectory = fileURLToPath(new URL('.', import.meta.url));
app.setName('OS Agent Next');
const dataDirectory = resolve(process.env['OS_AGENT_NEXT_DATA_DIR'] ?? join(app.getPath('appData'), 'OS Agent Next'));
mkdirSync(dataDirectory, { recursive: true });
app.setPath('userData', dataDirectory);
app.setPath('sessionData', join(dataDirectory, 'session'));
const preview = process.env['OS_AGENT_NEXT_PREVIEW'] === '1';
if (preview) { app.commandLine.appendSwitch('no-sandbox'); app.disableHardwareAcceleration(); }

let window: BrowserWindow | null = null;
let service: DesktopService | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
let closing = false;
let closed = false;

async function createWindow(): Promise<void> {
  window = new BrowserWindow({
    title: 'OS Agent Next', width: 1220, height: 820, minWidth: 860, minHeight: 620,
    show: false, backgroundColor: '#f7f8fb',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    webPreferences: { preload: join(currentDirectory, '../preload/index.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: !preview },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.once('ready-to-show', () => window?.show());
  window.once('closed', () => { window = null; });
  const developmentUrl = process.env['ELECTRON_RENDERER_URL'];
  if (developmentUrl) await window.loadURL(developmentUrl);
  else await window.loadFile(join(currentDirectory, '../renderer/index.html'));
}

const commandSchema = z.object({ method: z.enum([
  'snapshot', 'create', 'createGroup', 'chooseWorkspace', 'send', 'markRead', 'control', 'approve', 'reconcile', 'saveModel',
  'memorySummary', 'searchHistory', 'readHistory', 'contactNotes', 'saveNote', 'listModels',
]), args: z.array(z.unknown()).max(4) }).strict();

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  void app.whenReady().then(async () => {
    service = new DesktopService(dataDirectory, {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (value) => safeStorage.encryptString(value).toString('base64'),
      decrypt: (value) => safeStorage.decryptString(Buffer.from(value, 'base64')),
    }, {
      ...(process.env['MINIMAX_API_KEY'] ? { minimax: process.env['MINIMAX_API_KEY'] } : {}),
      ...(process.env['DEEPSEEK_API_KEY'] ? { deepseek: process.env['DEEPSEEK_API_KEY'] } : {}),
    });
    await service.initialize();
    ipcMain.handle(CHANNEL, async (event, value: unknown) => {
      if (closing || !service || event.sender !== window?.webContents || event.senderFrame !== event.sender.mainFrame) {
        throw new Error('请求来源无效或应用正在关闭。');
      }
      try {
        const { method, args } = commandSchema.parse(value);
        switch (method) {
          case 'snapshot': return service.snapshot(args[0]);
          case 'create': return await service.create(args[0]);
          case 'createGroup': return service.createGroup(args[0]);
          case 'send': return service.send(args[0], args[1], args[2], args[3]);
          case 'markRead': return service.markRead(args[0]);
          case 'control': return await service.control(args[0], args[1]);
          case 'approve': return service.approve(args[0], args[1], args[2]);
          case 'reconcile': return service.reconcile(args[0], args[1], args[2], args[3]);
          case 'saveModel': return service.saveModel(args[0]);
          case 'listModels': return await service.listModels(args[0]);
          case 'memorySummary': return service.memorySummary(args[0], args[1]);
          case 'searchHistory': return service.searchHistory(args[0], args[1]);
          case 'readHistory': return service.readHistory(args[0], args[1]);
          case 'contactNotes': return service.contactNotes(args[0]);
          case 'saveNote': return service.saveNote(args[0]);
          case 'chooseWorkspace': {
            const selection = await dialog.showOpenDialog(window!, {
              title: '选择 Agent 可以访问的工作区', properties: ['openDirectory'],
            });
            return selection.canceled || !selection.filePaths[0] ? null
              : await service.registerWorkspace(selection.filePaths[0]);
          }
        }
      } catch (error) {
        if (error instanceof z.ZodError) {
          const capacityIssues = error.issues.filter((issue) => issue.path[0] === 'tokens' && issue.code === 'custom');
          throw new Error(capacityIssues.length ? capacityIssues.map((issue) => issue.message).join(' ')
            : '输入无效，请检查必填内容、整数及长度。');
        }
        throw error;
      }
    });
    await createWindow();
    // 调度状态可能在最后一个事件后改变，刷新提示保证窗口最终与核心一致。
    timer = setInterval(() => { if (window && !window.isDestroyed()) window.webContents.send(CHANGED); }, 500);
    app.on('activate', () => { if (!window && !closing) void createWindow(); });
  }).catch(async () => {
    dialog.showErrorBox('OS Agent Next 启动失败', '无法恢复桌面数据。请确认没有另一实例占用数据目录，并检查工作区目录是否仍存在。原数据已保留。');
    app.quit();
  });
}
app.on('before-quit', (event) => {
  if (closed) return;
  event.preventDefault();
  if (closing) return;
  closing = true;
  clearInterval(timer);
  void service?.close().finally(() => { closed = true; app.quit(); });
  if (!service) { closed = true; app.quit(); }
});
app.on('window-all-closed', () => { app.quit(); });
