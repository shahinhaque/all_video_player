import { describe, it, expect, vi } from 'vitest';
import { AdaptiveChunkManager, PrefetchedByteSource } from '../src/lib/network.js';
import { RangeByteSource } from '../src/core/types.js';
import { readAll } from '../src/lib/util.js';

describe('Network & Adaptive Streaming', () => {
  it('dynamically adapts chunk size based on observed throughput', () => {
    const manager = new AdaptiveChunkManager(2 * 1024 * 1024);
    expect(manager.chunkSize).toBe(2 * 1024 * 1024);

    // Fast connection: 10 MB downloaded in 500ms (20 MB/s)
    manager.recordSample(10 * 1024 * 1024, 500);
    // Should scale up to maximum chunk size (4 MB)
    expect(manager.chunkSize).toBe(4 * 1024 * 1024);

    // Slow connection: 200 KB downloaded in 1000ms (200 KB/s)
    manager.recordSample(200 * 1024, 1000);
    // Should scale down to minimum chunk size (512 KB)
    expect(manager.chunkSize).toBe(512 * 1024);
  });

  it('aligns chunk size to MPEG-TS 188-byte packet boundary', () => {
    const manager = new AdaptiveChunkManager(2 * 1024 * 1024);
    const aligned = manager.getAlignedChunkSize(188);
    expect(aligned % 188).toBe(0);
    expect(aligned).toBe(11155 * 188); // 2,097,140 bytes
  });

  it('respects custom min and max chunk bounds', () => {
    const manager = new AdaptiveChunkManager(1024 * 1024, 256 * 1024, 2 * 1024 * 1024);
    expect(manager.chunkSize).toBe(1024 * 1024);

    // Very fast connection
    manager.recordSample(50 * 1024 * 1024, 500);
    expect(manager.chunkSize).toBe(2 * 1024 * 1024); // Capped at custom max

    // Very slow connection
    manager.recordSample(50 * 1024, 2000);
    expect(manager.chunkSize).toBe(256 * 1024); // Floor at custom min
  });

  it('PrefetchedByteSource serves initial ranges instantly from memory without network read', async () => {
    const mockData = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    const underlyingRead = vi.fn();
    const mockUnderlying: RangeByteSource = {
      name: 'video.mp4',
      size: 100,
      encrypted: false,
      read: underlyingRead,
    };

    const prefetchedBuf = mockData.subarray(0, 5); // [10, 20, 30, 40, 50]
    const source = new PrefetchedByteSource(mockUnderlying, 0, prefetchedBuf);

    // Read within prefetched range [0, 2] -> should get [10, 20, 30] without hitting underlying
    const stream1 = await source.read(0, 2);
    const res1 = await readAll(stream1);
    expect(Array.from(res1)).toEqual([10, 20, 30]);
    expect(underlyingRead).not.toHaveBeenCalled();

    // Read outside prefetched range [5, 9] -> should delegate to underlying
    const remainingSlice = mockData.subarray(5, 10);
    underlyingRead.mockResolvedValueOnce(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(remainingSlice);
          controller.close();
        },
      })
    );

    const stream2 = await source.read(5, 9);
    const res2 = await readAll(stream2);
    expect(Array.from(res2)).toEqual([60, 70, 80, 90, 100]);
    expect(underlyingRead).toHaveBeenCalledWith(5, 9, undefined);
  });
});

