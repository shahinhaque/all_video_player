import { describe, it, expect } from 'vitest';
import {
  readVint,
  readElementId,
  readEbmlElement,
  readUint,
  readFloat,
  parseMkvHeaders,
  parseMkvBlock,
  EBML_ID,
} from '../src/engines/ebml.js';
import { MkvDemuxer, MkvSubtitleCue } from '../src/engines/mkv-demuxer.js';
import { parseAvcCodecPrivate, parseAacCodecPrivate } from '../src/engines/mkv.js';

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

  it('extracts subtitle cues and durations from Matroska BlockGroup elements', () => {
    const dummySource = {
      name: 'test.mkv',
      size: 1024,
      mime: 'video/x-matroska',
      encrypted: false,
      read: async () => new ReadableStream<Uint8Array>(),
    };
    const demuxer = new MkvDemuxer(dummySource);
    demuxer.setActiveSubtitleTrack(3);

    const receivedCues: MkvSubtitleCue[] = [];
    demuxer.onSubtitleCue((cue) => receivedCues.push(cue));

    // Build Cluster -> Timecode (1000ms) -> BlockGroup -> Block (track 3, relTime 500ms, "Hello MKV") + BlockDuration (2500ms)
    const textBytes = new TextEncoder().encode('Hello MKV');
    const blockPayload = new Uint8Array(4 + textBytes.length);
    blockPayload[0] = 0x80 | 3; // Track 3 VINT
    blockPayload[1] = (500 >> 8) & 0xff;
    blockPayload[2] = 500 & 0xff;
    blockPayload[3] = 0x00; // flags
    blockPayload.set(textBytes, 4);

    // Block element (0xA1) + 1-byte size + blockPayload
    // BlockDuration element (0x9B) + 1-byte size (0x82) + 2500 (0x09C4)
    const blockGroupContent = new Uint8Array(2 + blockPayload.length + 4);
    blockGroupContent[0] = EBML_ID.Block;
    blockGroupContent[1] = 0x80 | blockPayload.length;
    blockGroupContent.set(blockPayload, 2);
    const durOffset = 2 + blockPayload.length;
    blockGroupContent[durOffset] = EBML_ID.BlockDuration;
    blockGroupContent[durOffset + 1] = 0x82;
    blockGroupContent[durOffset + 2] = (2500 >> 8) & 0xff;
    blockGroupContent[durOffset + 3] = 2500 & 0xff;

    // Cluster (0x1F43B675) + size + Timecode (0xE7, size 2, 1000) + BlockGroup (0xA0)
    const clusterBytes: number[] = [
      0x1f, 0x43, 0xb6, 0x75, 0x80 | (4 + 2 + blockGroupContent.length),
      EBML_ID.Timecode, 0x82, (1000 >> 8) & 0xff, 1000 & 0xff,
      EBML_ID.BlockGroup, 0x80 | blockGroupContent.length,
      ...blockGroupContent,
    ];

    demuxer.demuxBuffer(new Uint8Array(clusterBytes));

    expect(receivedCues).toHaveLength(1);
    expect(receivedCues[0].trackNumber).toBe(3);
    expect(receivedCues[0].timeSec).toBeCloseTo(1.5, 2);
    expect(receivedCues[0].durationSec).toBeCloseTo(2.5, 2);
    expect(receivedCues[0].text).toBe('Hello MKV');
    expect(demuxer.getCuesForTrack(3)).toHaveLength(1);
  });

  it('parses Matroska fixed-size and Xiph block lacing accurately', () => {
    // Fixed-size lacing: flags = 0x84 (keyframe + fixed lacing 0b10 << 1), 2 frames (numFrames - 1 = 1), 3 bytes each
    const fixedPayload = new Uint8Array([
      0x82, // Track 2
      0x00, 0x64, // Timecode 100
      0x84, // Keyframe + Fixed-size lacing
      0x01, // 2 frames (1 + 1)
      0xaa, 0xbb, 0xcc,
      0xdd, 0xee, 0xff,
    ]);
    const parsedFixed = parseMkvBlock(fixedPayload);
    expect(parsedFixed).not.toBeNull();
    expect(parsedFixed?.trackNumber).toBe(2);
    expect(parsedFixed?.frames).toHaveLength(2);
    expect(Array.from(parsedFixed!.frames[0])).toEqual([0xaa, 0xbb, 0xcc]);
    expect(Array.from(parsedFixed!.frames[1])).toEqual([0xdd, 0xee, 0xff]);
  });

  it('parses AVC and AAC CodecPrivate records for fMP4 remuxing', () => {
    const avcC = new Uint8Array([
      0x01, 0x64, 0x00, 0x28, 0xff, // version 1, High Profile (0x64), compat 0, level 4.0 (0x28), 4-byte NAL length
      0xe1, 0x00, 0x04, 0x67, 0x64, 0x00, 0x28, // 1 SPS of 4 bytes
      0x01, 0x00, 0x04, 0x68, 0xee, 0x3c, 0x80, // 1 PPS of 4 bytes
    ]);
    const avc = parseAvcCodecPrivate(avcC);
    expect(avc).not.toBeNull();
    expect(avc?.profileIdc).toBe(0x64);
    expect(avc?.levelIdc).toBe(0x28);
    expect(avc?.nalLengthSize).toBe(4);
    expect(avc?.sps).toHaveLength(1);
    expect(avc?.pps).toHaveLength(1);

    // AAC-LC (2), 44100 Hz (index 4), Stereo (2): (2 << 3) | (4 >> 1) = 0x12, ((4 & 1) << 7) | (2 << 3) = 0x10
    const aac = parseAacCodecPrivate(new Uint8Array([0x12, 0x10]));
    expect(aac.audioobjecttype).toBe(2);
    expect(aac.samplingfrequencyindex).toBe(4);
    expect(aac.samplerate).toBe(44100);
    expect(aac.channelcount).toBe(2);
  });
});
