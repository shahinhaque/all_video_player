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
 * Common Matroska EBML Element IDs.
 */
export const EBML_ID = {
  EBML: 0x1a45dfa3,
  DocType: 0x4282,
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  VideoSettings: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  AudioSettings: 0xe1,
  SamplingFrequency: 0xb5,
  Channels: 0x9f,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
} as const;

export interface TrackMetadata {
  trackNumber: number;
  trackType: 'video' | 'audio' | 'unknown';
  codecId: string;
  codecPrivate?: Uint8Array;
  width?: number;
  height?: number;
  channels?: number;
  samplingRate?: number;
}

export interface MkvHeaderInfo {
  timecodeScale: number; // in nanoseconds, default 1,000,000 ns = 1 ms
  duration: number; // in seconds
  tracks: TrackMetadata[];
}

/**
 * Scans an initial buffer of an MKV file to parse Tracks and Info headers.
 */
export function parseMkvHeaders(data: Uint8Array): MkvHeaderInfo | null {
  let offset = 0;
  const len = data.length;

  let timecodeScale = 1000000;
  let duration = 0;
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
      offset = elem.dataOffset;
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
          let trackType: 'video' | 'audio' | 'unknown' = 'unknown';
          let codecId = '';
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
      break; // Found tracks, finish header scan
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
  };
}
