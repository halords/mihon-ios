import { expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { backendCookies, isAllowedMangaDexUrl, proxyRequestScope, sendResponse, readProxyBody } from '../server/proxy';

it('scopes Suwayomi session cookies to the backend proxy while preserving CSRF protection', () => {
  const headers = new Headers();
  headers.append('Set-Cookie', 'JSESSIONID=session; Path=/; HttpOnly; SameSite=Strict');
  headers.append('Set-Cookie', 'suwayomi-basic-csrf=token; Path=/server/; Domain=backend.local; HttpOnly; SameSite=Strict');
  expect(backendCookies(headers)).toEqual([
    'JSESSIONID=session; Path=/api/suwayomi/; HttpOnly; SameSite=Strict',
    'suwayomi-basic-csrf=token; Path=/api/suwayomi/; HttpOnly; SameSite=Strict',
  ]);
});

it('forwards parsed serverless JSON bodies while preserving exact source IDs', async () => {
  const body = { query: 'query Fixture', variables: { source: '9223372036854775806' } };
  const req = Object.assign(Readable.from([]), { body, headers: { 'content-type': 'application/json' } }) as unknown as IncomingMessage;
  expect(JSON.parse((await readProxyBody(req)).toString())).toEqual(body);
});

it('retains raw multipart bytes from streams and serverless body helpers', async () => {
  const bytes = Buffer.from([0, 255, 128, 13, 10, 31, 139, 0]);
  const streamed = Object.assign(Readable.from([bytes.subarray(0, 3), bytes.subarray(3)]), { headers: { 'content-type': 'multipart/form-data' } }) as unknown as IncomingMessage;
  expect(await readProxyBody(streamed)).toEqual(bytes);
  const prepared = Object.assign(Readable.from([]), { body: bytes, headers: { 'content-type': 'multipart/form-data' } }) as unknown as IncomingMessage;
  expect(await readProxyBody(prepared)).toEqual(bytes);
});

it('limits the MangaDex proxy to HTTPS official hosts and excludes lookalikes', () => {
  for (const url of ['https://api.mangadex.org/manga', 'https://uploads.mangadex.org/covers/1', 'https://cdn.mangadex.network/1']) expect(isAllowedMangaDexUrl(new URL(url))).toBe(true);
  for (const url of ['http://api.mangadex.org', 'https://mangadex.org.attacker.test', 'https://user:pass@api.mangadex.org', 'https://api.mangadex.org:4567']) expect(isAllowedMangaDexUrl(new URL(url))).toBe(false);
});

it('cleans up the upstream timer after a complete response and aborts on client disconnect', async () => {
  vi.useFakeTimers();
  try {
    const request = new EventEmitter() as IncomingMessage;
    const response = Object.assign(new EventEmitter(), { writableFinished: false }) as ServerResponse;
    const complete = proxyRequestScope(request, response, 1000);
    complete.cleanup();
    await vi.advanceTimersByTimeAsync(2000);
    expect(complete.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    const pending = proxyRequestScope(request, response, 1000);
    response.emit('close');
    expect(pending.signal.reason).toMatchObject({ name: 'AbortError' });
    pending.cleanup();
    expect(request.listenerCount('aborted')).toBe(0);
    expect(response.listenerCount('close')).toBe(0);
  } finally { vi.useRealTimers(); }
});

it('cancels the upstream response when a browser abandons its image body and still serves subsequent requests', async () => {
  const cancelled = vi.fn();
  let finishPipeline!: () => void;
  const pipelineFinished = new Promise<void>(resolve => { finishPipeline = resolve; });
  const server = createServer(async (req, res) => {
    if (req.url === '/healthy') { res.end('still running'); return; }
    const scope = proxyRequestScope(req, res, 100);
    const response = new Response(new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode('partial image')); }, cancel: cancelled }));
    try { await sendResponse(response, res); }
    catch { /* expected browser cancellation */ }
    finally { scope.cleanup(); finishPipeline(); }
  });
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/image`);
    const reader = response.body!.getReader();
    expect((await reader.read()).value?.length).toBeGreaterThan(0);
    await reader.cancel();
    await pipelineFinished;
    expect(cancelled).toHaveBeenCalledOnce();
    // The old upstream timeout must not fire later against an abandoned stream.
    await new Promise<void>(resolve => { setTimeout(resolve, 150); });
    expect(await (await fetch(`http://127.0.0.1:${port}/healthy`)).text()).toBe('still running');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => { server.close(() => resolve()); }); }
});
