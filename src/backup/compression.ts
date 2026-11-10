import { Gunzip } from 'fflate';
import { blobPart } from '../lib/bytes';

const MAX_EXPANDED_BYTES = 512 * 1024 * 1024;
export async function gunzipIfNeeded(bytes: Uint8Array): Promise<Uint8Array> {
  if (!bytes.length) throw new Error('This backup is empty (0 bytes). Choose the original .tachibk file.');
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  const chunks: Uint8Array[] = [];
  let length = 0;
  const collect = (chunk: Uint8Array) => {
    length += chunk.length;
    if (length > MAX_EXPANDED_BYTES) throw new Error('This backup is too large to restore on this device');
    chunks.push(chunk);
  };
  try {
    if (typeof DecompressionStream !== 'undefined') {
      const reader = new Blob([blobPart(bytes)]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          collect(value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    } else {
      // Older WebKit lacks DecompressionStream. fflate is bundled offline.
      const unzip = new Gunzip(collect);
      for (let i = 0; i < bytes.length; i += 65536) unzip.push(bytes.subarray(i, i + 65536), i + 65536 >= bytes.length);
    }
  } catch (error) {
    throw new Error(`Unable to decompress this backup: ${error instanceof Error ? error.message : 'invalid gzip data'}`);
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}
