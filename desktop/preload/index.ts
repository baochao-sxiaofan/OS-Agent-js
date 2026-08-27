import { contextBridge, ipcRenderer } from 'electron';

import {
  IPC_CHANNELS,
  type DesktopApi,
  type RuntimeSnapshotView,
} from '../shared/contracts.js';

const api: DesktopApi = {
  getSnapshot: async () =>
    await ipcRenderer.invoke(IPC_CHANNELS.getSnapshot),
  getModelSettings: async () =>
    await ipcRenderer.invoke(IPC_CHANNELS.getModelSettings),
  discoverModels: async (input) =>
    await ipcRenderer.invoke(IPC_CHANNELS.discoverModels, input),
  createConversation: async () =>
    await ipcRenderer.invoke(IPC_CHANNELS.createConversation),
  selectWorkspace: async (conversationId) =>
    await ipcRenderer.invoke(
      IPC_CHANNELS.selectWorkspace,
      conversationId,
    ),
  saveModelSettings: async (input) =>
    await ipcRenderer.invoke(IPC_CHANNELS.saveModelSettings, input),
  submitTask: async (input) =>
    await ipcRenderer.invoke(IPC_CHANNELS.submitTask, input),
  cancelTask: async (taskId) =>
    await ipcRenderer.invoke(IPC_CHANNELS.cancelTask, taskId),
  onSnapshotChanged: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      snapshot: RuntimeSnapshotView,
    ) => {
      listener(snapshot);
    };
    ipcRenderer.on(IPC_CHANNELS.snapshotChanged, handler);
    return () => {
      ipcRenderer.removeListener(
        IPC_CHANNELS.snapshotChanged,
        handler,
      );
    };
  },
};

contextBridge.exposeInMainWorld('osAgent', api);
