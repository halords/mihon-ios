import { afterEach, expect, it, vi } from 'vitest';
import { fetchWithTimeout, fetchJson } from '../src/lib/fetchJson';

afterEach(() => vi.useRealTimers());

function stalledResponse() {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(stream) { stream.enqueue(new TextEncoder().encode('partial')); },
    cancel,
  });
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body));
  return cancel;
}

it('times out a body that stalls after the headers have arrived', async () => {
  vi.useFakeTimers();
  const cancel = stalledResponse();
  const response = await fetchWithTimeout('https://source.example/image', {}, 1000);
  const body = response.blob();
  const failure = expect(body).rejects.toMatchObject({ name: 'TimeoutError' });
  await vi.advanceTimersByTimeAsync(1000);
  await failure;
  expect(cancel).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('cancels a pending image body immediately when downloads are paused', async () => {
  const cancel = stalledResponse();
  const controller = new AbortController();
  const response = await fetchWithTimeout('https://source.example/image', { signal: controller.signal });
  const body = response.blob();
  controller.abort(new DOMException('Download paused', 'AbortError'));
  await expect(body).rejects.toMatchObject({ name: 'AbortError', message: 'Download paused' });
  expect(cancel).toHaveBeenCalledOnce();
});

it('releases timeout and cancellation listeners after the complete body', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"ok":true}'));
  const response = await fetchWithTimeout('https://source.example/json', { signal: controller.signal });
  expect(await response.json()).toEqual({ ok: true });
  expect(vi.getTimerCount()).toBe(0);
  controller.abort();
  await vi.advanceTimersByTimeAsync(60000);
});

it('cancels the upstream body when the consumer discards a response', async () => {
  vi.useFakeTimers();
  const cancel = stalledResponse();
  const response = await fetchWithTimeout('https://source.example/image');
  await response.body!.cancel();
  expect(cancel).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('retains cancellation errors from JSON bodies instead of reporting invalid JSON', async () => {
  stalledResponse();
  const controller = new AbortController();
  const data = fetchJson('https://source.example/json', { signal: controller.signal });
  await Promise.resolve();
  controller.abort();
  await expect(data).rejects.toMatchObject({ name: 'AbortError' });
});
