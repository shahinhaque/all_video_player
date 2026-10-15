import { SourceProvider, MediaItem, Playlist, RangeByteSource } from '../core/types.js';
import { PlayerError } from '../core/errors.js';
import { isVideoEntry, guessMime } from '../lib/media.js';
import { fetchWithRetry } from '../lib/network.js';

// Base64URL string <-> Uint8Array utilities for MEGA's format
export function base64UrlToBytes(str: string): Uint8Array {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4 !== 0) str += '=';
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function bytesToWords(bytes: Uint8Array): Uint32Array {
  const words = new Uint32Array(bytes.length / 4);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < words.length; i++) {
    words[i] = dv.getUint32(i * 4, false); // Big endian
  }
  return words;
}

export function wordsToBytes(words: Uint32Array): Uint8Array {
  const bytes = new Uint8Array(words.length * 4);
  const dv = new DataView(bytes.buffer);
  for (let i = 0; i < words.length; i++) {
    dv.setUint32(i * 4, words[i], false);
  }
  return bytes;
}

export interface MegaKeyInfo {
  aesRawKey: Uint8Array;
  nonce: Uint32Array; // 2 words
  cryptoKey?: CryptoKey;
}

export function unpackFileKey(keyBytes: Uint8Array): MegaKeyInfo {
  const words = bytesToWords(keyBytes);
  if (words.length !== 8) {
    throw new PlayerError('unknown', `Invalid MEGA file key length: expected 8 words, got ${words.length}`);
  }
  const aesWords = new Uint32Array([
    words[0] ^ words[4],
    words[1] ^ words[5],
    words[2] ^ words[6],
    words[3] ^ words[7],
  ]);
  const nonce = new Uint32Array([words[4], words[5]]);
  return {
    aesRawKey: wordsToBytes(aesWords),
    nonce,
  };
}

export async function aesCbcDecryptNoPad(
  ciphertext: Uint8Array,
  rawKey: Uint8Array,
  iv: Uint8Array = new Uint8Array(16)
): Promise<Uint8Array> {
  if (ciphertext.length === 0) return new Uint8Array(0);
  if (ciphertext.length % 16 !== 0) {
    throw new PlayerError('unknown', 'Ciphertext length must be a multiple of 16 for unpadded decryption.');
  }

  const key = await crypto.subtle.importKey(
    'raw',
    rawKey as BufferSource,
    { name: 'AES-CBC' },
    false,
    ['encrypt', 'decrypt']
  );

  const lastBlock = ciphertext.subarray(ciphertext.length - 16);
  const dummyPad = new Uint8Array(16).fill(0x10);
  const encPadBuf = await crypto.subtle.encrypt(
    { name: 'AES-CBC', iv: lastBlock as BufferSource },
    key,
    dummyPad
  );
  const encPad = new Uint8Array(encPadBuf).subarray(0, 16);

  const combined = new Uint8Array(ciphertext.length + 16);
  combined.set(ciphertext, 0);
  combined.set(encPad, ciphertext.length);

  const decBuf = await crypto.subtle.decrypt(
    { name: 'AES-CBC', iv: iv as BufferSource },
    key,
    combined
  );

  return new Uint8Array(decBuf);
}

export async function aesEcbDecryptNoPad(
  ciphertext: Uint8Array,
  rawKey: Uint8Array
): Promise<Uint8Array> {
  if (ciphertext.length === 0) return new Uint8Array(0);
  if (ciphertext.length % 16 !== 0) {
    throw new PlayerError('unknown', 'Ciphertext length must be a multiple of 16 for AES-ECB decryption.');
  }

  const result = new Uint8Array(ciphertext.length);
  const zeroIv = new Uint8Array(16);

  for (let offset = 0; offset < ciphertext.length; offset += 16) {
    const block = ciphertext.subarray(offset, offset + 16);
    const decBlock = await aesCbcDecryptNoPad(block, rawKey, zeroIv);
    result.set(decBlock, offset);
  }

  return result;
}

export async function decryptAttributes(atBytes: Uint8Array, aesKeyBytes: Uint8Array): Promise<{ n: string }> {
  const decryptedBytes = await aesCbcDecryptNoPad(atBytes, aesKeyBytes, new Uint8Array(16));
  const text = new TextDecoder().decode(decryptedBytes);
  // Attribute string format: "MEGA{"n":"name.mp4",...}"
  const braceIdx = text.indexOf('{');
  if (braceIdx === -1) {
    throw new PlayerError('unknown', 'Malformed decrypted MEGA attributes.');
  }
  // Trim null padding bytes at end
  const jsonStr = text.slice(braceIdx).replace(/\0+$/, '');
  return JSON.parse(jsonStr);
}

export class MegaProvider implements SourceProvider {
  readonly id = 'mega';
  readonly label = 'MEGA';

  canHandle(url: URL): boolean {
    const host = url.hostname.toLowerCase();
    return host === 'mega.nz' || host === 'mega.co.nz' || host === 'mega.io';
  }

