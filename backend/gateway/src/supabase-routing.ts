/** Both hosted and local Edge routers may retain their function-name prefix. */
export function normalizeGatewayPath(raw: string): string {
  const url = new URL(raw, 'http://localhost')
  for (const prefix of ['/functions/v1/faangin-gateway', '/faangin-gateway']) {
    if (url.pathname === prefix || url.pathname.startsWith(prefix + '/')) { url.pathname = url.pathname.slice(prefix.length) || '/'; break }
  }
  return url.pathname + url.search
}
