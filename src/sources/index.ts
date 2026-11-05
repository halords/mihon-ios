import type { Source } from './Source';
import { sampleSource } from './sampleSource';
import { mangadexSource } from './mangadexSource';

export const sources: Source[] = [mangadexSource, sampleSource];

export function getSource(id: string): Source | undefined {
  return sources.find((source) => source.id === id);
}

export function requireSource(id: string): Source {
  const source = getSource(id);
  if (!source) {
    throw new Error(`Source unavailable: ${id}`);
  }
  return source;
}
