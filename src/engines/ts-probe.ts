/**
 * MPEG-TS Elementary Stream probe to inspect PAT and PMT tables
 * for audio codecs (AAC vs MP2/AC-3/DTS).
 */

export interface TsAudioProbeResult {
  hasAudio: boolean;
  codec?: string;
  supported: boolean;
}

/**
 * Inspects a chunk of MPEG-TS packets to identify the audio codec in the PMT.
 */
export function probeTsAudioCodec(data: Uint8Array): TsAudioProbeResult | null {
  let pmtPid: number | null = null;
  const len = data.length;

  // Find initial 0x47 sync byte alignment
  let offset = 0;
  while (offset + 188 <= len) {
    if (data[offset] === 0x47 && (offset + 188 === len || data[offset + 188] === 0x47)) {
      break;
    }
    offset++;
  }

  while (offset + 188 <= len) {
    if (data[offset] !== 0x47) {
      offset++;
      continue;
    }

    const byte1 = data[offset + 1];
    const byte2 = data[offset + 2];
    const byte3 = data[offset + 3];
    const pid = ((byte1 & 0x1F) << 8) | byte2;
    const pusi = (byte1 & 0x40) !== 0;
    const afc = (byte3 >> 4) & 0x03;

    let payloadStart = offset + 4;
    if (afc === 2) {
      // Adaptation field only, no payload
      offset += 188;
      continue;
    }
    if (afc === 3) {
      const adaptLen = data[payloadStart];
      payloadStart += 1 + adaptLen;
    }

    if (payloadStart >= offset + 188) {
      offset += 188;
      continue;
    }

    if (pusi) {
      const pointer = data[payloadStart];
      payloadStart += 1 + pointer;
    }

    if (payloadStart >= offset + 188) {
      offset += 188;
      continue;
    }

    // 1. Check PAT (Program Association Table, PID 0x0000)
    if (pid === 0 && pmtPid === null) {
      const tableId = data[payloadStart];
      if (tableId === 0x00) {
        const sectionLength = ((data[payloadStart + 1] & 0x0F) << 8) | data[payloadStart + 2];
        const sectionEnd = Math.min(offset + 188, payloadStart + 3 + sectionLength - 4);
        let pos = payloadStart + 8; // Skip TS ID, version, sec num
        while (pos + 4 <= sectionEnd) {
          const progNum = (data[pos] << 8) | data[pos + 1];
          const progPid = ((data[pos + 2] & 0x1F) << 8) | data[pos + 3];
          if (progNum !== 0) {
            pmtPid = progPid;
            break;
          }
          pos += 4;
        }
      }
    } else if (pmtPid !== null && pid === pmtPid) {
      // 2. Check PMT (Program Map Table)
      const tableId = data[payloadStart];
      if (tableId === 0x02) {
        const sectionLength = ((data[payloadStart + 1] & 0x0F) << 8) | data[payloadStart + 2];
        const progInfoLen = ((data[payloadStart + 10] & 0x0F) << 8) | data[payloadStart + 11];
        let pos = payloadStart + 12 + progInfoLen;
        const sectionEnd = Math.min(offset + 188, payloadStart + 3 + sectionLength - 4);

        while (pos + 5 <= sectionEnd) {
          const streamType = data[pos];
          const esInfoLen = ((data[pos + 3] & 0x0F) << 8) | data[pos + 4];

          if (streamType === 0x0F || streamType === 0x11) {
            return { hasAudio: true, codec: 'AAC', supported: true };
          } else if (streamType === 0x03 || streamType === 0x04) {
            return { hasAudio: true, codec: 'MP2', supported: false };
          } else if (streamType === 0x81) {
            return { hasAudio: true, codec: 'AC-3', supported: false };
          } else if (streamType === 0x87) {
            return { hasAudio: true, codec: 'E-AC-3', supported: false };
          } else if (streamType === 0x82 || streamType === 0x86) {
            return { hasAudio: true, codec: 'DTS', supported: false };
          }

          pos += 5 + esInfoLen;
        }
      }
    }

    offset += 188;
  }

  return null;
}
