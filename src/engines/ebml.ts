/**
 * Lightweight EBML (Extensible Binary Meta Language) Parser for Matroska / WebM containers.
 */

export interface EbmlElement {
  id: number;
  dataOffset: number;
  dataSize: number;
  totalSize: number;
}

/**
 * Reads an EBML variable-length integer (VINT).
 * Returns the decoded value and length in bytes, or null if insufficient data.
 */
export function readVint(
  data: Uint8Array,
  offset: number
): { value: number; length: number } | null {
  if (offset >= data.length) return null;
  const first = data[offset];
  let length = 0;
  let mask = 0;

  if (first & 0x80) {
    length = 1;
    mask = 0x7f;
  } else if (first & 0x40) {
    length = 2;
    mask = 0x3f;
  } else if (first & 0x20) {
    length = 3;
    mask = 0x1f;
  } else if (first & 0x10) {
    length = 4;
    mask = 0x0f;
  } else if (first & 0x08) {
    length = 5;
    mask = 0x07;
  } else if (first & 0x04) {
    length = 6;
    mask = 0x03;
  } else if (first & 0x02) {
    length = 7;
    mask = 0x01;
  } else if (first & 0x01) {
    length = 8;
    mask = 0x00;
  } else {
    return null;
  }

  if (offset + length > data.length) return null;

  let value = first & mask;
  for (let i = 1; i < length; i++) {
    value = value * 256 + data[offset + i];
  }

  return { value, length };
}

/**
 * Reads an EBML element ID (preserves the length indicator bit).
 */
export function readElementId(
  data: Uint8Array,
  offset: number
): { id: number; length: number } | null {
  if (offset >= data.length) return null;
  const first = data[offset];
  let length = 0;

  if (first & 0x80) length = 1;
  else if (first & 0x40) length = 2;
  else if (first & 0x20) length = 3;
  else if (first & 0x10) length = 4;
  else return null;

  if (offset + length > data.length) return null;

  let id = 0;
  for (let i = 0; i < length; i++) {
    id = ((id << 8) | data[offset + i]) >>> 0;
  }

  return { id, length };
}

/**
 * Reads the next EBML element header from buffer at offset.
 */
export function readEbmlElement(
  data: Uint8Array,
  offset: number
): EbmlElement | null {
  const idInfo = readElementId(data, offset);
  if (!idInfo) return null;

  const sizeOffset = offset + idInfo.length;
  const sizeInfo = readVint(data, sizeOffset);
  if (!sizeInfo) return null;

  const headerLen = idInfo.length + sizeInfo.length;
  return {
    id: idInfo.id,
    dataOffset: offset + headerLen,
    dataSize: sizeInfo.value,
    totalSize: headerLen + sizeInfo.value,
  };
}

/**
 * Reads an unsigned integer of given byte length from data at offset.
 */
export function readUint(data: Uint8Array, offset: number, length: number): number {
  let val = 0;
  for (let i = 0; i < length; i++) {
    val = val * 256 + data[offset + i];
  }
  return val;
}

/**
 * Reads an IEEE 754 float (4-byte or 8-byte) from data at offset.
 */
export function readFloat(data: Uint8Array, offset: number, length: number): number {
  const view = new DataView(data.buffer, data.byteOffset + offset, length);
  if (length === 4) return view.getFloat32(0, false);
  if (length === 8) return view.getFloat64(0, false);
  return 0;
}

/**
 * Reads a UTF-8 string of given byte length from data at offset.
 */
export function readEbmlString(data: Uint8Array, offset: number, length: number): string {
  return new TextDecoder('utf-8')
    .decode(data.subarray(offset, offset + length))
    .replace(/\0+$/, '');
}

/**
 * Common Matroska EBML Element IDs.
 */
