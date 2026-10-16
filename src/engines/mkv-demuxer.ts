/**
 * Fast Client-Side Matroska (MKV) Demuxer.
 * Extracts audio frames and subtitle cues from EBML clusters for multi-track selection and decoding.
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

export class MkvDemuxer {
  private src: RangeByteSource;
  private headerInfo: MkvHeaderInfo | null = null;
  private activeAudioTrackNumber: number | null = null;
  private activeSubtitleTrackNumber: number | null = null;

  private isAborted = false;
  private abortCtrl: AbortController = new AbortController();
  private currentByteOffset = 0;
  private firstClusterOffset = 0;
  private residualBuffer: Uint8Array = new Uint8Array(0);
  private currentClusterTimecode = 0;

  private onAudioFrameCallback: ((chunk: MkvAudioChunk) => void) | null = null;
  private onSubtitleCueCallback: ((cue: MkvSubtitleCue) => void) | null = null;

  constructor(src: RangeByteSource) {
    this.src = src;
  }

  async parseHeaders(): Promise<MkvHeaderInfo | null> {
    const probeLen = Math.min(256 * 1024, this.src.size > 0 ? this.src.size - 1 : 256 * 1024);
    const stream = await this.src.read(0, probeLen, this.abortCtrl.signal);
    const initialBytes = await readAll(stream, this.abortCtrl.signal);

    const info = parseMkvHeaders(initialBytes);
    if (!info) return null;
    this.headerInfo = info;

    // Locate the first cluster
    let off = 0;
    while (off < initialBytes.length - 4) {
      if (
        initialBytes[off] === 0x1f &&
        initialBytes[off + 1] === 0x43 &&
        initialBytes[off + 2] === 0xb6 &&
        initialBytes[off + 3] === 0x75
      ) {
        this.firstClusterOffset = off;
        break;
      }
      off++;
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

  setActiveAudioTrack(trackNumber: number | null): void {
    this.activeAudioTrackNumber = trackNumber;
  }

  setActiveSubtitleTrack(trackNumber: number | null): void {
    this.activeSubtitleTrackNumber = trackNumber;
  }

  onAudioFrame(cb: (chunk: MkvAudioChunk) => void): void {
    this.onAudioFrameCallback = cb;
  }

  onSubtitleCue(cb: (cue: MkvSubtitleCue) => void): void {
    this.onSubtitleCueCallback = cb;
  }

  seek(targetTimeSec: number): void {
    this.residualBuffer = new Uint8Array(0);
    this.currentClusterTimecode = Math.floor(targetTimeSec * 1000);
    if (this.duration > 0 && this.src.size > 0 && targetTimeSec > 0) {
      const ratio = targetTimeSec / this.duration;
      const targetByte = Math.floor(ratio * (this.src.size - this.firstClusterOffset)) + this.firstClusterOffset;
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
    } catch (e) {
      return false;
    }
  }

  public demuxBuffer(chunk: Uint8Array): void {
    let combined: Uint8Array;
    if (this.residualBuffer.length > 0) {
      combined = new Uint8Array(this.residualBuffer.length + chunk.length);
      combined.set(this.residualBuffer, 0);
      combined.set(chunk, this.residualBuffer.length);
    } else {
      combined = chunk;
    }

    let off = 0;
    const len = combined.length;

    while (off < len) {
      if (off > len - 4) {
        break;
      }

      const elem = readEbmlElement(combined, off);
      if (!elem) {
        off++;
        continue;
      }

      if (elem.id === EBML_ID.Cluster) {
        off = elem.dataOffset;
        continue;
      }

      if (elem.id === EBML_ID.Timecode) {
        if (elem.dataOffset + elem.dataSize > len) {
          break;
        }
        this.currentClusterTimecode = readUint(combined, elem.dataOffset, elem.dataSize);
        off = elem.dataOffset + elem.dataSize;
        continue;
      }

      if (elem.dataOffset + elem.dataSize > len) {
        // Element is incomplete, leave in residualBuffer for next chunk
        break;
      }

      if (elem.id === EBML_ID.SimpleBlock || elem.id === EBML_ID.Block) {
        const payload = combined.subarray(elem.dataOffset, elem.dataOffset + elem.dataSize);
        const block = parseMkvBlock(payload);
        if (block) {
          const timeSec = ((this.currentClusterTimecode + block.timecode) * this.timecodeScale) / 1e9;

          if (this.activeAudioTrackNumber != null && block.trackNumber === this.activeAudioTrackNumber) {
            this.onAudioFrameCallback?.({
              trackNumber: block.trackNumber,
              timeSec,
              data: block.data,
            });
          }

          if (this.activeSubtitleTrackNumber != null && block.trackNumber === this.activeSubtitleTrackNumber) {
            try {
              let text = new TextDecoder('utf-8').decode(block.data).trim();
              if (text) {
                // Check if ASS/SSA format (starts with ReadOrder, Layer, Style, etc.)
                const trackMeta = this.tracks.find((t) => t.trackNumber === block.trackNumber);
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
                // Strip styling and normalize breaks
                text = text.replace(/\{[^}]*\}/g, '').replace(/\\N/g, '\n').replace(/\\n/g, '\n').replace(/\\h/g, ' ').trim();
                if (text) {
                  this.onSubtitleCueCallback?.({
                    trackNumber: block.trackNumber,
                    timeSec,
                    durationSec: 3.5,
                    text,
                  });
                }
              }
            } catch {}
          }
        }
      }

      off = elem.dataOffset + elem.dataSize;
    }

    this.residualBuffer = off < len ? combined.slice(off) : new Uint8Array(0);
  }

  destroy(): void {
    this.isAborted = true;
    this.abortCtrl.abort();
    this.onAudioFrameCallback = null;
    this.onSubtitleCueCallback = null;
  }
}
