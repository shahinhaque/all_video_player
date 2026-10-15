import { describe, it, expect } from 'vitest';
import {
  base64UrlToBytes,
  unpackFileKey,
  aesCbcDecryptNoPad,
  aesEcbDecryptNoPad,
  decryptAttributes,
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

  it('decrypts unpadded/null-padded AES-CBC ciphertext without PKCS7 error using synthetic pad block', async () => {
    const rawKey = new Uint8Array(16).fill(0x42);
    const key = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-CBC' }, false, ['encrypt', 'decrypt']);

    // Plaintext with null padding (like MEGA attributes)
    const originalPlaintext = new TextEncoder().encode('MEGA{"n":"episode_01.ts", "size":1024}\0\0\0\0\0\0\0\0');
    // Align to 16 bytes
    const paddedLength = Math.ceil(originalPlaintext.length / 16) * 16;
    const alignedPlaintext = new Uint8Array(paddedLength);
    alignedPlaintext.set(originalPlaintext);

    // Encrypt raw blocks using standard AES-CBC
    const iv = new Uint8Array(16);
    const fullCipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, alignedPlaintext));
    const rawCiphertext = fullCipher.subarray(0, alignedPlaintext.length);

    // Test aesCbcDecryptNoPad
    const decryptedBytes = await aesCbcDecryptNoPad(rawCiphertext, rawKey, iv);
    expect(decryptedBytes).toEqual(alignedPlaintext);

    // Test decryptAttributes helper
    const attrs = await decryptAttributes(rawCiphertext, rawKey);
    expect(attrs.n).toBe('episode_01.ts');
  });

  it('decrypts 32-byte MEGA folder node keys using aesEcbDecryptNoPad', async () => {
    const masterKey = new Uint8Array(16).fill(0x7a);
    const key = await crypto.subtle.importKey('raw', masterKey, { name: 'AES-CBC' }, false, ['encrypt']);

    // Two 16-byte blocks
    const block1 = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    const block2 = new Uint8Array([17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]);

    const zeroIv = new Uint8Array(16);
    // Encrypt block 1 in ECB (CBC with zeroIv on 16 bytes is ECB)
    const c1 = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: zeroIv }, key, block1)).subarray(0, 16);
    const c2 = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: zeroIv }, key, block2)).subarray(0, 16);

    const fullCipher = new Uint8Array(32);
    fullCipher.set(c1, 0);
    fullCipher.set(c2, 16);

    const decrypted = await aesEcbDecryptNoPad(fullCipher, masterKey);
    expect(decrypted.length).toBe(32);
    expect(decrypted.subarray(0, 16)).toEqual(block1);
    expect(decrypted.subarray(16, 32)).toEqual(block2);
  });

  it('verifies MEGA AES-CTR random-access streaming decryption calculation', async () => {
    const rawKey = new Uint8Array(16).fill(0x33);
    const nonce = new Uint32Array([0x12345678, 0x9abcdef0]);

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      rawKey,
      { name: 'AES-CTR' },
      false,
      ['encrypt', 'decrypt']
    );

    // Simulate 64 bytes of video data
    const originalVideoBytes = new Uint8Array(64);
    for (let i = 0; i < originalVideoBytes.length; i++) originalVideoBytes[i] = (i * 7 + 3) & 0xff;

    // Encrypt starting at block 0
    const counterBlock0 = new Uint8Array(16);
    const dv0 = new DataView(counterBlock0.buffer);
    dv0.setUint32(0, nonce[0], false);
    dv0.setUint32(4, nonce[1], false);
    dv0.setUint32(8, 0, false);
    dv0.setUint32(12, 0, false);

    const encryptedVideo = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-CTR', counter: counterBlock0, length: 64 }, cryptoKey, originalVideoBytes)
    );

    // Now test random seeking to byte offset 18 to 35 (crosses block 1 and 2)
    const start = 18;
    const end = 35;
    const startBlock = Math.floor(start / 16); // 1
    const blockOffset = start % 16;           // 2
    const endBlock = Math.floor(end / 16);     // 2
    const reqStart = startBlock * 16;         // 16
    const reqEnd = (endBlock + 1) * 16 - 1;   // 47

    const sliceCipher = encryptedVideo.subarray(reqStart, reqEnd + 1);

    const counterBlockSeek = new Uint8Array(16);
    const dvSeek = new DataView(counterBlockSeek.buffer);
    dvSeek.setUint32(0, nonce[0], false);
    dvSeek.setUint32(4, nonce[1], false);
    dvSeek.setUint32(8, Math.floor(startBlock / 0x100000000), false);
    dvSeek.setUint32(12, startBlock >>> 0, false);

    const decryptedSeekBuf = await crypto.subtle.decrypt(
      { name: 'AES-CTR', counter: counterBlockSeek, length: 64 },
      cryptoKey,
      sliceCipher
    );
    const decryptedBytes = new Uint8Array(decryptedSeekBuf);
    const exactLength = end - start + 1;
    const trimmed = decryptedBytes.subarray(blockOffset, blockOffset + exactLength);

    expect(trimmed).toEqual(originalVideoBytes.subarray(start, end + 1));
  });
});
