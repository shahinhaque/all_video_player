/**
 * Buffer management and sliding window eviction utilities for MediaSource SourceBuffers.
 */

export interface BufferRange {
  start: number;
  end: number;
}

/**
 * Extracts an array of start/end ranges from a DOM TimeRanges object.
 */
export function fromTimeRanges(
  ranges?: { length: number; start(index: number): number; end(index: number): number } | null
): BufferRange[] {
  if (!ranges) return [];
  const result: BufferRange[] = [];
  for (let i = 0; i < ranges.length; i++) {
    const s = ranges.start(i);
    const e = ranges.end(i);
    if (Number.isFinite(s) && Number.isFinite(e) && e > s) {
      result.push({ start: s, end: e });
    }
  }
  return result;
}

/**
 * Calculates buffer ranges that should be evicted via SourceBuffer.remove(start, end)
 * to maintain a bounded memory sliding window around currentTime.
 *
 * @param currentTime Current playback position in seconds.
 * @param ranges Currently buffered ranges.
 * @param backLimit Number of seconds to keep behind currentTime (default 30s).
 * @param forwardLimit Number of seconds to keep ahead of currentTime (default 90s).
 * @param minEvictionDuration Minimum duration in seconds of a range to evict, avoiding MSE remove thrashing.
 * @returns Array of [start, end] tuples to be evicted.
 */
export function calculateEvictionRanges(
  currentTime: number,
  ranges: BufferRange[],
  backLimit = 30,
  forwardLimit = 90,
  minEvictionDuration = 2
): [number, number][] {
  const evictions: [number, number][] = [];
  const retainStart = Math.max(0, currentTime - backLimit);
  const retainEnd = Math.max(retainStart, currentTime + forwardLimit);

  for (const r of ranges) {
    if (r.end <= r.start) continue;

    // Past buffer eviction (segments behind retainStart)
    if (r.end <= retainStart) {
      if (r.end - r.start >= minEvictionDuration) {
        evictions.push([r.start, r.end]);
      }
    } else if (r.start < retainStart) {
      if (retainStart - r.start >= minEvictionDuration) {
        evictions.push([r.start, retainStart]);
      }
    }

    // Future buffer eviction (segments ahead of retainEnd, e.g. after seeking back)
    if (r.start >= retainEnd) {
      if (r.end - r.start >= minEvictionDuration) {
        evictions.push([r.start, r.end]);
      }
    } else if (r.end > retainEnd) {
      if (r.end - retainEnd >= minEvictionDuration) {
        evictions.push([retainEnd, r.end]);
      }
    }
  }

  return evictions;
}
