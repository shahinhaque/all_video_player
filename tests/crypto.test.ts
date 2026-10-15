import { describe, it, expect } from 'vitest';
import {
  base64UrlToBytes,
  unpackFileKey,
} from '../src/providers/mega.js';

describe('MEGA Crypto Helpers', () => {
  it('correctly converts base64url string to bytes and back', () => {
    const raw = 'dGVzdGluZ18xMjM-';
    const bytes = base64UrlToBytes(raw);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(12);
  });

  it('unpacks 256-bit MEGA file key into 128-bit AES key and 64-bit nonce', () => {
    // 32 bytes = 8 32-bit words
    const keyBytes = new Uint8Array([
      0x01, 0x02, 0x03, 0x04,
      0x05, 0x06, 0x07, 0x08,
      0x09, 0x0a, 0x0b, 0x0c,
      0x0d, 0x0e, 0x0f, 0x10,
      0x11, 0x12, 0x13, 0x14,
      0x15, 0x16, 0x17, 0x18,
      0x19, 0x1a, 0x1b, 0x1c,
      0x1d, 0x1e, 0x1f, 0x20,
    ]);

    const unpacked = unpackFileKey(keyBytes);
    expect(unpacked.aesRawKey.length).toBe(16); // 128-bit key
    expect(unpacked.nonce.length).toBe(2); // 64-bit nonce

    // Check first word of aesKey: words[0] ^ words[4]
    // 0x01020304 ^ 0x11121314 = 0x10101010
    const dv = new DataView(unpacked.aesRawKey.buffer);
    expect(dv.getUint32(0, false)).toBe(0x01020304 ^ 0x11121314);
  });
});
