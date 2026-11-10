/**
 * Fast Client-Side Matroska (MKV) Demuxer.
 * Extracts video, audio, and subtitle frames from EBML clusters for multi-track selection,
 * software audio decoding (E-AC-3/AC-3), and MSE fMP4 remuxing.
 */

import { RangeByteSource } from '../core/types.js';
import { readAll } from '../lib/util.js';
import {
  readEbmlElement,
  readUint,
  parseMkvHeaders,
  parseMkvBlock,
  EBML_ID,
  MkvHeaderInfo,
  TrackMetadata,
} from './ebml.js';

export interface MkvVideoChunk {
  trackNumber: number;
  timeSec: number;
  isKeyframe: boolean;
  data: Uint8Array;
  frames: Uint8Array[];
}

export interface MkvAudioChunk {
  trackNumber: number;
  timeSec: number;
  data: Uint8Array;
}

export interface MkvSubtitleCue {
  trackNumber: number;
  timeSec: number;
  durationSec: number;
  text: string;
}

const MAX_ELEMENT_SIZE = 16 * 1024 * 1024;

export class MkvDemuxer {
  private src: RangeByteSource;
  private headerInfo: MkvHeaderInfo | null = null;
  private activeVideoTrackNumber: number | null = null;
  private activeAudioTrackNumber: number | null = null;
  private activeSubtitleTrackNumber: number | null = null;

  private isAborted = false;
  private abortCtrl: AbortController = new AbortController();
  private currentByteOffset = 0;
  private firstClusterOffset = 0;
  private residualBuffer: Uint8Array = new Uint8Array(0);
  private currentClusterTimecode = 0;
  private lastDemuxedTimeSec = 0;
  private inClusterSync = false;

  private onVideoFrameCallback: ((chunk: MkvVideoChunk) => void) | null = null;
  private onAudioFrameCallback: ((chunk: MkvAudioChunk) => void) | null = null;
  private onSubtitleCueCallback: ((cue: MkvSubtitleCue) => void) | null = null;
  private cachedSubtitleCues = new Map<number, MkvSubtitleCue[]>();

  constructor(src: RangeByteSource) {
    this.src = src;
  }

  getCuesForTrack(trackNumber: number): MkvSubtitleCue[] {
    return this.cachedSubtitleCues.get(trackNumber) || [];
  }

  async parseHeaders(): Promise<MkvHeaderInfo | null> {
    const probeLen = Math.min(256 * 1024, this.src.size > 0 ? this.src.size - 1 : 256 * 1024);
    const stream = await this.src.read(0, probeLen, this.abortCtrl.signal);
    const initialBytes = await readAll(stream, this.abortCtrl.signal);

    const info = parseMkvHeaders(initialBytes);
    if (!info) return null;
    this.headerInfo = info;

    if (info.firstClusterOffset && info.firstClusterOffset > 0) {
      this.firstClusterOffset = info.firstClusterOffset;
    } else {
      // Fallback: locate the first Cluster (0x1F43B675) that is followed by a valid VINT and Timecode (0xE7)
      let off = 0;
      while (off < initialBytes.length - 12) {
        if (
          initialBytes[off] === 0x1f &&
          initialBytes[off + 1] === 0x43 &&
          initialBytes[off + 2] === 0xb6 &&
          initialBytes[off + 3] === 0x75
        ) {
          const elem = readEbmlElement(initialBytes, off);
          if (elem && elem.dataOffset < initialBytes.length && initialBytes[elem.dataOffset] === 0xe7) {
            this.firstClusterOffset = off;
            break;
          }
        }
        off++;
      }
    }

    this.currentByteOffset = this.firstClusterOffset > 0 ? this.firstClusterOffset : 0;
    return info;
  }

  get tracks(): TrackMetadata[] {
    return this.headerInfo?.tracks || [];
  }

  get timecodeScale(): number {
    return this.headerInfo?.timecodeScale || 1000000;
  }

  get duration(): number {
    return this.headerInfo?.duration || 0;
  }

  get lastTimeSec(): number {
    return this.lastDemuxedTimeSec;
  }

  get clusterStartOffset(): number {
    return this.firstClusterOffset;
  }

  setActiveVideoTrack(trackNumber: number | null): void {
    this.activeVideoTrackNumber = trackNumber;
  }

  setActiveAudioTrack(trackNumber: number | null): void {
    this.activeAudioTrackNumber = trackNumber;
  }

  setActiveSubtitleTrack(trackNumber: number | null): void {
    this.activeSubtitleTrackNumber = trackNumber;
  }

  onVideoFrame(cb: (chunk: MkvVideoChunk) => void): void {
    this.onVideoFrameCallback = cb;
  }

  onAudioFrame(cb: (chunk: MkvAudioChunk) => void): void {
    this.onAudioFrameCallback = cb;
  }

  onSubtitleCue(cb: (cue: MkvSubtitleCue) => void): void {
    this.onSubtitleCueCallback = cb;
  }

  resetResidual(): void {
    this.residualBuffer = new Uint8Array(0);
    this.inClusterSync = false;
  }

