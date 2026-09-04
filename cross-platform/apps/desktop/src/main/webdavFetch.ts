import { getPatcher } from 'webdav'

/** Install after Electron is ready so WebDAV follows the OS proxy/PAC rules. */
export function configureWebdavFetch(fetcher: (url: string, init: RequestInit) => Promise<Response>) {
  getPatcher().patch('fetch', (...args: unknown[]) => {
    const [url, init = {}] = args as [string, RequestInit?]
    const headers = new Headers(init.headers)
    // Chromium owns framing; WebDAV's manually computed length is a forbidden
    // header in net.fetch (including PROPFIND XML and binary PUT bodies).
    headers.delete('content-length')
    headers.delete('transfer-encoding')
    return fetcher(url, {
      ...init,
      headers,
      // Journals and heads must always reflect the server's current state.
      cache: 'no-store',
      credentials: 'omit',
    })
  })
}
