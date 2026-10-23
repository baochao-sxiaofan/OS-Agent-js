import type { ContextCheckpoint, ContextReceipt, ContextRecord, ContextStore, ContextStoreWrite } from '../management.js';
import { requireContext } from '../internal/validation.js';

/** 单进程测试和演示用存储；替换内部集合后才对外发布事务结果。 */
export class InMemoryContextStore implements ContextStore {
  #states = new Map<string, ContextCheckpoint>();
  #records = new Map<string, ContextRecord>();
  #receipts = new Map<string, ContextReceipt>();

  load(key: string): ContextCheckpoint | undefined { return structuredClone(this.#states.get(key)); }
  read(key: string, ref: string): ContextRecord | undefined {
    return structuredClone(this.#records.get(JSON.stringify([key, ref])));
  }
  receipt(key: string, id: string): ContextReceipt | undefined {
    return structuredClone(this.#receipts.get(JSON.stringify([key, id])));
  }

  commit(key: string, expectedRevision: number | null, checkpoint: ContextCheckpoint,
    writes: readonly ContextStoreWrite[], receipts: readonly ContextReceipt[]): void {
    requireContext((this.#states.get(key)?.revision ?? null) === expectedRevision,
      '检查点版本冲突，请从存储重新恢复。', 'storage_conflict');
    requireContext(checkpoint.revision === (expectedRevision === null ? 0 : expectedRevision + 1),
      '检查点版本必须逐次递增。', 'storage_conflict');
    const records = new Map(this.#records);
    const results = new Map(this.#receipts);
    for (const write of writes) {
      const storageKey = JSON.stringify([key, write.ref]);
      requireContext(!records.has(storageKey), '历史引用已存在，不能覆盖。', 'storage_conflict');
      records.set(storageKey, structuredClone(write.record));
    }
    for (const receipt of receipts) {
      const storageKey = JSON.stringify([key, receipt.key]);
      requireContext(!results.has(storageKey), '轮次已经提交。', 'storage_conflict');
      results.set(storageKey, structuredClone(receipt));
    }
    const state = structuredClone(checkpoint);
    this.#records = records;
    this.#receipts = results;
    this.#states.set(key, state);
  }
}
