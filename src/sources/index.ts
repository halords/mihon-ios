import type { Source } from './Source';
import { sampleSource } from './sampleSource';
import { mangadexSource } from './mangadexSource';

// Runtime source registry. Built-in sources register at module load;
// extension plugins (src/lib/plugins.ts) register/unregister at runtime.
// `sources` is a live array: it is mutated in place so existing imports
// that captured the binding always see the current set.
// Keep each provider so disconnecting a server or removing an extension
// reveals the previous adapter instead of deleting a built-in source.
const registry = new Map<string, Map<string, Source>>();
const listeners = new Set<() => void>();

export const sources: Source[] = [];

function syncArray(): void {
  sources.length = 0;
  for (const id of registry.keys()) {
    const source = getSource(id);
    if (source) sources.push(source);
  }
}

function notify(): void {
  for (const listener of [...listeners]) {
    listener();
  }
}

export function registerSource(source: Source, provider = source.kind ?? 'extension'): void {
  const layers = registry.get(source.id) ?? new Map<string, Source>();
  layers.set(provider, source);
  registry.set(source.id, layers);
  syncArray();
  notify();
}

export function unregisterSource(id: string, provider = 'extension'): void {
  const layers = registry.get(id);
  if (layers?.delete(provider)) {
    if (!layers.size) registry.delete(id);
    syncArray();
    notify();
  }
}

export function onSourcesChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getSource(id: string): Source | undefined {
  const layers = registry.get(id);
  return layers?.get('extension') ?? layers?.get('suwayomi') ?? layers?.get('builtin') ?? (layers ? [...layers.values()].at(-1) : undefined);
}

export function requireSource(id: string): Source {
  const source = getSource(id);
  if (!source) {
    throw new Error(`Source unavailable: ${id}`);
  }
  return source;
}

registerSource(mangadexSource, 'builtin');
registerSource(sampleSource, 'builtin');