  seek(targetTimeSec: number): void {
    this.residualBuffer = new Uint8Array(0);
    this.inClusterSync = false;
    this.currentClusterTimecode = Math.floor((targetTimeSec * 1e9) / this.timecodeScale);
    this.lastDemuxedTimeSec = targetTimeSec;
    if (this.duration > 0 && this.src.size > 0 && targetTimeSec > 0) {
      const ratio = Math.min(0.99, Math.max(0, targetTimeSec / this.duration));
      const dataSpan = Math.max(0, this.src.size - this.firstClusterOffset);
      const targetByte = Math.floor(ratio * dataSpan) + this.firstClusterOffset;
      this.currentByteOffset = Math.max(this.firstClusterOffset, Math.min(targetByte, this.src.size - 1));
    } else {
      this.currentByteOffset = this.firstClusterOffset;
    }
  }

  async readNextChunk(chunkSize = 256 * 1024): Promise<boolean> {
    if (this.isAborted || (this.src.size > 0 && this.currentByteOffset >= this.src.size)) {
      return false;
    }

    const endByte = this.src.size > 0
      ? Math.min(this.currentByteOffset + chunkSize - 1, this.src.size - 1)
      : this.currentByteOffset + chunkSize - 1;

    try {
      const stream = await this.src.read(this.currentByteOffset, endByte, this.abortCtrl.signal);
      const data = await readAll(stream, this.abortCtrl.signal);
      if (data.length === 0) return false;

      this.currentByteOffset += data.length;
      this.demuxBuffer(data);
      return true;
    } catch {
      return false;
    }
  }

  public demuxBuffer(chunk: Uint8Array): void {
    let combined: Uint8Array;
    if (this.residualBuffer.length > 0) {
      if (this.residualBuffer.length > MAX_ELEMENT_SIZE) {
        // Prevent unbounded residual growth if stream had corrupted bytes
        this.residualBuffer = new Uint8Array(0);
        combined = chunk;
      } else {
        combined = new Uint8Array(this.residualBuffer.length + chunk.length);
        combined.set(this.residualBuffer, 0);
        combined.set(chunk, this.residualBuffer.length);
      }
    } else {
      combined = chunk;
    }

    let off = 0;
    const len = combined.length;

    while (off < len) {
      if (!this.inClusterSync) {
        if (off > len - 12) {
          break;
        }
        if (
          combined[off] === 0x1f &&
          combined[off + 1] === 0x43 &&
          combined[off + 2] === 0xb6 &&
          combined[off + 3] === 0x75
        ) {
          const clusterElem = readEbmlElement(combined, off);
          if (!clusterElem) {
            break;
          }
          if (clusterElem.dataOffset >= len) {
            break;
          }
          const firstChild = combined[clusterElem.dataOffset];
          if (
            firstChild === 0xe7 ||
            firstChild === 0xa7 ||
            firstChild === 0xab ||
            firstChild === 0xa3 ||
            firstChild === 0xa0 ||
            firstChild === 0xec
          ) {
            this.inClusterSync = true;
            off = clusterElem.dataOffset;
            continue;
          }
        }
        off++;
        continue;
      }

      if (off > len - 4) {
        break;
      }

      const elem = readEbmlElement(combined, off);
      if (!elem) {
        if (len - off < 12) {
          // Element header spans across chunk boundary; wait for next chunk
          break;
        }
        this.inClusterSync = false;
        off++;
        continue;
      }

      // Step into next Cluster container
      if (elem.id === EBML_ID.Cluster) {
        off = elem.dataOffset;
        continue;
      }

      // If we hit a top-level non-cluster container (e.g. Cues at end of file or Attachments)
      if (
        elem.id === EBML_ID.Attachments ||
        elem.id === EBML_ID.Chapters ||
        elem.id === EBML_ID.Tags ||
        elem.id === EBML_ID.Cues ||
        elem.id === EBML_ID.SeekHead ||
        elem.id === EBML_ID.Info ||
        elem.id === EBML_ID.Tracks
      ) {
        if (elem.dataOffset + elem.dataSize <= len) {
          off = elem.dataOffset + elem.dataSize;
          continue;
        } else {
          this.inClusterSync = false;
          off += 4;
          continue;
        }
      }

      const isKnownClusterChild =
        elem.id === EBML_ID.Timecode ||
        elem.id === EBML_ID.SimpleBlock ||
        elem.id === EBML_ID.BlockGroup ||
        elem.id === EBML_ID.Block ||
        elem.id === EBML_ID.Position ||
        elem.id === EBML_ID.PrevSize ||
        elem.id === EBML_ID.Void;

      if (!isKnownClusterChild || elem.dataSize > MAX_ELEMENT_SIZE || elem.dataSize < 0) {
        this.inClusterSync = false;
        off++;
        continue;
      }

      if (elem.id === EBML_ID.Timecode) {
        if (elem.dataSize > 8) {
          off++;
          continue;
        }
        if (elem.dataOffset + elem.dataSize > len) {
          break;
        }
        this.currentClusterTimecode = readUint(combined, elem.dataOffset, elem.dataSize);
        this.lastDemuxedTimeSec = (this.currentClusterTimecode * this.timecodeScale) / 1e9;
        off = elem.dataOffset + elem.dataSize;
        continue;
      }

      if (elem.dataOffset + elem.dataSize > len) {
        // Valid cluster child element is incomplete; keep in residualBuffer for next chunk
        break;
      }

      if (elem.id === EBML_ID.SimpleBlock || elem.id === EBML_ID.Block) {
        const payload = combined.subarray(elem.dataOffset, elem.dataOffset + elem.dataSize);
        this.processBlockPayload(payload, 3.5);
      } else if (elem.id === EBML_ID.BlockGroup) {
        let bgOff = elem.dataOffset;
        const bgEnd = elem.dataOffset + elem.dataSize;
        let blockPayload: Uint8Array | null = null;
        let blockDurationSec = 3.5;

        while (bgOff < bgEnd) {
          const sub = readEbmlElement(combined, bgOff);
          if (!sub || sub.dataOffset + sub.dataSize > bgEnd) break;
          if (sub.id === EBML_ID.Block) {
            blockPayload = combined.subarray(sub.dataOffset, sub.dataOffset + sub.dataSize);
          } else if (sub.id === EBML_ID.BlockDuration) {
            const rawDur = readUint(combined, sub.dataOffset, sub.dataSize);
            if (rawDur > 0) {
              blockDurationSec = (rawDur * this.timecodeScale) / 1e9;
            }
          }
          bgOff = sub.dataOffset + sub.dataSize;
        }

        if (blockPayload) {
          this.processBlockPayload(blockPayload, blockDurationSec);
        }
      }

      off = elem.dataOffset + elem.dataSize;
    }

    this.residualBuffer = off < len ? combined.slice(off) : new Uint8Array(0);
  }

