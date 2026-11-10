import { afterEach, expect, it, vi } from 'vitest';
import { imageMime, validateImageBlob } from '../src/lib/images';

afterEach(() => { vi.unstubAllGlobals(); });

function bytes(...values: number[]): Uint8Array { return new Uint8Array(values); }
function ftyp(major: string): Uint8Array {
  const out = new Uint8Array(24);
  out.set([0, 0, 0, 24], 0);
  out.set(new TextEncoder().encode('ftyp'), 4);
  out.set(new TextEncoder().encode(major), 8);
  return out;
}

it('sniffs BMP, ICO, TIFF, HEIC/HEIF and JPEG XL headers', () => {
  expect(imageMime(bytes(0x42, 0x4d, 0x36, 0x00, 0x00, 0x00))).toBe('image/bmp');
  expect(imageMime(bytes(0x00, 0x00, 0x01, 0x00, 0x01, 0x00))).toBe('image/x-icon');
  expect(imageMime(bytes(0x49, 0x49, 0x2a, 0x00, 0x08, 0x00))).toBe('image/tiff');
  expect(imageMime(bytes(0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00))).toBe('image/tiff');
  expect(imageMime(ftyp('heic'))).toBe('image/heic');
  expect(imageMime(ftyp('heix'))).toBe('image/heic');
  expect(imageMime(ftyp('mif1'))).toBe('image/heic');
  expect(imageMime(ftyp('msf1'))).toBe('image/heic');
  expect(imageMime(bytes(0xff, 0x0a, 0x00, 0x00))).toBe('image/jxl');
  expect(imageMime(ftyp('jxl '))).toBe('image/jxl');
});

it('keeps sniffing the formats it already knew', () => {
  expect(imageMime(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
  expect(imageMime(bytes(137, 80, 78, 71, 13, 10, 26, 10))).toBe('image/png');
  expect(imageMime(new TextEncoder().encode('GIF89a'))).toBe('image/gif');
  expect(imageMime(ftyp('avif'))).toBe('image/avif');
  expect(imageMime(bytes(1, 2, 3, 4, 5, 6))).toBeUndefined();
});

class StubImage {
  naturalWidth = 4;
  naturalHeight = 3;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_value: string) { queueMicrotask(() => this.onload?.()); }
}
class BrokenImage {
  naturalWidth = 0;
  naturalHeight = 0;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_value: string) { queueMicrotask(() => this.onerror?.()); }
}

it('accepts an unknown-magic blob the browser can decode, keeping its declared type', async () => {
  vi.stubGlobal('Image', StubImage);
  const accepted = await validateImageBlob(new Blob([bytes(1, 2, 3, 4, 5)], { type: 'image/x-custom' }));
  expect(accepted.type).toBe('image/x-custom');
});

it('accepts a decodable blob without a declared type as application/octet-stream', async () => {
  vi.stubGlobal('Image', StubImage);
  const accepted = await validateImageBlob(new Blob([bytes(9, 9, 9, 9)]));
  expect(accepted.type).toBe('application/octet-stream');
});

it('rejects unknown bytes the browser cannot decode', async () => {
  vi.stubGlobal('Image', BrokenImage);
  await expect(validateImageBlob(new Blob(['<html>blocked</html>'], { type: 'image/jpeg' }))).rejects.toThrow(/valid image/);
});

it('rejects empty blobs before attempting any decode', async () => {
  vi.stubGlobal('Image', StubImage);
  await expect(validateImageBlob(new Blob([]))).rejects.toThrow(/empty image/);
});

it('normalizes a known format to its sniffed type', async () => {
  const png = new Blob([bytes(137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3)], { type: 'image/jpeg' });
  expect((await validateImageBlob(png)).type).toBe('image/png');
});
