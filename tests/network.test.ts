import { describe, it, expect } from 'vitest';
import { AdaptiveChunkManager } from '../src/lib/network.js';

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
});