export const EBML_ID = {
  EBML: 0x1a45dfa3,
  DocType: 0x4282,
  Void: 0xec,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  FlagDefault: 0x88,
  FlagForced: 0x55aa,
  Name: 0x536e,
  Language: 0x22b59c,
  LanguageBCP47: 0x22b59d,
  CodecID: 0x86,
  CodecName: 0x258688,
  CodecPrivate: 0x63a2,
  VideoSettings: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  AudioSettings: 0xe1,
  SamplingFrequency: 0xb5,
  Channels: 0x9f,
  Attachments: 0x1941a469,
  Chapters: 0x1043a770,
  Tags: 0x1254c367,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  CueClusterPosition: 0xf1,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  Position: 0xa7,
  PrevSize: 0xab,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  BlockDuration: 0x9b,
} as const;

export interface TrackMetadata {
  trackNumber: number;
  trackType: 'video' | 'audio' | 'subtitle' | 'unknown';
  codecId: string;
  name?: string;
  language?: string;
  isDefault?: boolean;
  codecPrivate?: Uint8Array;
  width?: number;
  height?: number;
  channels?: number;
  samplingRate?: number;
}

export interface MkvCuePoint {
  timeSec: number;
  clusterByteOffset: number;
  trackNumber?: number;
}

export interface MkvHeaderInfo {
  timecodeScale: number; // in nanoseconds, default 1,000,000 ns = 1 ms
  duration: number; // in seconds
  tracks: TrackMetadata[];
  firstClusterOffset?: number;
  segmentDataOffset?: number;
  cuesOffset?: number;
}

/**
 * Scans an initial buffer of an MKV file to parse Tracks, Info, and SeekHead headers.
 */
