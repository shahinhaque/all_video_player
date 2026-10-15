import { describe, it, expect } from 'vitest';
import { probeTsAudioCodec } from '../src/engines/ts-probe.js';

function createSyntheticTsStream(audioStreamType?: number): Uint8Array {
  const buffer = new Uint8Array(188 * 3); // 3 packets: PAT, PMT, PES
  buffer.fill(0xff);

  // Packet 0: PAT (PID 0)
  buffer[0] = 0x47; // Sync byte
  buffer[1] = 0x40; // PUSI = 1, PID = 0
  buffer[2] = 0x00;
  buffer[3] = 0x10; // AFC = 1 (payload only)
  buffer[4] = 0x00; // Pointer field = 0
  buffer[5] = 0x00; // Table ID = 0 (PAT)
  buffer[6] = 0xb0; // Section syntax & length high
  buffer[7] = 0x0d; // Section length = 13 (8 header + 4 program entry + 4 CRC - 3)
  // Skip transport stream id (buffer[8..9])
  // Skip version & cni (buffer[10])
  // Skip sec num & last sec num (buffer[11..12])
  buffer[13] = 0x00; // Program number high
  buffer[14] = 0x01; // Program number low = 1
  buffer[15] = 0xe1; // PMT PID high (bits 0..4 = 0x01)
  buffer[16] = 0x64; // PMT PID low = 0x64 (PID = 0x164)

  // Packet 1: PMT (PID 0x164)
  const pmtOffset = 188;
  buffer[pmtOffset + 0] = 0x47;
  buffer[pmtOffset + 1] = 0x41; // PUSI = 1, PID = 0x0164
  buffer[pmtOffset + 2] = 0x64;
  buffer[pmtOffset + 3] = 0x10; // AFC = 1 (payload only)
  buffer[pmtOffset + 4] = 0x00; // Pointer field = 0
  buffer[pmtOffset + 5] = 0x02; // Table ID = 2 (PMT)
  buffer[pmtOffset + 6] = 0xb0;
  buffer[pmtOffset + 7] = 0x17; // Section length
  // Skip program number & version (buffer[pmtOffset+8..12])
  // Skip PCR PID (buffer[pmtOffset+13..14])
  buffer[pmtOffset + 15] = 0xf0; // Program info length high (0)
  buffer[pmtOffset + 16] = 0x00; // Program info length low = 0

  let esPos = pmtOffset + 17;
  // Video ES: H.264 (stream_type 0x1b)
  buffer[esPos + 0] = 0x1b; // H.264 video
  buffer[esPos + 1] = 0xe1; // ES PID 0x100
  buffer[esPos + 2] = 0x00;
  buffer[esPos + 3] = 0xf0; // ES info len = 0
  buffer[esPos + 4] = 0x00;
  esPos += 5;

  if (audioStreamType !== undefined) {
    buffer[esPos + 0] = audioStreamType;
    buffer[esPos + 1] = 0xe1; // ES PID 0x101
    buffer[esPos + 2] = 0x01;
    buffer[esPos + 3] = 0xf0; // ES info len = 0
    buffer[esPos + 4] = 0x00;
  }

  return buffer;
}

describe('MPEG-TS Audio Codec Probe', () => {
  it('identifies supported AAC audio stream (0x0F)', () => {
    const data = createSyntheticTsStream(0x0f);
    const result = probeTsAudioCodec(data);
    expect(result).not.toBeNull();
    expect(result?.hasAudio).toBe(true);
    expect(result?.codec).toBe('AAC');
    expect(result?.supported).toBe(true);
  });

  it('detects unsupported MP2 audio stream (0x03)', () => {
    const data = createSyntheticTsStream(0x03);
    const result = probeTsAudioCodec(data);
    expect(result).not.toBeNull();
    expect(result?.hasAudio).toBe(true);
    expect(result?.codec).toBe('MP2');
    expect(result?.supported).toBe(false);
  });

  it('detects unsupported AC-3 audio stream (0x81)', () => {
    const data = createSyntheticTsStream(0x81);
    const result = probeTsAudioCodec(data);
    expect(result).not.toBeNull();
    expect(result?.hasAudio).toBe(true);
    expect(result?.codec).toBe('AC-3');
    expect(result?.supported).toBe(false);
  });

  it('returns null for stream with only video (no audio stream in PMT)', () => {
    const data = createSyntheticTsStream(undefined);
    const result = probeTsAudioCodec(data);
    expect(result).toBeNull();
  });
});
