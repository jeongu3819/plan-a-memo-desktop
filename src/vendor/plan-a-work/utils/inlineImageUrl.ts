/**
 * Convert a permanently stored internal `/api/...` image URL into a URL that
 * can be passed to the shared Axios client.
 *
 * The client baseURL already ends in `/api`. Passing `/api/spaces/...`
 * directly to Axios would therefore request `/api/api/spaces/...`.
 */
export function toApiClientRequestUrl(storedUrl: string, apiBaseUrl: string): string {
  const value = (storedUrl || '').trim();
  if (!value || !apiBaseUrl) return value;

  try {
    const fallbackOrigin = 'http://plan-a.invalid';
    const base = new URL(apiBaseUrl, fallbackOrigin);
    const candidate = new URL(value, base.origin);

    // Never rewrite an external image URL.
    if (candidate.origin !== base.origin) return value;

    const basePath = base.pathname.replace(/\/+$/, '');
    if (!basePath || basePath === '/') return `${candidate.pathname}${candidate.search}`;
    if (candidate.pathname === basePath) return `/${candidate.search}`;
    if (candidate.pathname.startsWith(`${basePath}/`)) {
      return `${candidate.pathname.slice(basePath.length)}${candidate.search}`;
    }
  } catch {
    // Keep legacy/malformed values unchanged; the renderer will expose a
    // regular load error without corrupting the stored HTML.
  }

  return value;
}
