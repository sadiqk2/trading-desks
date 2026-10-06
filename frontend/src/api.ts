import type { ExpiryOption, HistoricalCandle, SystemStatus, Underlying } from './types'

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    signal,
  })
  const contentType = response.headers.get('content-type') || ''
  const body = contentType.includes('application/json') ? await response.json() : null
  if (!response.ok) {
    const message = body?.error || body?.detail || `Request failed (${response.status})`
    throw new ApiError(String(message), response.status)
  }
  return body as T
}

export const api = {
  systemStatus: (signal?: AbortSignal) => request<SystemStatus>('/api/system/status', signal),
  underlyings: (signal?: AbortSignal) => request<Array<{ symbol: Underlying; label: string }>>('/api/underlyings', signal),
  expiries: (underlying: Underlying, signal?: AbortSignal) => request<ExpiryOption[]>(`/api/expiries/${underlying}`, signal),
  loginUrl: () => request<{ url: string }>('/api/auth/login-url'),
  history: (instrumentToken: number, signal?: AbortSignal) => request<{ candles: HistoricalCandle[]; source: string; tradingsymbol: string }>(`/api/history/${instrumentToken}?interval=minute`, signal),
}

export function marketWebSocketUrl(underlying?: Underlying, expiry?: string, strikeRange = 10): string {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const query = new URLSearchParams()
  if (underlying) query.set('underlying', underlying)
  if (expiry) query.set('expiry', expiry)
  query.set('strike_range', String(strikeRange))
  return `${scheme}//${window.location.host}/ws/market?${query.toString()}`
}
