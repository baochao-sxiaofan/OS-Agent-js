import {
  mkdir,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises';
import { dirname } from 'node:path';

import { safeStorage } from 'electron';

import type {
  ModelSettingsView,
  ProviderId,
} from '../shared/contracts.js';
import type { ConfiguredProvider } from './provider-registry.js';

type StoredModelSettings = {
  version: 1;
  providerId: ProviderId;
  modelId: string;
  workspaceId?: string;
  encryptedApiKey: string;
};

export class ModelSettingsStore {
  #settings: ConfiguredProvider | undefined;

  constructor(readonly filePath: string) {}

  async load(environmentApiKey?: string): Promise<ConfiguredProvider | undefined> {
    try {
      const stored = JSON.parse(
        await readFile(this.filePath, 'utf8'),
      ) as StoredModelSettings;
      const apiKey = this.decryptApiKey(stored.encryptedApiKey);
      if (apiKey) {
        this.#settings = {
          providerId: stored.providerId,
          modelId: stored.modelId,
          apiKey,
          ...(stored.workspaceId === undefined
            ? {}
            : { workspaceId: stored.workspaceId }),
        };
      }
    } catch (error) {
      if (!isMissingFile(error)) {
        console.error('Unable to load encrypted model settings.');
      }
    }

    if (!this.#settings && environmentApiKey?.trim()) {
      this.#settings = {
        providerId: 'gemini',
        modelId:
          process.env['GEMINI_MODEL'] ?? 'gemini-3.5-flash-lite',
        apiKey: environmentApiKey.trim(),
      };
    }
    return this.current();
  }

  current(): ConfiguredProvider | undefined {
    return this.#settings ? { ...this.#settings } : undefined;
  }

  credentialFor(
    providerId: ProviderId,
  ): Pick<ConfiguredProvider, 'apiKey' | 'workspaceId'> | undefined {
    if (this.#settings?.providerId !== providerId) {
      return undefined;
    }
    return {
      apiKey: this.#settings.apiKey,
      ...(this.#settings.workspaceId === undefined
        ? {}
        : { workspaceId: this.#settings.workspaceId }),
    };
  }

  view(runtimeBusy: boolean): ModelSettingsView {
    return {
      ...(this.#settings === undefined
        ? {}
        : {
            providerId: this.#settings.providerId,
            modelId: this.#settings.modelId,
          }),
      hasApiKey: this.#settings !== undefined,
      secureStorageAvailable: safeStorage.isEncryptionAvailable(),
      runtimeBusy,
    };
  }

  async save(settings: ConfiguredProvider): Promise<void> {
    this.#settings = { ...settings };
    if (!safeStorage.isEncryptionAvailable()) {
      return;
    }

    const stored: StoredModelSettings = {
      version: 1,
      providerId: settings.providerId,
      modelId: settings.modelId,
      encryptedApiKey: safeStorage
        .encryptString(settings.apiKey)
        .toString('base64'),
      ...(settings.workspaceId === undefined
        ? {}
        : { workspaceId: settings.workspaceId }),
    };
    const temporaryPath = `${this.filePath}.tmp`;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(
      temporaryPath,
      `${JSON.stringify(stored, null, 2)}\n`,
      {
        encoding: 'utf8',
        mode: 0o600,
      },
    );
    await rename(temporaryPath, this.filePath);
  }

  private decryptApiKey(encryptedApiKey: string): string | undefined {
    if (!safeStorage.isEncryptionAvailable()) {
      return undefined;
    }
    try {
      return safeStorage.decryptString(
        Buffer.from(encryptedApiKey, 'base64'),
      );
    } catch {
      console.error('Unable to decrypt stored model credentials.');
      return undefined;
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}
