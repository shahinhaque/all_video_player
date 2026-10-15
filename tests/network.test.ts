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
});
