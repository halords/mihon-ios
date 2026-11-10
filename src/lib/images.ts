/** Sniff bytes rather than trusting a filename or a server's Content-Type. */
export function imageMime(bytes: Uint8Array): string | undefined {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)) return 'image/png';
  const head = new TextDecoder().decode(bytes.subarray(0, 1024));
  if (/^GIF8[79]a/.test(head)) return 'image/gif';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'image/webp';
  if (head.slice(4, 8) === 'ftyp' && /avif|avis/.test(head.slice(8, 64))) return 'image/avif';
  if (/^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)?<svg[\s>]/i.test(head)) return 'image/svg+xml';
  return undefined;
}

export async function validateImageBlob(blob: Blob): Promise<Blob> {
  if (!blob.size) throw new Error('The source returned an empty image');
  const mime = imageMime(new Uint8Array(await blob.slice(0, 1024).arrayBuffer()));
  if (!mime) throw new Error('The source did not return a valid image');
  return blob.type === mime ? blob : new Blob([blob], { type: mime });
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
