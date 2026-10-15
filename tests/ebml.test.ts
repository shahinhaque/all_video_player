import { describe, it, expect } from 'vitest';
import {
  readVint,
  readElementId,
  readEbmlElement,
  readUint,
  readFloat,
  parseMkvHeaders,
  EBML_ID,
} from '../src/engines/ebml.js';

describe('EBML & Matroska Parser', () => {
  it('reads 1-byte and multi-byte VINTs accurately', () => {
    // 1-byte VINT: 0x80 | 15 = 0x8f (value 15, length 1)
    const b1 = new Uint8Array([0x8f]);
    expect(readVint(b1, 0)).toEqual({ value: 15, length: 1 });

    // 2-byte VINT: 0x40 | 1 = 0x41, followed by 0x20 -> value (1 * 256 + 32) = 288
    const b2 = new Uint8Array([0x41, 0x20]);
    expect(readVint(b2, 0)).toEqual({ value: 288, length: 2 });
  });

  it('reads Element IDs correctly', () => {
    // EBML Header ID: 0x1A45DFA3
    const ebmlHeader = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]);
    const res = readElementId(ebmlHeader, 0);
    expect(res).not.toBeNull();
    expect(res?.id).toBe(0x1a45dfa3);
    expect(res?.length).toBe(4);
  });

  it('reads full EBML element header correctly', () => {
    // Element ID 0x1A45DFA3 + Size 1-byte VINT 0x85 (5 bytes)
    const elem = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x85, 0x01, 0x02, 0x03, 0x04, 0x05]);
    const parsed = readEbmlElement(elem, 0);
    expect(parsed).toEqual({
      id: 0x1a45dfa3,
      dataOffset: 5,
      dataSize: 5,
      totalSize: 10,
    });
  });

  it('reads integer and float values accurately', () => {
    const uintBytes = new Uint8Array([0x01, 0x02, 0x03]);
    expect(readUint(uintBytes, 0, 3)).toBe((1 << 16) | (2 << 8) | 3);

    const floatBytes = new Uint8Array(4);
    new DataView(floatBytes.buffer).setFloat32(0, 123.45, false);
    expect(readFloat(floatBytes, 0, 4)).toBeCloseTo(123.45, 1);
  });

  it('parses Matroska track entries from synthetic EBML payload', () => {
    // Construct a minimal synthetic EBML stream: Segment -> Tracks -> TrackEntry (Video)
    const parts: number[] = [];

    function pushVint(val: number, len: number) {
      if (len === 1) parts.push(0x80 | val);
      else if (len === 2) parts.push(0x40 | (val >> 8), val & 0xff);
      else if (len === 4) {
        parts.push(0x10 | (val >> 24), (val >> 16) & 0xff, (val >> 8) & 0xff, val & 0xff);
      }
    }

    function pushId(id: number) {
      if (id > 0xffffff) {
        parts.push((id >> 24) & 0xff, (id >> 16) & 0xff, (id >> 8) & 0xff, id & 0xff);
      } else if (id > 0xffff) {
        parts.push((id >> 16) & 0xff, (id >> 8) & 0xff, id & 0xff);
      } else if (id > 0xff) {
        parts.push((id >> 8) & 0xff, id & 0xff);
      } else {
        parts.push(id & 0xff);
      }
    }

    // Segment
    pushId(EBML_ID.Segment);
    pushVint(100, 4); // Size 100

    // Tracks element
    pushId(EBML_ID.Tracks);
    pushVint(80, 2);

    // TrackEntry
    pushId(EBML_ID.TrackEntry);
    pushVint(70, 1);

    // TrackNumber: 1
    pushId(EBML_ID.TrackNumber);
    pushVint(1, 1);
    parts.push(1);

    // TrackType: 1 (Video)
    pushId(EBML_ID.TrackType);
    pushVint(1, 1);
    parts.push(1);

    // CodecID: "V_MPEG4/ISO/AVC"
    const codecStr = 'V_MPEG4/ISO/AVC';
    pushId(EBML_ID.CodecID);
    pushVint(codecStr.length, 1);
    for (let i = 0; i < codecStr.length; i++) parts.push(codecStr.charCodeAt(i));

    // VideoSettings
    pushId(EBML_ID.VideoSettings);
    pushVint(10, 1);
    // PixelWidth: 1920
    pushId(EBML_ID.PixelWidth);
    pushVint(2, 1);
    parts.push(1920 >> 8, 1920 & 0xff);
    // PixelHeight: 1080
    pushId(EBML_ID.PixelHeight);
    pushVint(2, 1);
    parts.push(1080 >> 8, 1080 & 0xff);

    const buffer = new Uint8Array(parts);
    const info = parseMkvHeaders(buffer);

    expect(info).not.toBeNull();
    expect(info?.tracks).toHaveLength(1);
    expect(info?.tracks[0].trackType).toBe('video');
    expect(info?.tracks[0].codecId).toBe('V_MPEG4/ISO/AVC');
    expect(info?.tracks[0].width).toBe(1920);
    expect(info?.tracks[0].height).toBe(1080);
  });
});
