export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const maximumFetchAttempts = 3
const retryableHttpStatuses = new Set([403, 408, 425, 429, 500, 502, 503, 504])
const requestHeaders = {
  accept: 'application/atom+xml, application/rss+xml, application/xml;q=0.9, text/html;q=0.8, */*;q=0.5',
  'accept-language': 'en-US,en;q=0.8',
  'user-agent': 'Publume/0.1 (+https://github.com/Publume/core)',
}

function retryableFetchError(error: unknown): boolean {
  return (
    error instanceof TypeError || (error instanceof DOMException && ['AbortError', 'TimeoutError'].includes(error.name))
  )
}

export async function fetchResponse(
  fetchFn: FetchLike,
  url: string,
  timeoutMs: number,
  init: Omit<RequestInit, 'signal'> = {},
  retryableStatuses = retryableHttpStatuses,
): Promise<Response> {
  const headers = new Headers(requestHeaders)
  for (const [name, value] of new Headers(init.headers)) headers.set(name, value)
  for (let attempt = 1; attempt <= maximumFetchAttempts; attempt += 1) {
    try {
      const response = await fetchFn(url, {
        ...init,
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!retryableStatuses.has(response.status) || attempt === maximumFetchAttempts) return response
      await response.body?.cancel()
    } catch (error) {
      if (!retryableFetchError(error) || attempt === maximumFetchAttempts) throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)))
  }
  throw new Error('HTTP retry loop exhausted')
}
