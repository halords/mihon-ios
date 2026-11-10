import { gunzipIfNeeded } from './compression';
import { parseTachibk } from './parser';

self.onmessage = async (event: MessageEvent<{ bytes: Uint8Array }>) => {
  try { self.postMessage({ backup: parseTachibk(await gunzipIfNeeded(event.data.bytes)) }); }
  catch (error) { self.postMessage({ error: error instanceof Error ? error.message : 'Invalid backup' }); }
};
