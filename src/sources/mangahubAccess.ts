// Only the source's public access cookie is forwarded, never app cookies.
export function validHubAccessKey(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._~-]{1,512}$/.test(value);
}
export function returnedHubAccessKey(headers: Headers): string | undefined {
  return headers.getSetCookie().map(cookie => /(?:^|;)\s*mhub_access=([^;]+)/.exec(cookie)?.[1]).find(validHubAccessKey);
}
