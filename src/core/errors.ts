export type ErrorKind =
  | 'network'
  | 'quota'
  | 'codec'
  | 'auth'
  | 'notfound'
  | 'unsupported'
  | 'permission'
  | 'aborted'
  | 'unknown';

export class PlayerError extends Error {
  constructor(
    public readonly kind: ErrorKind,
    message: string,
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'PlayerError';
  }
}

export function isAbort(e: unknown): boolean {
  return (
    (e instanceof DOMException && e.name === 'AbortError') ||
    (e instanceof PlayerError && e.kind === 'aborted') ||
    (e instanceof Error && e.name === 'AbortError')
  );
}

export function toPlayerError(e: unknown): PlayerError {
  if (e instanceof PlayerError) return e;
  if (isAbort(e)) return new PlayerError('aborted', 'Cancelled');
  if (e instanceof TypeError) return new PlayerError('network', 'Network request failed. Check your connection or extension permissions.', e);
  return new PlayerError('unknown', e instanceof Error ? e.message : String(e), e);
}
