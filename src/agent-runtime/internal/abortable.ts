/** 外部适配器即使忽略 signal，也不能阻止宿主结束等待；迟到结果不再提交。 */
export function abortable<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal?.reason ?? new Error('操作已取消。'));
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => {
      signal?.throwIfAborted();
      return work();
    }).then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort));
  });
}
