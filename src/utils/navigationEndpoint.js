import { DEFAULT_NAVIGATION_WEBSOCKET_URL } from '../constants/mapApp'

// 把 ws://host:port 拆成表单可编辑的主机和端口。
export function parseNavigationWebSocketUrl(url = DEFAULT_NAVIGATION_WEBSOCKET_URL) {
  try {
    const parsed = new URL(url)
    return {
      host: parsed.hostname || '127.0.0.1',
      port: parsed.port || '14514',
    }
  } catch {
    return { host: '127.0.0.1', port: '14514' }
  }
}

export function normalizeNavigationHost(value) {
  return String(value || '').trim() || parseNavigationWebSocketUrl().host
}

// 端口只接受 1-65535 的整数，非法输入回退到默认导航服务端口。
export function normalizeNavigationPort(value) {
  const port = Number(String(value || '').trim())
  return Number.isInteger(port) && port >= 1 && port <= 65535
    ? String(port)
    : parseNavigationWebSocketUrl().port
}