  private processBlockPayload(payload: Uint8Array, durationSec: number): void {
    const block = parseMkvBlock(payload);
    if (!block) return;

    const timeSec = ((this.currentClusterTimecode + block.timecode) * this.timecodeScale) / 1e9;
    if (timeSec >= 0) {
      this.lastDemuxedTimeSec = timeSec;
    }

    if (this.activeVideoTrackNumber != null && block.trackNumber === this.activeVideoTrackNumber) {
      this.onVideoFrameCallback?.({
        trackNumber: block.trackNumber,
        timeSec,
        isKeyframe: block.isKeyframe,
        data: block.data,
        frames: block.frames,
      });
    }

    if (this.activeAudioTrackNumber != null && block.trackNumber === this.activeAudioTrackNumber) {
      const audioTrackMeta = this.tracks.find((t) => t.trackNumber === block.trackNumber);
      const sr = audioTrackMeta?.samplingRate || 48000;
      const isAac = (audioTrackMeta?.codecId || '').toUpperCase().includes('AAC');
      const frameDur = isAac ? 1024 / sr : 1536 / sr;

      for (let i = 0; i < block.frames.length; i++) {
        this.onAudioFrameCallback?.({
          trackNumber: block.trackNumber,
          timeSec: timeSec + i * frameDur,
          data: block.frames[i],
        });
      }
    }

    const trackMeta = this.tracks.find((t) => t.trackNumber === block.trackNumber);
    const isSubTrack =
      (trackMeta && trackMeta.trackType === 'subtitle') ||
      (this.activeSubtitleTrackNumber != null && block.trackNumber === this.activeSubtitleTrackNumber);

    if (isSubTrack) {
      try {
        let text = new TextDecoder('utf-8').decode(block.data).trim();
        if (text) {
          if (trackMeta && (trackMeta.codecId.includes('ASS') || trackMeta.codecId.includes('SSA'))) {
            let commaCount = 0;
            let idx = 0;
            while (idx < text.length && commaCount < 8) {
              if (text[idx] === ',') commaCount++;
              idx++;
            }
            if (commaCount >= 8) {
              text = text.substring(idx);
            }
          }
          text = text.replace(/\{[^}]*\}/g, '').replace(/\\N/g, '\n').replace(/\\n/g, '\n').replace(/\\h/g, ' ').trim();
          if (text) {
            const cue: MkvSubtitleCue = {
              trackNumber: block.trackNumber,
              timeSec,
              durationSec: durationSec || 3.5,
              text,
            };
            let list = this.cachedSubtitleCues.get(block.trackNumber);
            if (!list) {
              list = [];
              this.cachedSubtitleCues.set(block.trackNumber, list);
            }
            if (!list.some((c) => Math.abs(c.timeSec - timeSec) < 0.05 && c.text === text)) {
              list.push(cue);
            }
            if (this.activeSubtitleTrackNumber === block.trackNumber) {
              this.onSubtitleCueCallback?.(cue);
            }
          }
        }
      } catch {}
    }
  }

  destroy(): void {
    this.isAborted = true;
    this.abortCtrl.abort();
    this.onVideoFrameCallback = null;
    this.onAudioFrameCallback = null;
    this.onSubtitleCueCallback = null;
  }
}
