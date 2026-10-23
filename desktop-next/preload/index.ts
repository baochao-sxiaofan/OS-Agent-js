import { contextBridge, ipcRenderer } from 'electron';
import { CHANNEL, CHANGED, type DesktopApi } from '../shared/contracts.js';

const call = <T>(method: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(CHANNEL, { method, args }) as Promise<T>;
const api: DesktopApi = {
  snapshot: (inspectAgentId) => call('snapshot', inspectAgentId),
  create: (input) => call('create', input),
  createGroup: (input) => call('createGroup', input),
  chooseWorkspace: () => call('chooseWorkspace'),
  send: (id, content, key, mentions) => call('send', id, content, key, mentions),
  markRead: (id) => call('markRead', id),
  control: (id, action) => call('control', id, action),
  approve: (id, operationId, allowed) => call('approve', id, operationId, allowed),
  reconcile: (id, operationId, outcome, result) => call('reconcile', id, operationId, outcome, result),
  saveModel: (input) => call('saveModel', input),
  listModels: (input) => call('listModels', input),
  memorySummary: (id, inspectAgentId) => call('memorySummary', id, inspectAgentId),
  searchHistory: (input, inspectAgentId) => call('searchHistory', input, inspectAgentId),
  readHistory: (input, inspectAgentId) => call('readHistory', input, inspectAgentId),
  contactNotes: (inspectAgentId) => call('contactNotes', inspectAgentId),
  saveNote: (input) => call('saveNote', input),
  subscribe: (listener) => {
    const handler = () => listener();
    ipcRenderer.on(CHANGED, handler);
    return () => { ipcRenderer.removeListener(CHANGED, handler); };
  },
};
contextBridge.exposeInMainWorld('agents', api);
