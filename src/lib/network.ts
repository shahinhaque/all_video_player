import { PlayerError } from '../core/errors.js';
import { RangeByteSource } from '../core/types.js';
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
 * Scales chunk size dynamically between min and max bounds to optimize streaming latency vs throughput.
 */
export class AdaptiveChunkManager {
  private currentChunkSize: number;
  private minChunkSize: number;
  private maxChunkSize: number;

  constructor(
    initialSize = 2 * 1024 * 1024,
    minChunkSize = 512 * 1024,
    maxChunkSize = 4 * 1024 * 1024
  ) {
    this.minChunkSize = minChunkSize;
    this.maxChunkSize = maxChunkSize;
    this.currentChunkSize = Math.max(minChunkSize, Math.min(maxChunkSize, initialSize));
  }

  get chunkSize(): number {
    return this.currentChunkSize;
  }

  /**
   * Returns current chunk size aligned down to the given packet alignment (e.g. 188 for MPEG-TS).
   */
  getAlignedChunkSize(alignment = 188): number {
    if (alignment <= 1) return this.currentChunkSize;
    const count = Math.max(1, Math.floor(this.currentChunkSize / alignment));
    return count * alignment;
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

/**
 * Wraps a RangeByteSource with a pre-buffered initial byte range to allow
 * zero-latency instant start when transitioning between playlist items.
 */
export class PrefetchedByteSource implements RangeByteSource {
  private underlying: RangeByteSource;
  private prefetchedBuffer: Uint8Array;
  private prefetchedStart: number;
  private prefetchedEnd: number;

  constructor(underlying: RangeByteSource, prefetchedStart: number, prefetchedBuffer: Uint8Array) {
    this.underlying = underlying;
    this.prefetchedStart = prefetchedStart;
    this.prefetchedBuffer = prefetchedBuffer;
    this.prefetchedEnd = prefetchedStart + prefetchedBuffer.byteLength;
  }

  get size(): number {
    return this.underlying.size;
  }

  get name(): string {
    return this.underlying.name;
  }

  get mime(): string | undefined {
    return this.underlying.mime;
  }

  get directUrl(): string | undefined {
    return this.underlying.directUrl;
  }

  get encrypted(): boolean {
    return this.underlying.encrypted;
  }

  refresh(): Promise<string> {
    if (this.underlying.refresh) {
      return this.underlying.refresh();
    }
    return Promise.resolve(this.underlying.directUrl || '');
  }

  async read(start: number, end: number, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    // If the requested range falls completely within the prefetched memory buffer
    if (start >= this.prefetchedStart && end < this.prefetchedEnd) {
      const sliceStart = start - this.prefetchedStart;
      const sliceEnd = end - this.prefetchedStart + 1;
      const slice = this.prefetchedBuffer.subarray(sliceStart, sliceEnd);
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(slice);
          controller.close();
        },
      });
    }

    // If start is within prefetched buffer but end continues past it
    if (start >= this.prefetchedStart && start < this.prefetchedEnd && end >= this.prefetchedEnd) {
      const sliceStart = start - this.prefetchedStart;
      const initialChunk = this.prefetchedBuffer.subarray(sliceStart);
      const remainingStream = await this.underlying.read(this.prefetchedEnd, end, signal);
      const reader = remainingStream.getReader();

      return new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(initialChunk);
          try {
            while (true) {
              if (signal?.aborted) {
                controller.error(new DOMException('Aborted', 'AbortError'));
                break;
              }
              const { done, value } = await reader.read();
              if (done) break;
              controller.enqueue(value);
            }
            controller.close();
          } catch (err) {
            controller.error(err);
          } finally {
            reader.releaseLock();
          }
        },
      });
    }

    // Outside the prefetched range -> delegate directly to underlying source
    return this.underlying.read(start, end, signal);
  }
}