export function parseMkvHeaders(data: Uint8Array): MkvHeaderInfo | null {
  let offset = 0;
  const len = data.length;

  let timecodeScale = 1000000;
  let duration = 0;
  let segmentDataOffset = 0;
  let cuesOffset: number | undefined;
  const tracks: TrackMetadata[] = [];

  while (offset < len) {
    const elem = readEbmlElement(data, offset);
    if (!elem) break;

    if (elem.id === EBML_ID.EBML) {
      offset = elem.dataOffset + elem.dataSize;
      continue;
    }

    if (elem.id === EBML_ID.Segment) {
      // Step into Segment container
      segmentDataOffset = elem.dataOffset;
      offset = elem.dataOffset;
      continue;
    }

    if (elem.id === EBML_ID.SeekHead) {
      let shOff = elem.dataOffset;
      const shEnd = Math.min(len, elem.dataOffset + elem.dataSize);
      while (shOff < shEnd) {
        const seekElem = readEbmlElement(data, shOff);
        if (!seekElem) break;
        if (seekElem.id === EBML_ID.Seek) {
          let sOff = seekElem.dataOffset;
          const sEnd = Math.min(len, seekElem.dataOffset + seekElem.dataSize);
          let seekId = 0;
          let seekPos = -1;
          while (sOff < sEnd) {
            const sub = readEbmlElement(data, sOff);
            if (!sub) break;
            if (sub.id === EBML_ID.SeekID && sub.dataOffset + sub.dataSize <= len) {
              seekId = readUint(data, sub.dataOffset, sub.dataSize);
            } else if (sub.id === EBML_ID.SeekPosition && sub.dataOffset + sub.dataSize <= len) {
              seekPos = readUint(data, sub.dataOffset, sub.dataSize);
            }
            sOff = sub.dataOffset + sub.dataSize;
          }
          if (seekId === EBML_ID.Cues && seekPos >= 0 && segmentDataOffset > 0) {
            cuesOffset = segmentDataOffset + seekPos;
          }
        }
        shOff = seekElem.dataOffset + seekElem.dataSize;
      }
      offset = elem.dataOffset + elem.dataSize;
      continue;
    }

    if (elem.id === EBML_ID.Cues) {
      cuesOffset = offset;
      offset = elem.dataOffset + elem.dataSize;
      continue;
    }

    if (elem.id === EBML_ID.Info) {
      // Parse Segment Info
      let infoOff = elem.dataOffset;
      const infoEnd = Math.min(len, elem.dataOffset + elem.dataSize);
      while (infoOff < infoEnd) {
        const sub = readEbmlElement(data, infoOff);
        if (!sub) break;
        if (sub.id === EBML_ID.TimecodeScale) {
          timecodeScale = readUint(data, sub.dataOffset, sub.dataSize);
        } else if (sub.id === EBML_ID.Duration) {
          duration = readFloat(data, sub.dataOffset, sub.dataSize);
        }
        infoOff = sub.dataOffset + sub.dataSize;
      }
      offset = elem.dataOffset + elem.dataSize;
      continue;
    }

    if (elem.id === EBML_ID.Tracks) {
      // Parse Tracks
      let trkOff = elem.dataOffset;
      const trkEnd = Math.min(len, elem.dataOffset + elem.dataSize);
      while (trkOff < trkEnd) {
        const trkElem = readEbmlElement(data, trkOff);
        if (!trkElem) break;

        if (trkElem.id === EBML_ID.TrackEntry) {
          let entryOff = trkElem.dataOffset;
          const entryEnd = Math.min(len, trkElem.dataOffset + trkElem.dataSize);

          let trackNumber = 1;
          let trackType: 'video' | 'audio' | 'subtitle' | 'unknown' = 'unknown';
          let codecId = '';
          let name: string | undefined;
          let language: string | undefined;
          let isDefault = false;
          let codecPrivate: Uint8Array | undefined;
          let width = 0;
          let height = 0;
          let channels = 2;
          let samplingRate = 44100;

          while (entryOff < entryEnd) {
            const field = readEbmlElement(data, entryOff);
            if (!field) break;

            if (field.id === EBML_ID.TrackNumber) {
              trackNumber = readUint(data, field.dataOffset, field.dataSize);
            } else if (field.id === EBML_ID.TrackType) {
              const typeNum = readUint(data, field.dataOffset, field.dataSize);
              if (typeNum === 1) trackType = 'video';
              else if (typeNum === 2) trackType = 'audio';
              else if (typeNum === 17 || typeNum === 0x11) trackType = 'subtitle';
            } else if (field.id === EBML_ID.Name) {
              name = readEbmlString(data, field.dataOffset, field.dataSize);
            } else if (field.id === EBML_ID.Language || field.id === EBML_ID.LanguageBCP47) {
              language = readEbmlString(data, field.dataOffset, field.dataSize);
            } else if (field.id === EBML_ID.FlagDefault) {
              isDefault = readUint(data, field.dataOffset, field.dataSize) === 1;
            } else if (field.id === EBML_ID.CodecID) {
              codecId = new TextDecoder('ascii').decode(
                data.subarray(field.dataOffset, field.dataOffset + field.dataSize)
              ).replace(/\0+$/, '');
            } else if (field.id === EBML_ID.CodecPrivate) {
              codecPrivate = data.slice(field.dataOffset, field.dataOffset + field.dataSize);
            } else if (field.id === EBML_ID.VideoSettings) {
              let vOff = field.dataOffset;
              const vEnd = Math.min(len, field.dataOffset + field.dataSize);
              while (vOff < vEnd) {
                const vf = readEbmlElement(data, vOff);
                if (!vf) break;
                if (vf.id === EBML_ID.PixelWidth) {
                  width = readUint(data, vf.dataOffset, vf.dataSize);
                } else if (vf.id === EBML_ID.PixelHeight) {
                  height = readUint(data, vf.dataOffset, vf.dataSize);
                }
                vOff = vf.dataOffset + vf.dataSize;
              }
            } else if (field.id === EBML_ID.AudioSettings) {
              let aOff = field.dataOffset;
              const aEnd = Math.min(len, field.dataOffset + field.dataSize);
              while (aOff < aEnd) {
                const af = readEbmlElement(data, aOff);
                if (!af) break;
                if (af.id === EBML_ID.Channels) {
                  channels = readUint(data, af.dataOffset, af.dataSize);
                } else if (af.id === EBML_ID.SamplingFrequency) {
                  samplingRate = Math.round(readFloat(data, af.dataOffset, af.dataSize));
                }
                aOff = af.dataOffset + af.dataSize;
              }
            }

            entryOff = field.dataOffset + field.dataSize;
          }

          tracks.push({
            trackNumber,
            trackType,
            codecId,
            name,
            language,
            isDefault,
            codecPrivate,
            width: width || undefined,
            height: height || undefined,
            channels: channels || undefined,
            samplingRate: samplingRate || undefined,
          });
        }

        trkOff = trkElem.dataOffset + trkElem.dataSize;
      }
      offset = elem.dataOffset + elem.dataSize;
      continue;
    }

    if (elem.id === EBML_ID.Cluster) {
      // Reached clusters; header parsing done
      break;
    }

    offset = elem.dataOffset + elem.dataSize;
  }

  if (tracks.length === 0) return null;

  // Duration in seconds (Matroska duration is scaled by timecodeScale in ns)
  const durationSec = duration > 0 ? (duration * timecodeScale) / 1000000000 : 0;

  return {
    timecodeScale,
    duration: durationSec,
    tracks,
    firstClusterOffset: offset > 0 ? offset : undefined,
    segmentDataOffset: segmentDataOffset > 0 ? segmentDataOffset : undefined,
    cuesOffset,
  };
}

