import { PlayerError } from '../core/errors.js';
import { sleep } from './util.js';

export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
  signal?: AbortSignal;
}

/**
 * Fetch wrapper that automatically retries on transient network errors or rate limits (HTTP 429, 503).
 */
export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  options: RetryOptions = {}
): Promise<Response> {
  const maxRetries = options.maxRetries ?? 3;
  let delay = options.initialDelayMs ?? 300;
  const maxDelay = options.maxDelayMs ?? 4000;
  const factor = options.backoffFactor ?? 2;
  const signal = (options.signal || init?.signal) ?? undefined;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    try {
      const res = await fetch(url, { ...init, signal });

      // If server returns rate limit or temporary server overload, backoff and retry
      if ((res.status === 429 || res.status === 503 || res.status === 502) && attempt < maxRetries) {
        await sleep(delay, signal);
        delay = Math.min(delay * factor, maxDelay);
        continue;
      }

      return res;
    } catch (err) {
      lastError = err;
      if (signal?.aborted) throw err;
      if (attempt === maxRetries) break;

      await sleep(delay, signal);
      delay = Math.min(delay * factor, maxDelay);
    }
  }

  throw new PlayerError(
    'network',
    `Network request failed after ${maxRetries} retries: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    lastError
  );
}

/**
 * Throughput-based adaptive chunk size calculator.
 * Scales chunk size dynamically between 512 KB and 4 MB to optimize streaming latency vs throughput.
 */
export class AdaptiveChunkManager {
  private currentChunkSize: number;
  private minChunkSize = 512 * 1024; // 512 KB
  private maxChunkSize = 4 * 1024 * 1024; // 4 MB

  constructor(initialSize = 2 * 1024 * 1024) {
    this.currentChunkSize = initialSize;
  }

  get chunkSize(): number {
    return this.currentChunkSize;
  }

  recordSample(bytes: number, durationMs: number): void {
    if (durationMs <= 0 || bytes <= 0) return;
    const bytesPerSec = (bytes / durationMs) * 1000;

    // Aim for each chunk to take roughly 400ms - 800ms to download
    const targetChunk = Math.round(bytesPerSec * 0.6);
    this.currentChunkSize = Math.max(
      this.minChunkSize,
      Math.min(this.maxChunkSize, Math.round(targetChunk / (64 * 1024)) * 64 * 1024)
    );
  }
}
