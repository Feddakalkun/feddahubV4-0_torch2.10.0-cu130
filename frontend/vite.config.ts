import { createLogger, defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

function quietProxyErrors() {
  return (proxy: any) => {
    // Vite adds a noisy default error logger. Replace it so startup races
    // (backend/comfy still booting) don't spam terminal red errors.
    if (typeof proxy.removeAllListeners === 'function') {
      proxy.removeAllListeners('error')
    }
    proxy.on('error', (_err: any, _req: any, res: any) => {
      if (!res) return
      try {
        // Node http.ServerResponse
        if (typeof res.writeHead === 'function' && typeof res.end === 'function') {
          if (!res.headersSent) {
            res.writeHead(503, { 'Content-Type': 'application/json' })
          }
          res.end(JSON.stringify({ error: 'Service unavailable (starting)' }))
          return
        }

        // Fallback for response-like objects in newer proxy runtimes
        if (typeof res.setHeader === 'function') {
          res.setHeader('Content-Type', 'application/json')
        }
        if (typeof res.statusCode !== 'undefined') {
          res.statusCode = 503
        }
        if (typeof res.end === 'function') {
          res.end(JSON.stringify({ error: 'Service unavailable (starting)' }))
        }
      } catch {
        // Intentionally swallow proxy startup race errors.
      }
    })
  }
}

// https://vite.dev/config/
const viteLogger = createLogger()
const originalError = viteLogger.error
viteLogger.error = (msg, options) => {
  const text = String(msg ?? '')
  // Match without the `[vite]` prefix. Vite hands this function the bare
  // message - "http proxy error: /api/tags\nError: connect ECONNREFUSED ..." -
  // and its own logger adds the prefix and timestamp afterwards, on the way to
  // the terminal. Testing for `[vite] http proxy error` therefore never matched
  // anything. Only the port-8199 clause below did, which is why ComfyUI's
  // startup race was quiet while Ollama's poll (every 10s, forever, on any
  // machine without Ollama) filled the launcher window.
  if (
    text.includes('http proxy error') ||
    text.includes('ws proxy error') ||
    text.includes('ECONNREFUSED 127.0.0.1:8199')
  ) {
    return
  }
  originalError(msg, options)
}

export default defineConfig({
  customLogger: viteLogger,
  plugins: [react()],
  server: {
    open: true,
    proxy: {
      '/comfy': {
        target: 'http://127.0.0.1:8199',
        changeOrigin: true,
        ws: true,
        rewrite: (path) => path.replace(/^\/comfy/, ''),
        configure: (proxy: any) => {
          // ComfyUI rejects requests where Origin != Host.
          // changeOrigin sets Host=target but Vite forwards the browser's Origin unchanged.
          // For WebSocket upgrades browsers always send Origin, so the WS connection gets 403.
          // Fix: override Origin to match the target for both HTTP and WS proxied requests.
          proxy.on('proxyReq', (proxyReq: any) => {
            proxyReq.setHeader('origin', 'http://127.0.0.1:8199');
          });
          proxy.on('proxyReqWs', (proxyReq: any) => {
            proxyReq.setHeader('origin', 'http://127.0.0.1:8199');
          });
          quietProxyErrors()(proxy);
        },
      },
      '/ollama': {
        target: 'http://127.0.0.1:11434',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/ollama/, '/api'), // Rewrite /ollama/tags -> /api/tags
        configure: quietProxyErrors(),
      },
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
        configure: quietProxyErrors(),
      },
      '/ws': {
        target: 'ws://127.0.0.1:8000',
        ws: true,
        configure: quietProxyErrors(),
      },
    },
  },
})