  parseUrl(url: URL): { id: string; key: string; isFolder: boolean; subFileId?: string } | null {
    const path = url.pathname;
    const hash = url.hash.replace(/^#/, '');

    // Format 1: /file/{id}#{key}
    const fileMatch = /\/file\/([a-zA-Z0-9_-]+)/.exec(path);
    if (fileMatch && hash) {
      return { id: fileMatch[1], key: hash, isFolder: false };
    }

    // Format 2: /folder/{id}#{key} or /folder/{id}#{key}/file/{subFileId}
    const folderMatch = /\/folder\/([a-zA-Z0-9_-]+)/.exec(path);
    if (folderMatch && hash) {
      const subMatch = /\/file\/([a-zA-Z0-9_-]+)/.exec(path) || /\/file\/([a-zA-Z0-9_-]+)/.exec(hash);
      const cleanKey = hash.split('/')[0];
      return {
        id: folderMatch[1],
        key: cleanKey,
        isFolder: !subMatch,
        subFileId: subMatch ? subMatch[1] : undefined,
      };
    }

    // Format 3: Legacy #!{id}!{key} or #!F!{id}!{key}
    if (hash.startsWith('!')) {
      const parts = hash.split('!');
      if (parts[1] === 'F' && parts[2] && parts[3]) {
        return { id: parts[2], key: parts[3], isFolder: true };
      }
      if (parts[1] && parts[2]) {
        return { id: parts[1], key: parts[2], isFolder: false };
      }
    }

    return null;
  }

  async resolve(url: URL): Promise<Playlist> {
    const parsed = this.parseUrl(url);
    if (!parsed) {
      throw new PlayerError('unsupported', 'Invalid MEGA link format.');
    }

    if (parsed.isFolder) {
      return this.resolveFolder(parsed.id, parsed.key, url.href);
    }

    // Resolve single file via MEGA API
    const fileKeyBytes = base64UrlToBytes(parsed.key);
    const keyInfo = unpackFileKey(fileKeyBytes);

    const apiRes = await fetch('https://g.api.mega.co.nz/cs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([{ a: 'g', g: 1, ssl: 2, p: parsed.id }]),
    });

    if (!apiRes.ok) {
      throw new PlayerError('network', `MEGA API request failed: HTTP ${apiRes.status}`);
    }

    const data = await apiRes.json();
    const result = data[0];

    if (typeof result === 'number') {
      if (result === -11 || result === -9) throw new PlayerError('notfound', 'MEGA file does not exist or was deleted.');
      if (result === -17 || result === -16) throw new PlayerError('quota', 'MEGA transfer bandwidth quota exceeded.');
      throw new PlayerError('unknown', `MEGA error code ${result}`);
    }

    // Decrypt file attributes to get filename
    let fileName = `MEGA_File_${parsed.id}`;
    if (result.at) {
      try {
        const atBytes = base64UrlToBytes(result.at);
        const attrs = await decryptAttributes(atBytes, keyInfo.aesRawKey);
        if (attrs.n) fileName = attrs.n;
      } catch (err) {
        console.warn('Failed to decrypt MEGA attributes:', err);
      }
    }

    const item: MediaItem = {
      id: parsed.id,
      name: fileName,
      size: result.s || 0,
      mime: guessMime(fileName),
      provider: 'mega',
      ref: {
        fileId: parsed.id,
        key: parsed.key,
        downloadUrl: result.g || '',
      },
    };

    return {
      title: fileName,
      items: [item],
      startIndex: 0,
      sourceUrl: url.href,
    };
  }

