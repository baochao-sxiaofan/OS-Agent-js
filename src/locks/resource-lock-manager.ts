import type { ResourceScope } from '../capability/capability.js';

export type ResourceLockRequest = {
  scope: ResourceScope;
  mode: 'exclusive';
};

export type ResourceLockSnapshot = {
  leaseId: string;
  ownerTaskId: string;
  requests: ResourceLockRequest[];
  acquiredAt: number;
};

export class ResourceLockLease {
  #released = false;
  readonly #release: () => void;

  constructor(
    readonly snapshot: ResourceLockSnapshot,
    release: () => void,
  ) {
    this.#release = release;
  }

  close(): void {
    if (this.#released) {
      return;
    }
    this.#released = true;
    this.#release();
  }
}

type PendingLock = {
  leaseId: string;
  ownerTaskId: string;
  requests: ResourceLockRequest[];
  signal?: AbortSignal;
  resolve: (lease: ResourceLockLease) => void;
  reject: (error: Error) => void;
};

/**
 * Fair, atomic resource lock manager.
 *
 * A request acquires all scopes together or waits without holding any of them,
 * avoiding lock-order deadlocks. Locks are process-local leases: after a crash
 * no stale lease survives, while durable task state is recovered normally.
 */
export class ResourceLockManager {
  readonly #active = new Map<string, ResourceLockSnapshot>();
  readonly #pending: PendingLock[] = [];
  #sequence = 0;

  acquire(
    ownerTaskId: string,
    requests: readonly ResourceLockRequest[],
    signal?: AbortSignal,
  ): Promise<ResourceLockLease> {
    const normalized = deduplicateRequests(requests);
    if (normalized.length === 0) {
      return Promise.resolve(
        new ResourceLockLease(
          {
            leaseId: this.nextLeaseId(),
            ownerTaskId,
            requests: [],
            acquiredAt: Date.now(),
          },
          () => undefined,
        ),
      );
    }
    if (signal?.aborted) {
      return Promise.reject(new Error('Resource lock acquisition aborted.'));
    }

    return new Promise<ResourceLockLease>((resolve, reject) => {
      const pending: PendingLock = {
        leaseId: this.nextLeaseId(),
        ownerTaskId,
        requests: normalized,
        ...(signal === undefined ? {} : { signal }),
        resolve,
        reject,
      };
      const onAbort = (): void => {
        const index = this.#pending.indexOf(pending);
        if (index >= 0) {
          this.#pending.splice(index, 1);
          reject(new Error('Resource lock acquisition aborted.'));
        }
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const originalResolve = pending.resolve;
      pending.resolve = (lease) => {
        signal?.removeEventListener('abort', onAbort);
        originalResolve(lease);
      };
      this.#pending.push(pending);
      this.drain();
    });
  }

  snapshots(): ResourceLockSnapshot[] {
    return [...this.#active.values()].map((lock) =>
      structuredClone(lock),
    );
  }

  private drain(): void {
    for (let index = 0; index < this.#pending.length; ) {
      const pending = this.#pending[index];
      if (!pending) {
        break;
      }
      if (this.conflicts(pending)) {
        index += 1;
        continue;
      }
      this.#pending.splice(index, 1);
      const snapshot: ResourceLockSnapshot = {
        leaseId: pending.leaseId,
        ownerTaskId: pending.ownerTaskId,
        requests: structuredClone(pending.requests),
        acquiredAt: Date.now(),
      };
      this.#active.set(snapshot.leaseId, snapshot);
      pending.resolve(
        new ResourceLockLease(snapshot, () => {
          this.#active.delete(snapshot.leaseId);
          this.drain();
        }),
      );
    }
  }

  private conflicts(pending: PendingLock): boolean {
    return [...this.#active.values()].some(
      (active) =>
        active.ownerTaskId !== pending.ownerTaskId &&
        active.requests.some((held) =>
          pending.requests.some((requested) =>
            scopesOverlap(held.scope, requested.scope),
          ),
        ),
    );
  }

  private nextLeaseId(): string {
    this.#sequence += 1;
    return `lock-${this.#sequence}`;
  }
}

function deduplicateRequests(
  requests: readonly ResourceLockRequest[],
): ResourceLockRequest[] {
  const unique = new Map<string, ResourceLockRequest>();
  for (const request of requests) {
    const key =
      request.scope.kind === 'all'
        ? '*'
        : `${request.scope.kind}:${request.scope.resource}`;
    unique.set(key, structuredClone(request));
  }
  return [...unique.values()].sort((left, right) =>
    scopeKey(left.scope).localeCompare(scopeKey(right.scope)),
  );
}

function scopesOverlap(left: ResourceScope, right: ResourceScope): boolean {
  if (left.kind === 'all' || right.kind === 'all') {
    return true;
  }
  if (left.kind === 'exact' && right.kind === 'exact') {
    return left.resource === right.resource;
  }
  if (left.kind === 'subtree') {
    return contains(left.resource, right.resource);
  }
  return contains(right.resource, left.resource);
}

function contains(parent: string, child: string): boolean {
  const prefix = parent.endsWith('/') ? parent : `${parent}/`;
  return child === parent || child.startsWith(prefix);
}

function scopeKey(scope: ResourceScope): string {
  return scope.kind === 'all' ? '*' : scope.resource;
}
