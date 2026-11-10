import { chromium } from 'playwright';
import { mkdir, readFile, writeFile, unlink, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { backupSourceConfigs, allowedSourceUrl } from '../src/sources/backupSources.ts';
import { validHubAccessKey } from '../src/sources/mangahubAccess.ts';

export const sessionPattern = /^[a-f0-9]{64}$/;
const width = 390, height = 680;
function source(id) { const value = backupSourceConfigs.find(source => source.id === id); if (!value) throw new Error('Unknown backup source'); return value; }
function challenge(text) { return /just a moment|cf-chl-|verify you are human|checking your browser/i.test(text); }
const extraResources = new Set(['challenges.cloudflare.com', 'cdnjs.cloudflare.com', 'www.google.com', 'www.gstatic.com']);
export class BrowserSessions {
  constructor({ stateDir = process.env.BROWSER_STATE_DIR ?? '.browser-state', idleMs = Number(process.env.BROWSER_IDLE_MS) || 180000, launch = options => chromium.launch(options) } = {}) {
    this.stateDir = resolve(stateDir); this.idleMs = idleMs; this.launch = launch; this.visitors = new Map(); this.saving = new Map(); this.browser = undefined;
    this.timer = setInterval(() => void this.releaseIdle().catch(() => {}), Math.min(idleMs, 30000)); this.timer.unref();
  }
  async getBrowser() {
    if (this.closing) await this.closing;
    if (!this.browser) {
      const pending = this.launch({ headless: true, chromiumSandbox: process.platform === 'linux', args: ['--disable-dev-shm-usage', '--disable-extensions', '--no-first-run'] });
      this.browser = pending; void pending.catch(() => { if (this.browser === pending) this.browser = undefined; });
    }
    return this.browser;
  }
  async createVisitor(key) {
    await this.saving.get(key);
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    let saved;
    try { const data = JSON.parse(await readFile(resolve(this.stateDir, key + '.json'), 'utf8')); if (Date.now() - data.savedAt < 86400000) saved = data.state; } catch { /* new or expired session */ }
    const context = await (await this.getBrowser()).newContext({ viewport: { width, height }, storageState: saved, serviceWorkers: 'block' });
    await context.route('**/*', route => {
      let url; try { url = new URL(route.request().url()); } catch { return route.abort(); }
      const verification = url.hostname === 'challenges.cloudflare.com' || (url.hostname === 'www.google.com' && url.pathname.startsWith('/recaptcha/'));
      const allowed = backupSourceConfigs.some(config => allowedSourceUrl(config, url, true)) || (url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') && extraResources.has(url.hostname) && (route.request().method() === 'GET' || (verification && route.request().method() === 'POST')));
      return allowed ? route.continue() : route.abort();
    });
    return { context, pages: new Map(), queue: Promise.resolve(), usedAt: Date.now(), busy: 0 };
  }
  async run(key, id, job) {
    if (!sessionPattern.test(key)) throw new Error('Invalid browser session');
    const config = source(id);
    if (!this.visitors.has(key)) this.visitors.set(key, this.createVisitor(key).catch(error => { this.visitors.delete(key); throw error; }));
    const visitor = await this.visitors.get(key); visitor.busy++; visitor.usedAt = Date.now();
    const pending = visitor.queue.then(async () => {
      let page = visitor.pages.get(id);
      if (!page || page.isClosed()) {
        page = await visitor.context.newPage(); visitor.pages.set(id, page);
        page.setDefaultTimeout(15000); page.setDefaultNavigationTimeout(30000);
        await page.goto(config.baseUrl, { waitUntil: 'domcontentloaded' });
      }
      return job({ visitor, page, config });
    });
    visitor.queue = pending.then(() => {}, () => {});
    try { return await pending; } finally { visitor.busy--; visitor.usedAt = Date.now(); }
  }
  async snapshot(key, id, action) {
    return this.run(key, id, async ({ page, visitor, config }) => {
      if (action) {
        switch (action.type) {
          case 'open': await page.goto(config.baseUrl, { waitUntil: 'domcontentloaded' }); break;
          case 'click': if (!Number.isFinite(action.x) || !Number.isFinite(action.y) || action.x < 0 || action.x > width || action.y < 0 || action.y > height) throw new Error('Invalid browser coordinates'); await page.mouse.click(action.x, action.y); break;
          case 'scroll': if (!Number.isFinite(action.y)) throw new Error('Invalid browser scroll'); await page.mouse.wheel(0, Math.max(-680, Math.min(680, action.y))); break;
          case 'key': if (!['Enter', 'Backspace', 'Tab', 'ArrowDown', 'ArrowUp', 'Escape'].includes(action.key)) throw new Error('Invalid browser key'); await page.keyboard.press(action.key); break;
          case 'text': if (typeof action.text !== 'string' || action.text.length > 256) throw new Error('Invalid browser text'); await page.keyboard.insertText(action.text); break;
          case 'reset': await visitor.context.clearCookies(); await page.goto(config.baseUrl, { waitUntil: 'domcontentloaded' }); break;
          default: throw new Error('Invalid browser control');
        }
      }
      const url = new URL(page.url());
      if (!allowedSourceUrl(config, url)) throw new Error('The source redirected outside its supported website');
      return { configured: true, image: (await page.screenshot({ type: 'jpeg', quality: 75 })).toString('base64'), width, height, title: await page.title(), url: page.url(), requiresVerification: challenge(await page.content()) };
    });
  }
  async request(key, input) {
    const config = source(input.source), target = new URL(input.url);
    if (!allowedSourceUrl(config, target, !!input.image)) throw new Error('Source host not allowed');
    const graphQL = config.name === 'MangaHub' && target.hostname === 'api.mghcdn.com' && target.pathname === '/graphql';
    const chapterAjax = config.name === 'Kissmanga.in' && /^\/kissmanga\/[^/]+\/ajax\/chapters\/?$/.test(target.pathname);
    if (input.method !== 'GET' && !(input.method === 'POST' && !input.image && (graphQL || chapterAjax))) throw new Error('Method not allowed');
    if (graphQL) { const parsed = JSON.parse(input.body); if (typeof parsed.query !== 'string' || !parsed.query.trim().startsWith('{') || Object.keys(parsed).some(key => key !== 'query')) throw new Error('Only source reading queries are supported'); }
    if (input.refresh && (input.image || input.method !== 'GET' || config.name !== 'MangaHub' || target.hostname !== 'mangahub.io' || !/^\/(?:manga\/[^/]+|chapter\/[^/]+\/chapter-\d+(?:\.\d+)?)\/?$/.test(target.pathname))) throw new Error('Invalid source session refresh');
    return this.run(key, input.source, async ({ page, visitor }) => {
      const accessKey = async () => (await visitor.context.cookies(config.baseUrl)).find(cookie => cookie.name === 'mhub_access' && validHubAccessKey(cookie.value))?.value;
      let result;
      if (!input.image && input.method === 'GET' && !target.pathname.startsWith('/api/')) {
        const response = await page.goto(target.href, { waitUntil: 'domcontentloaded' });
        if (!allowedSourceUrl(config, new URL(page.url()))) throw new Error('Source redirect host not allowed');
        if (input.refresh) return { status: 200, contentType: 'application/json', accessKey: await accessKey(), body: Buffer.from(JSON.stringify({ refreshed: !!(await accessKey()) })).toString('base64') };
        const body = await page.content();
        result = { status: response?.status() ?? 502, contentType: 'text/html; charset=utf-8', body: Buffer.from(body).toString('base64') };
        if (challenge(body)) result.status = 403;
      } else if (input.image) {
        const marker = 'mihon-source-image-' + Date.now();
        try {
          const [response] = await Promise.all([
            page.waitForResponse(response => {
              let request = response.request(); while (request.redirectedFrom()) request = request.redirectedFrom();
              return request.url() === target.href && !(response.status() >= 300 && response.status() < 400);
            }, { timeout: 30000 }),
            page.evaluate(({ url, marker }) => { const image = document.createElement('img'); image.id = marker; image.style.display = 'none'; image.src = url; document.body.append(image); }, { url: target.href, marker }),
          ]);
          if (!allowedSourceUrl(config, new URL(response.url()), true)) throw new Error('Source image redirect host not allowed');
          const bytes = await response.body(); if (bytes.length > 12 * 1024 * 1024) throw new Error('Source response too large');
          result = { status: response.status(), contentType: response.headers()['content-type'], body: bytes.toString('base64') };
        } finally { await page.evaluate(marker => document.getElementById(marker)?.remove(), marker).catch(() => {}); }
      } else {
        // Fetch inside the real source page: browser cookies, TLS and CORS
        // belong to the same session the user operates in verification.
        const headers = { Accept: input.image ? 'image/*' : 'application/json' };
        if (graphQL) headers['Content-Type'] = 'application/json';
        const current = await accessKey();
        if (config.name === 'MangaHub' && validHubAccessKey(current ?? input.key)) headers['x-mhub-access'] = current ?? input.key;
        result = await page.evaluate(async ({ url, method, body, headers }) => {
          const response = await fetch(url, { method, headers, ...(body === undefined ? {} : { body }), credentials: 'same-origin', signal: AbortSignal.timeout(30000) });
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (bytes.length > 12 * 1024 * 1024) throw new Error('Source response too large');
          let binary = ''; for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
          return { status: response.status, contentType: response.headers.get('Content-Type') ?? 'application/octet-stream', body: btoa(binary), url: response.url };
        }, { url: target.href, method: input.method, body: input.body, headers });
        if (!allowedSourceUrl(config, new URL(result.url), !!input.image)) throw new Error('Source redirect host not allowed');
      }
      result.accessKey = await accessKey();
      if (result.status >= 400) return { status: result.status, error: result.status === 403 ? `${config.name} requires website verification or is denying this server. Open Browser verification in Connections, then retry.` : `${config.name} request failed (HTTP ${result.status}).`, requiresVerification: result.status === 403 };
      return result;
    });
  }
  async releaseIdle(force = false) {
    for (const [key, pending] of this.visitors) {
      const visitor = await pending.catch(() => undefined);
      if (!visitor || visitor.busy || (!force && Date.now() - visitor.usedAt < this.idleMs)) continue;
      const state = await visitor.context.storageState();
      if (visitor.busy || (!force && Date.now() - visitor.usedAt < this.idleMs) || this.visitors.get(key) !== pending) continue;
      const saving = writeFile(resolve(this.stateDir, key + '.json'), JSON.stringify({ state, savedAt: Date.now() }), { mode: 0o600 });
      this.saving.set(key, saving); this.visitors.delete(key);
      try { await saving; } finally { if (this.saving.get(key) === saving) this.saving.delete(key); }
      await visitor.context.close();
    }
    if (!this.visitors.size && this.browser) { const browser = this.browser; this.browser = undefined; const closing = browser.then(browser => browser.close()); this.closing = closing; try { await closing; } finally { if (this.closing === closing) this.closing = undefined; } }
    for (const entry of await readdir(this.stateDir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
      const file = resolve(this.stateDir, entry.name);
      if (Date.now() - (await stat(file)).mtimeMs > 86400000) await unlink(file).catch(() => {});
    }
  }
  async disconnect(key) {
    const visitor = await this.visitors.get(key); if (visitor) { await visitor.queue; this.visitors.delete(key); await visitor.context.close(); }
    await unlink(resolve(this.stateDir, key + '.json')).catch(() => {});
  }
  async close() { clearInterval(this.timer); await Promise.all([...this.visitors.values()].map(async visitor => (await visitor).queue)); await this.releaseIdle(true); }
}