/**
 * Parses a Matroska Cues (0x1C53BB6B) element buffer into sorted CuePoint entries.
 */
export function parseMkvCues(
  data: Uint8Array,
  segmentDataOffset: number,
  timecodeScale: number = 1000000
): MkvCuePoint[] {
  const cues: MkvCuePoint[] = [];
  let offset = 0;
  const len = data.length;

  // Locate Cues element header if present at or near the start of the buffer
  const root = readEbmlElement(data, 0);
  let cuesEnd = len;
  if (root && root.id === EBML_ID.Cues) {
    offset = root.dataOffset;
    cuesEnd = Math.min(len, root.dataOffset + root.dataSize);
  }

  while (offset < cuesEnd) {
    const elem = readEbmlElement(data, offset);
    if (!elem || elem.dataOffset + elem.dataSize > cuesEnd) break;

    if (elem.id === EBML_ID.CuePoint) {
      let cpOff = elem.dataOffset;
      const cpEnd = elem.dataOffset + elem.dataSize;
      let cueTime = -1;
      let clusterPos = -1;
      let trackNum: number | undefined;

      while (cpOff < cpEnd) {
        const sub = readEbmlElement(data, cpOff);
        if (!sub || sub.dataOffset + sub.dataSize > cpEnd) break;

        if (sub.id === EBML_ID.CueTime) {
          cueTime = readUint(data, sub.dataOffset, sub.dataSize);
        } else if (sub.id === EBML_ID.CueTrackPositions) {
          let trkOff = sub.dataOffset;
          const trkEnd = sub.dataOffset + sub.dataSize;
          while (trkOff < trkEnd) {
            const tf = readEbmlElement(data, trkOff);
            if (!tf || tf.dataOffset + tf.dataSize > trkEnd) break;
            if (tf.id === EBML_ID.CueClusterPosition) {
              clusterPos = readUint(data, tf.dataOffset, tf.dataSize);
            } else if (tf.id === EBML_ID.CueTrack) {
              trackNum = readUint(data, tf.dataOffset, tf.dataSize);
            }
            trkOff = tf.dataOffset + tf.dataSize;
          }
        }
        cpOff = sub.dataOffset + sub.dataSize;
      }

      if (cueTime >= 0 && clusterPos >= 0) {
        cues.push({
          timeSec: (cueTime * timecodeScale) / 1e9,
          clusterByteOffset: segmentDataOffset + clusterPos,
          trackNumber: trackNum,
        });
      }
    }

    offset = elem.dataOffset + elem.dataSize;
  }

  return cues.sort((a, b) => a.timeSec - b.timeSec);
}

