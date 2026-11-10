/** Sniff bytes rather than trusting a filename or a server's Content-Type. */
export function imageMime(bytes: Uint8Array): string | undefined {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)) return 'image/png';
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp'; // 'BM'
  if (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00) return 'image/x-icon';
  if (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) return 'image/tiff'; // little-endian
  if (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a) return 'image/tiff'; // big-endian
  if (bytes[0] === 0xff && bytes[1] === 0x0a) return 'image/jxl'; // JPEG XL codestream
  const head = new TextDecoder().decode(bytes.subarray(0, 1024));
  if (/^GIF8[79]a/.test(head)) return 'image/gif';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'image/webp';
  if (head.slice(4, 8) === 'ftyp') {
    const brands = head.slice(8, 64);
    if (/avif|avis/.test(brands)) return 'image/avif';
    if (/heic|heix|hevc|mif1|msf1/.test(brands)) return 'image/heic';
    if (brands.includes('jxl ')) return 'image/jxl';
  }
  if (/^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)?<svg[\s>]/i.test(head)) return 'image/svg+xml';
  return undefined;
}

export async function validateImageBlob(blob: Blob): Promise<Blob> {
  if (!blob.size) throw new Error('The source returned an empty image');
  const mime = imageMime(new Uint8Array(await blob.slice(0, 1024).arrayBuffer()));
  if (mime) return blob.type === mime ? blob : new Blob([blob], { type: mime });
  // Unknown magic bytes: the source may still have served a readable
  // image in a format the sniffer does not know (or with a mangled
  // header). Only reject it when the browser itself cannot decode it
  // either — imageDimensions resolves with a size only for an image
  // that actually decoded. (It also resolves {} when no Image
  // implementation exists at all; that is not a successful decode.)
  const dimensions = await imageDimensions(blob).catch(() => undefined);
  if (dimensions?.width && dimensions?.height) return blob.type ? blob : new Blob([blob], { type: 'application/octet-stream' });
  throw new Error('The source did not return a valid image');
}

export async function imageDimensions(blob: Blob, signal?: AbortSignal): Promise<{ width?: number; height?: number }> {
  if (typeof Image === 'undefined') return {};
  if (signal?.aborted) throw signal.reason ?? new DOMException('Cancelled', 'AbortError');
  const url = URL.createObjectURL(blob);
  const img = new Image();
  try {
    return await new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (error) reject(error);
        else if (!img.naturalWidth || !img.naturalHeight) reject(new Error('This page is not a readable image'));
        else resolve({ width: img.naturalWidth, height: img.naturalHeight });
      };
      const abort = () => finish(signal?.reason ?? new DOMException('Cancelled', 'AbortError'));
      const timer = setTimeout(() => finish(new Error('This image took too long to decode')), 15000);
      img.onload = () => finish();
      img.onerror = () => finish(new Error('This page is not a readable image'));
      signal?.addEventListener('abort', abort, { once: true });
      img.src = url;
    });
  } finally { img.onload = null; img.onerror = null; img.src = ''; URL.revokeObjectURL(url); }
}
