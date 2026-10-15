import { describe, it, expect } from 'vitest';
import { calculateEvictionRanges, fromTimeRanges, BufferRange } from '../src/lib/buffer.js';

describe('Buffer Management & Eviction Window', () => {
  it('converts DOM TimeRanges like objects into BufferRange array', () => {
    const mockRanges = {
      length: 2,
      start: (i: number) => (i === 0 ? 0 : 50),
      end: (i: number) => (i === 0 ? 30 : 90),
    };
    const result = fromTimeRanges(mockRanges);
    expect(result).toEqual([
      { start: 0, end: 30 },
      { start: 50, end: 90 },
    ]);
  });

  it('handles empty or null TimeRanges gracefully', () => {
    expect(fromTimeRanges(null)).toEqual([]);
    expect(fromTimeRanges(undefined)).toEqual([]);
    expect(fromTimeRanges({ length: 0, start: () => 0, end: () => 0 })).toEqual([]);
  });

  it('does not evict when playback is within limits (< backLimit)', () => {
    // Current time at 15s, buffered 0 to 45s.
    // Retain start is 0, retain end is 105s. Nothing to evict.
    const ranges: BufferRange[] = [{ start: 0, end: 45 }];
    const evictions = calculateEvictionRanges(15, ranges, 30, 90, 2);
    expect(evictions).toEqual([]);
  });

  it('evicts buffer segments older than backLimit (currentTime - 30)', () => {
    // Current time is 60s. Buffer covers 0s to 80s.
    // Retain start is 30s (60 - 30).
    // Should evict [0, 30].
    const ranges: BufferRange[] = [{ start: 0, end: 80 }];
    const evictions = calculateEvictionRanges(60, ranges, 30, 90, 2);
    expect(evictions).toEqual([[0, 30]]);
  });

  it('evicts forward buffer segments beyond forwardLimit (currentTime + 90)', () => {
    // Current time is 10s. Buffer covers 0s to 150s (e.g. user jumped back).
    // Retain end is 100s (10 + 90).
    // Should evict [100, 150].
    const ranges: BufferRange[] = [{ start: 0, end: 150 }];
    const evictions = calculateEvictionRanges(10, ranges, 30, 90, 2);
    expect(evictions).toEqual([[100, 150]]);
  });

  it('evicts both past and forward buffer when both exceed boundaries', () => {
    // Current time is 50s. Buffer covers 0s to 180s.
    // Retain window is [20s, 140s].
    // Should evict [0, 20] and [140, 180].
    const ranges: BufferRange[] = [{ start: 0, end: 180 }];
    const evictions = calculateEvictionRanges(50, ranges, 30, 90, 2);
    expect(evictions).toEqual([
      [0, 20],
      [140, 180],
    ]);
  });

  it('evicts entire disconnected ranges that fall outside the window', () => {
    // Current time is 100s. Window: [70, 190].
    // Range 1: [10, 40] (completely in the past)
    // Range 2: [80, 120] (active playback)
    // Range 3: [220, 260] (completely in the future)
    const ranges: BufferRange[] = [
      { start: 10, end: 40 },
      { start: 80, end: 120 },
      { start: 220, end: 260 },
    ];
    const evictions = calculateEvictionRanges(100, ranges, 30, 90, 2);
    expect(evictions).toEqual([
      [10, 40],
      [220, 260],
    ]);
  });

  it('respects minEvictionDuration to prevent MSE remove thrashing', () => {
    // Current time is 31s. Range is [0, 40].
    // Retain start is 1s. Range before retainStart is [0, 1] (duration = 1s < min 2s).
    // Should NOT evict.
    const ranges: BufferRange[] = [{ start: 0, end: 40 }];
    const evictions = calculateEvictionRanges(31, ranges, 30, 90, 2);
    expect(evictions).toEqual([]);
  });
});