export interface MkvBlock {
  trackNumber: number;
  timecode: number; // in relative cluster time units
  isKeyframe: boolean;
  data: Uint8Array;
  frames: Uint8Array[];
}

/**
 * Parses a SimpleBlock or Block element payload into trackNumber, timecode, and unlaced frame payloads.
 */
export function parseMkvBlock(payload: Uint8Array): MkvBlock | null {
  if (payload.length < 4) return null;
  const trk = readVint(payload, 0);
  if (!trk) return null;
  let offset = trk.length;
  if (offset + 3 > payload.length) return null;

  // Int16 signed big-endian relative timecode
  const timecode = (payload[offset] << 8) | payload[offset + 1];
  const signedTimecode = (timecode << 16) >> 16;
  offset += 2;

  // Flags: bit 7 = keyframe (for SimpleBlock), bits 1..2 = lacing
  const flags = payload[offset];
  const isKeyframe = (flags & 0x80) !== 0;
  const lacing = (flags & 0x06) >> 1;
  offset += 1;

  const rawRemainder = payload.subarray(offset);
  const frames: Uint8Array[] = [];

  if (lacing === 0 || offset >= payload.length) {
    frames.push(rawRemainder);
  } else {
    const numFrames = payload[offset] + 1;
    offset += 1;

    if (lacing === 2) {
      // Fixed-size lacing
      const remaining = payload.length - offset;
      const frameSize = Math.floor(remaining / numFrames);
      if (frameSize > 0) {
        for (let i = 0; i < numFrames; i++) {
          const end = i === numFrames - 1 ? payload.length : offset + frameSize;
          if (offset < end && end <= payload.length) {
            frames.push(payload.subarray(offset, end));
          }
          offset = end;
        }
      }
    } else if (lacing === 1) {
      // Xiph lacing
      const sizes: number[] = [];
      let sumSizes = 0;
      for (let i = 0; i < numFrames - 1; i++) {
        let sz = 0;
        while (offset < payload.length) {
          const b = payload[offset++];
          sz += b;
          if (b < 255) break;
        }
        sizes.push(sz);
        sumSizes += sz;
      }
      sizes.push(Math.max(0, payload.length - offset - sumSizes));
      for (const sz of sizes) {
        if (sz > 0 && offset + sz <= payload.length) {
          frames.push(payload.subarray(offset, offset + sz));
          offset += sz;
        }
      }
    } else if (lacing === 3) {
      // EBML lacing
      const sizes: number[] = [];
      let sumSizes = 0;
      const firstVint = readVint(payload, offset);
      if (firstVint) {
        offset += firstVint.length;
        let prevSize = firstVint.value;
        sizes.push(prevSize);
        sumSizes += prevSize;

        for (let i = 1; i < numFrames - 1; i++) {
          const v = readVint(payload, offset);
          if (!v) break;
          offset += v.length;
          const bias = (1 << (7 * v.length - 1)) - 1;
          const delta = v.value - bias;
          prevSize = prevSize + delta;
          sizes.push(prevSize);
          sumSizes += prevSize;
        }
        sizes.push(Math.max(0, payload.length - offset - sumSizes));
        for (const sz of sizes) {
          if (sz > 0 && offset + sz <= payload.length) {
            frames.push(payload.subarray(offset, offset + sz));
            offset += sz;
          }
        }
      }
    }

    if (frames.length === 0) {
      frames.push(rawRemainder);
    }
  }

  return {
    trackNumber: trk.value,
    timecode: signedTimecode,
    isKeyframe,
    data: frames[0] || rawRemainder,
    frames,
  };
}
