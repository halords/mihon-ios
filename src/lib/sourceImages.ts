/** Decode the tile layout supplied by Asura's public reader. Downloaded
 * bytes and the online reader must see the same reconstructed image. */
export async function decodeSourceImage(blob: Blob, url: string, signal?: AbortSignal): Promise<Blob> {
  const hash = new URL(url, 'https://reader.invalid').hash;
  if (!hash.startsWith('#tiles=')) return blob;
  const parameters: unknown = JSON.parse(decodeURIComponent(hash.slice(7)));
  if (!parameters || typeof parameters !== 'object') throw new Error('Invalid source image layout');
  const { tiles, cols, rows } = parameters as { tiles: unknown; cols: number; rows: number };
  const count = cols * rows;
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || count > 1024 || !Array.isArray(tiles) || tiles.length !== count || new Set(tiles).size !== count || tiles.some(tile => !Number.isInteger(tile) || tile < 0 || tile >= count)) throw new Error('Invalid source image layout');
  if (signal?.aborted) throw signal.reason;
  const objectUrl = URL.createObjectURL(blob), image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (error) reject(error); else resolve(); };
      const abort = () => finish(signal?.reason ?? new DOMException('Cancelled', 'AbortError'));
      const timer = setTimeout(() => finish(new Error('The source image took too long to decode')), 15000);
      image.onload = () => finish(); image.onerror = () => finish(new Error('The source image could not be decoded'));
      signal?.addEventListener('abort', abort, { once: true }); image.src = objectUrl;
    });
    if (signal?.aborted) throw signal.reason;
    const width = Math.floor(image.naturalWidth / cols), height = Math.floor(image.naturalHeight / rows);
    if (!width || !height) throw new Error('The source image has invalid tile dimensions');
    const canvas = document.createElement('canvas'); canvas.width = width * cols; canvas.height = height * rows;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Image decoding is unavailable on this device');
    tiles.forEach((destination, index) => context.drawImage(image, index % cols * width, Math.floor(index / cols) * height, width, height, destination % cols * width, Math.floor(destination / cols) * height, width, height));
    const output = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Unable to save the decoded page')), 'image/png'));
    canvas.width = 0; canvas.height = 0;
    if (signal?.aborted) throw signal.reason;
    return output;
  } finally { image.onload = null; image.onerror = null; image.src = ''; URL.revokeObjectURL(objectUrl); }
}
