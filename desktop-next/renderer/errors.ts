export function errorMessage(reason: unknown): string {
  return reason instanceof Error
    ? reason.message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/u, '')
    : '操作失败，请重试。';
}