  private async resolveFolder(folderId: string, folderKey: string, sourceUrl: string): Promise<Playlist> {
    const folderKeyBytes = base64UrlToBytes(folderKey);
    const folderWords = bytesToWords(folderKeyBytes);

    const apiRes = await fetch(`https://g.api.mega.co.nz/cs?n=${folderId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([{ a: 'f', c: 1, r: 1 }]),
    });

    if (!apiRes.ok) throw new PlayerError('network', 'Failed to fetch MEGA folder tree.');
    const data = await apiRes.json();
    const nodes = data[0]?.f;

    if (!nodes || !Array.isArray(nodes)) {
      throw new PlayerError('notfound', 'Could not read MEGA folder contents.');
    }

    const items: MediaItem[] = [];

    for (const node of nodes) {
      // Type 0 is file
      if (node.t === 0 && node.k) {
        // Node key is encrypted with folder key
        try {
          const colonIdx = node.k.indexOf(':');
          const encKeyB64 = colonIdx !== -1 ? node.k.slice(colonIdx + 1) : node.k;
          const encKeyBytes = base64UrlToBytes(encKeyB64);

          // Decrypt node key using AES-ECB
          const rawFolderKey = wordsToBytes(folderWords.slice(0, 4));
          const decKeyBytes = await aesEcbDecryptNoPad(encKeyBytes, rawFolderKey);
          const keyInfo = unpackFileKey(decKeyBytes);

          let fName = `MEGA_${node.h}`;
          if (node.a) {
            const atBytes = base64UrlToBytes(node.a);
            const attrs = await decryptAttributes(atBytes, keyInfo.aesRawKey);
            if (attrs.n) fName = attrs.n;
          }

          if (isVideoEntry(fName)) {
            // Encode key bytes back to base64url for ref
            let keyBin = '';
            for (let i = 0; i < decKeyBytes.length; i++) keyBin += String.fromCharCode(decKeyBytes[i]);
            const keyStr = btoa(keyBin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

            items.push({
              id: node.h,
              name: fName,
              size: node.s || 0,
              mime: guessMime(fName),
              provider: 'mega',
              ref: {
                fileId: node.h,
                key: keyStr,
                folderId,
              },
            });
          }
        } catch (e) {
          console.warn('Skipping unparsable MEGA node:', e);
        }
      }
    }

    if (items.length === 0) {
      throw new PlayerError('notfound', 'No playable video files found in this MEGA folder.');
    }

    return {
      title: 'MEGA Folder',
      items,
      startIndex: 0,
      sourceUrl,
    };
  }

  async open(item: MediaItem, signal?: AbortSignal): Promise<RangeByteSource> {
    let downloadUrl = item.ref.downloadUrl;
    const fileKeyBytes = base64UrlToBytes(item.ref.key);
    const keyInfo = unpackFileKey(fileKeyBytes);

    const refreshDownloadUrl = async (): Promise<string> => {
      const payload: Record<string, unknown> = { a: 'g', g: 1, ssl: 2 };
      if (item.ref.folderId) {
        payload.n = item.id;
      } else {
        payload.p = item.id;
      }

      const res = await fetch('https://g.api.mega.co.nz/cs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([payload]),
        signal,
      });

      const d = await res.json();
      const r = d[0];
      if (typeof r === 'number') {
        if (r === -17) throw new PlayerError('quota', 'MEGA bandwidth transfer limit reached.');
        throw new PlayerError('network', `MEGA API error code ${r}`);
      }
      downloadUrl = r.g;
      item.ref.downloadUrl = downloadUrl;
      return downloadUrl;
    };

    if (!downloadUrl) {
      await refreshDownloadUrl();
    }

    const aesCryptoKey = await crypto.subtle.importKey(
      'raw',
      keyInfo.aesRawKey as BufferSource,
      { name: 'AES-CTR' },
      false,
      ['decrypt']
    );

    return {
      name: item.name,
      size: item.size,
      mime: item.mime,
      encrypted: true,
      refresh: refreshDownloadUrl,
      async read(start: number, end: number, readSignal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
        const reqSignal = readSignal || signal;

        // AES-CTR 16-byte block alignment
        const startBlock = Math.floor(start / 16);
        const blockOffset = start % 16;
        const endBlock = Math.floor(end / 16);
        const reqStart = startBlock * 16;
        const reqEnd = (endBlock + 1) * 16 - 1;

        let res = await fetchWithRetry(downloadUrl, {
          headers: { Range: `bytes=${reqStart}-${reqEnd}` },
          signal: reqSignal,
        });

        if (res.status === 401 || res.status === 403 || res.status === 509) {
          if (res.status === 509) throw new PlayerError('quota', 'MEGA bandwidth limit exceeded.');
          // Attempt link refresh once
          downloadUrl = await refreshDownloadUrl();
          res = await fetchWithRetry(downloadUrl, {
            headers: { Range: `bytes=${reqStart}-${reqEnd}` },
            signal: reqSignal,
          });
        }

        if (!res.ok && res.status !== 206) {
          throw new PlayerError('network', `MEGA stream error HTTP ${res.status}`);
        }

        const cipherBuf = await res.arrayBuffer();
        const cipherBytes = new Uint8Array(cipherBuf);

        // Build 16-byte counter block for WebCrypto AES-CTR
        // Byte 0-7: Nonce (keyInfo.nonce)
        // Byte 8-15: 64-bit BigEndian block index
        const counterBlock = new Uint8Array(16);
        const dv = new DataView(counterBlock.buffer);
        dv.setUint32(0, keyInfo.nonce[0], false);
        dv.setUint32(4, keyInfo.nonce[1], false);
        // High 32 bits of 64-bit counter:
        dv.setUint32(8, Math.floor(startBlock / 0x100000000), false);
        // Low 32 bits:
        dv.setUint32(12, startBlock >>> 0, false);

        // Decrypt with WebCrypto AES-CTR (counter length: 64 bits)
        const plainBuf = await crypto.subtle.decrypt(
          { name: 'AES-CTR', counter: counterBlock, length: 64 },
          aesCryptoKey,
          cipherBytes
        );

        const plainBytes = new Uint8Array(plainBuf);
        const exactLength = end - start + 1;
        const trimmed = plainBytes.subarray(blockOffset, blockOffset + exactLength);

        return new ReadableStream<Uint8Array>({
          start(ctl) {
            ctl.enqueue(trimmed);
            ctl.close();
          },
        });
      },
    };
  }
}
