import os from 'node:os'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import https from 'node:https'
import { parseTx } from './output-parser.js'
import { scanAddress } from './address-scanner.js'
import { handlePostData, handleGetTopics, handleGetData } from './data-endpoints.js'
import { createPaymentGate } from './x402-middleware.js'
import { handleWellKnownX402 } from './x402-endpoints.js'

/**
 * StatusServer — public-facing HTTP server exposing bridge status and APIs.
 *
 * Started by `relay-bridge start`, queried by `relay-bridge status`.
 * Binds to 0.0.0.0 — accessible from outside the machine.
 * Operator-only endpoints are gated by statusSecret authentication.
 *
 * Endpoints:
 *   GET  /             — HTML dashboard (auto-refreshes every 5s)
 *   GET  /status       — JSON object with bridge state
 *   GET  /discover     — Known bridges in the mesh
 *   POST /broadcast    — Relay a raw transaction
 *   POST /data         — Submit a signed data envelope
 *   GET  /data/topics  — List topics with cached data
 *   GET  /data/:topic  — Query cached envelopes by topic
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const DASHBOARD_HTML = readFileSync(join(__dirname, '..', 'dashboard', 'index.html'), 'utf8')
const PKG_VERSION = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).version
export class StatusServer {
  /**
   * @param {object} opts
   * @param {number} [opts.port=9333] — HTTP port for status endpoint
   * @param {import('./peer-manager.js').PeerManager} [opts.peerManager]
   * @param {import('./header-relay.js').HeaderRelay} [opts.headerRelay]
   * @param {import('./tx-relay.js').TxRelay} [opts.txRelay]
   * @param {object} [opts.config] — Bridge config (pubkeyHex, endpoint, meshId)
   * @param {object} [opts.bsvNodeClient] — BSV P2P node client (2.26)
   * @param {object} [opts.store] — PersistentStore for wallet balance (2.27)
   * @param {object} [opts.addressWatcher] — AddressWatcher for local UTXO tracking
   */
  constructor (opts = {}) {
    this._port = opts.port || 9333
    this._peerManager = opts.peerManager || null
    this._headerRelay = opts.headerRelay || null
    this._txRelay = opts.txRelay || null
    this._dataRelay = opts.dataRelay || null
    this._config = opts.config || {}
    this._scorer = opts.scorer || null
    this._peerHealth = opts.peerHealth || null
    this._bsvNodeClient = opts.bsvNodeClient || null
    this._store = opts.store || null
    this._addressWatcher = opts.addressWatcher || null
    this._performOutboundHandshake = opts.performOutboundHandshake || null
    this._registeredPubkeys = opts.registeredPubkeys || null
    this._gossipManager = opts.gossipManager || null
    this._startedAt = Date.now()
    this._server = null

    // Job system for async actions (register, deregister)
    this._jobs = new Map()
    this._jobCounter = 0

    // Log ring buffer — max 500 entries
    this._logs = []
    this._logListeners = new Set()
    this._maxLogs = 500

    // App monitoring state
    this._appChecks = new Map()
    this._requestTracker = new Map()
    this._appSSLCache = new Map()
    this._appBridgeDomains = new Set()
    this._appCheckInterval = null
    this._addressCache = new Map()
    if (this._config.apps) {
      for (const app of this._config.apps) {
        this._appChecks.set(app.url, { checks: [], lastError: null })
        if (app.bridgeDomain) {
          this._appBridgeDomains.add(app.bridgeDomain)
          this._requestTracker.set(app.bridgeDomain, { total: 0, endpoints: {}, lastSeen: null })
        }
        try { this._appBridgeDomains.add(new URL(app.url).hostname) } catch {}
      }
    }

    // x402 payment gate
    this._paymentGate = null
    if (this._config.x402?.enabled && this._config.x402?.payTo && this._store) {
      try {
        const fetchTx = async (txid, opts) => {
          // Check mempool first
          if (this._txRelay?.mempool.has(txid)) {
            const raw = this._txRelay.mempool.get(txid)
            const p = parseTx(raw)
            return { txid: p.txid, vout: p.outputs.map(o => ({ satoshis: o.satoshis, scriptPubKey: { hex: o.scriptHex } })) }
          }
          // Try BSV P2P
          if (this._bsvNodeClient) {
            try {
              const { rawHex } = await this._bsvNodeClient.getTx(txid, 5000)
              const p = parseTx(rawHex)
              return { txid: p.txid, vout: p.outputs.map(o => ({ satoshis: o.satoshis, scriptPubKey: { hex: o.scriptHex } })) }
            } catch {}
          }
          // WoC fallback
          const resp = await fetch(
            `https://api.whatsonchain.com/v1/bsv/main/tx/${txid}`,
            { signal: opts?.signal || AbortSignal.timeout(5000) }
          )
          if (!resp.ok) {
            const err = new Error(`WoC ${resp.status}`)
            err.httpStatus = resp.status
            throw err
          }
          return await resp.json()
        }
        this._paymentGate = createPaymentGate(this._config, this._store, fetchTx)
        this._store.cleanupStaleClaims().catch(() => {})
      } catch (err) {
        console.error('[x402] Failed to create payment gate:', err.message)
      }
    }
  }

  /**
   * Build the status object from current bridge state.
   * @param {object} [opts]
   * @param {boolean} [opts.authenticated=false] — Include operator-only fields
   * @returns {Promise<object>}
   */
  async getStatus ({ authenticated = false } = {}) {
    const peers = []
    if (this._peerManager) {
      for (const [pubkeyHex, conn] of this._peerManager.peers) {
        const entry = {
          pubkeyHex,
          endpoint: conn.endpoint,
          connected: !!conn.connected
        }
        if (this._scorer) {
          entry.score = Math.round(this._scorer.getScore(pubkeyHex) * 100) / 100
          const metrics = this._scorer.getMetrics(pubkeyHex)
          if (metrics) {
            entry.scoreBreakdown = {
              uptime: Math.round(metrics.uptime * 100) / 100,
              responseTime: Math.round(metrics.responseTime * 100) / 100,
              dataAccuracy: Math.round(metrics.dataAccuracy * 100) / 100,
              stakeAge: Math.round(metrics.stakeAge * 100) / 100,
              raw: metrics.raw
            }
          }
        }
        if (this._peerHealth) {
          entry.health = this._peerHealth.getStatus(pubkeyHex)
        }
        peers.push(entry)
      }
    }

    const status = {
      bridge: {
        name: this._config.name || null,
        version: PKG_VERSION,
        pubkeyHex: this._config.pubkeyHex || null,
        meshId: this._config.meshId || null,
        uptimeSeconds: Math.floor((Date.now() - this._startedAt) / 1000)
      },
      peers: {
        connected: this._peerManager ? this._peerManager.connectedCount() : 0,
        list: peers
      },
      headers: {
        bestHeight: this._headerRelay ? this._headerRelay.bestHeight : -1,
        bestHash: this._headerRelay ? this._headerRelay.bestHash : null,
        count: this._headerRelay ? this._headerRelay.headers.size : 0
      },
      txs: {
        mempool: this._txRelay ? this._txRelay.mempool.size : 0,
        known: this._txRelay ? this._txRelay.knownTxids.size : 0,
        seen: this._txRelay ? this._txRelay.seen.size : 0
      },
      bsvNode: {
        connected: this._bsvNodeClient ? this._bsvNodeClient.connectedCount > 0 : false,
        peers: this._bsvNodeClient ? this._bsvNodeClient.connectedCount : 0,
        height: this._bsvNodeClient ? this._bsvNodeClient.bestHeight : null
      },
      system: {
        totalMemMB: Math.round(os.totalmem() / 1048576),
        freeMemMB: Math.round(os.freemem() / 1048576),
        usedMemMB: Math.round((os.totalmem() - os.freemem()) / 1048576),
        processRssMB: Math.round(process.memoryUsage.rss() / 1048576),
        cpuCount: os.cpus().length,
        loadAvg: os.loadavg().map(v => Math.round(v * 100) / 100),
        platform: os.platform(),
        arch: os.arch(),
        nodeVersion: process.version,
        osUptime: Math.floor(os.uptime())
      }
    }

    // Operator-only fields
    if (authenticated) {
      status.operator = true
      status.bridge.endpoint = this._config.endpoint || null
      status.bridge.domains = this._config.domains || []
      try {
        const { PrivateKey } = await import('@bsv/sdk')
        status.bridge.address = PrivateKey.fromWif(this._config.wif).toPublicKey().toAddress()
      } catch {
        status.bridge.address = this._config.address || null
      }
      status.wallet = { balanceSats: null, utxoCount: 0 }
      if (this._store) {
        try { status.wallet.balanceSats = await this._store.getBalance() } catch {}
        try { status.wallet.utxoCount = (await this._store.getUnspentUtxos()).length } catch {}
      }
    }

    return status
  }

  /**
   * Check if a request is authenticated via statusSecret.
   * @param {import('node:http').IncomingMessage} req
   * @returns {boolean}
   */
  _checkAuth (req) {
    const secret = this._config.statusSecret
    if (!secret) return false

    // Check ?auth= query param
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    const authParam = url.searchParams.get('auth')
    if (authParam === secret) return true

    // Check Authorization: Bearer header
    const authHeader = req.headers.authorization
    if (authHeader && authHeader.startsWith('Bearer ') && authHeader.slice(7) === secret) return true

    return false
  }

  /**
   * Add a log entry to the ring buffer and notify SSE listeners.
   * @param {string} message
   */
  addLog (message) {
    const entry = { timestamp: Date.now(), message }
    this._logs.push(entry)
    if (this._logs.length > this._maxLogs) {
      this._logs.shift()
    }
    // Notify SSE listeners
    for (const listener of this._logListeners) {
      listener(entry)
    }
  }

  /**
   * Create a job for tracking async actions.
   * @returns {{ jobId: string, log: function }}
   */
  _createJob () {
    const jobId = `job_${++this._jobCounter}_${Date.now()}`
    const job = { status: 'running', events: [], done: false, listeners: new Set() }
    this._jobs.set(jobId, job)

    // Auto-cleanup after 5 minutes
    setTimeout(() => this._jobs.delete(jobId), 5 * 60 * 1000)

    const log = (type, message, data) => {
      const event = { type, message, data, timestamp: Date.now() }
      job.events.push(event)
      if (type === 'done' || type === 'error') {
        job.status = type === 'error' ? 'failed' : 'completed'
        job.done = true
      }
      // Notify SSE listeners
      for (const listener of job.listeners) {
        listener(event)
      }
    }

    return { jobId, log }
  }

  /**
   * Read the full JSON body from a request.
   * @param {import('node:http').IncomingMessage} req
   * @returns {Promise<object>}
   */
  _readBody (req) {
    return new Promise((resolve, reject) => {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        try { resolve(body ? JSON.parse(body) : {}) } catch (e) { reject(e) }
      })
      req.on('error', reject)
    })
  }

  /**
   * Check SSL certificate for a hostname.
   */
  _checkSSL (hostname) {
    return new Promise((resolve) => {
      const req = https.request({ hostname, port: 443, method: 'HEAD', rejectUnauthorized: false, timeout: 5000 }, (res) => {
        const cert = res.socket.getPeerCertificate()
        if (!cert || !cert.valid_to) { resolve(null); req.destroy(); return }
        resolve({
          valid: res.socket.authorized,
          issuer: cert.issuer?.O || cert.issuer?.CN || 'Unknown',
          expiresAt: new Date(cert.valid_to).toISOString(),
          daysRemaining: Math.floor((new Date(cert.valid_to) - Date.now()) / 86400000)
        })
        req.destroy()
      })
      req.on('error', () => resolve(null))
      req.setTimeout(5000, () => { req.destroy(); resolve(null) })
      req.end()
    })
  }

  /**
   * Health-check a single app.
   */
  async _checkApp (app) {
    const entry = this._appChecks.get(app.url)
    if (!entry) return
    const start = Date.now()
    let statusCode = 0
    let up = false
    let errorMsg = null
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5000)
      const res = await fetch(app.healthUrl || app.url, { method: app.healthUrl ? 'GET' : 'HEAD', signal: controller.signal, redirect: 'follow' })
      clearTimeout(timeout)
      statusCode = res.status
      up = statusCode >= 200 && statusCode < 400
    } catch (err) {
      errorMsg = err.message || 'Request failed'
    }
    const check = { timestamp: new Date().toISOString(), up, statusCode, responseTimeMs: Date.now() - start }
    entry.checks.push(check)
    if (entry.checks.length > 100) entry.checks.shift()
    if (!up) entry.lastError = { message: errorMsg || `HTTP ${statusCode}`, timestamp: check.timestamp }
  }

  /**
   * Run health checks on all configured apps.
   */
  async _checkAllApps () {
    if (!this._config.apps) return
    for (const app of this._config.apps) {
      await this._checkApp(app)
    }
  }

  /**
   * Start background app health monitoring (30s interval).
   */
  startAppMonitoring () {
    if (!this._config.apps || this._config.apps.length === 0) return
    this._checkAllApps()
    this._appCheckInterval = setInterval(() => this._checkAllApps(), 30000)
  }

  /**
   * Stop background app health monitoring.
   */
  stopAppMonitoring () {
    if (this._appCheckInterval) {
      clearInterval(this._appCheckInterval)
      this._appCheckInterval = null
    }
  }

  /**
   * Start the HTTP server on localhost.
   * @returns {Promise<void>}
   */
  start () {
    return new Promise((resolve, reject) => {
      this._server = createServer((req, res) => {
        // CORS headers for federation dashboard
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

        if (req.method === 'OPTIONS') {
          res.writeHead(204)
          res.end()
          return
        }

        this._handleRequest(req, res).catch(() => {
          res.writeHead(500)
          res.end('Internal Server Error')
        })
      })

      this._server.listen(this._port, '0.0.0.0', () => resolve())
      this._server.on('error', reject)
    })
  }

  /**
   * Route incoming HTTP requests.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async _handleRequest (req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    const path = url.pathname
    const authenticated = this._checkAuth(req)

    // Track requests from known app domains
    const origin = req.headers.origin || req.headers.referer || ''
    const host = (req.headers.host || '').split(':')[0]
    let trackDomain = null
    if (origin) { try { trackDomain = new URL(origin).hostname } catch {} }
    if (!trackDomain && host && this._appBridgeDomains.has(host)) trackDomain = host
    if (trackDomain && this._appBridgeDomains.has(trackDomain)) {
      let bridgeDomain = trackDomain
      if (this._config.apps) {
        for (const app of this._config.apps) {
          try { if (trackDomain === new URL(app.url).hostname) { bridgeDomain = app.bridgeDomain; break } } catch {}
        }
      }
      const data = this._requestTracker.get(bridgeDomain)
      if (data) {
        data.total++
        let ep = path
        if (path.startsWith('/tx/')) ep = '/tx/:txid'
        else if (path.startsWith('/inscription/')) ep = '/inscription/:content'
        else if (path.startsWith('/jobs/')) ep = '/jobs/:id'
        data.endpoints[ep] = (data.endpoints[ep] || 0) + 1
        data.lastSeen = new Date().toISOString()
      }
    }

    // GET /.well-known/x402 — pricing discovery (always free)
    if (req.method === 'GET' && path === '/.well-known/x402') {
      handleWellKnownX402(this._config, PKG_VERSION, res)
      return
    }

    // x402 payment gate — authenticated (operator) requests bypass
    if (this._paymentGate && !authenticated) {
      const result = await this._paymentGate(req.method, path, req)
      if (!result.ok) {
        res.writeHead(result.status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result.body))
        return
      }
      if (result.receipt) req._x402Receipt = result.receipt
    }

    // GET /status — public or operator status
    if (req.method === 'GET' && path === '/status') {
      const status = await this.getStatus({ authenticated })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(status))
      return
    }

    // GET /mempool — public decoded mempool transactions
    if (req.method === 'GET' && path === '/mempool') {
      const txs = []
      if (this._txRelay) {
        for (const [txid, rawHex] of this._txRelay.mempool) {
          try {
            const parsed = parseTx(rawHex)
            txs.push({
              txid,
              size: rawHex.length / 2,
              inputs: parsed.inputs,
              outputs: parsed.outputs.map(o => ({
                vout: o.vout,
                satoshis: o.satoshis,
                isP2PKH: o.isP2PKH,
                hash160: o.hash160,
                type: o.type,
                data: o.data ? o.data.map(d => d.length > 128 ? d.slice(0, 128) + '...' : d) : o.data,
                protocol: o.protocol,
                parsed: o.parsed
              }))
            })
          } catch {
            txs.push({ txid, size: rawHex.length / 2, inputs: [], outputs: [], error: 'decode failed' })
          }
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ count: txs.length, txs }))
      return
    }

    // GET /mempool/known/:txid — fast check if txid was seen on the BSV network
    const knownMatch = path.match(/^\/mempool\/known\/([0-9a-f]{64})$/)
    if (req.method === 'GET' && knownMatch) {
      const txid = knownMatch[1]
      if (this._txRelay && this._txRelay.mempool.has(txid)) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ known: true, source: 'mempool' }))
      } else if (this._txRelay && this._txRelay.knownTxids.has(txid)) {
        const firstSeen = this._txRelay.knownTxids.get(txid)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ known: true, source: 'inv', firstSeen }))
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ known: false }))
      }
      return
    }

    // GET /discover — public list of all known bridges in the mesh
    if (req.method === 'GET' && path === '/discover') {
      const bridges = []
      // Add self
      bridges.push({
        name: this._config.name || null,
        pubkeyHex: this._config.pubkeyHex || null,
        endpoint: this._config.endpoint || null,
        meshId: this._config.meshId || null,
        statusUrl: 'http://' + (req.headers.host || '127.0.0.1:' + this._port) + '/status'
      })
      // Add gossip directory (all known peers)
      if (this._gossipManager) {
        for (const peer of this._gossipManager.getDirectory()) {
          // Derive statusUrl from ws endpoint: ws://host:8333 → http://host:9333
          let statusUrl = null
          try {
            const u = new URL(peer.endpoint)
            const statusPort = parseInt(u.port, 10) + 1000
            statusUrl = 'http://' + u.hostname + ':' + statusPort + '/status'
          } catch {}
          bridges.push({
            pubkeyHex: peer.pubkeyHex,
            endpoint: peer.endpoint,
            meshId: peer.meshId || null,
            statusUrl
          })
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({ count: bridges.length, bridges }))
      return
    }

    // GET / or /dashboard — built-in HTML dashboard
    if (req.method === 'GET' && (path === '/' || path === '/dashboard')) {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(DASHBOARD_HTML)
      return
    }

    // POST /broadcast — relay a raw tx to peers
    if (req.method === 'POST' && path === '/broadcast') {
      const body = await this._readBody(req)
      const { rawHex } = body
      if (!rawHex || typeof rawHex !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'rawHex required' }))
        return
      }
      const buf = Buffer.from(rawHex, 'hex')
      const hash = createHash('sha256').update(createHash('sha256').update(buf).digest()).digest()
      const txid = Buffer.from(hash).reverse().toString('hex')
      const sent = this._txRelay ? this._txRelay.broadcastTx(txid, rawHex) : 0
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ txid, peers: sent }))
      return
    }

    // POST /data — submit a signed data envelope for relay
    if (req.method === 'POST' && path === '/data') {
      if (!this._dataRelay) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Data relay not available' }))
        return
      }
      let body
      try {
        body = await this._readBody(req)
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid_json' }))
        return
      }
      handlePostData(this._dataRelay, body, res)
      return
    }

    // GET /data/topics — list topics with summary objects
    if (req.method === 'GET' && path === '/data/topics') {
      if (!this._dataRelay) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Data relay not available' }))
        return
      }
      handleGetTopics(this._dataRelay, res)
      return
    }

    // GET /data/:topic — query cached envelopes with since/limit/hasMore
    if (req.method === 'GET' && path.startsWith('/data/')) {
      if (!this._dataRelay) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Data relay not available' }))
        return
      }
      const topic = decodeURIComponent(path.slice(6))
      if (!topic) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Topic required' }))
        return
      }
      handleGetData(this._dataRelay, topic, url.searchParams, res)
      return
    }

    // GET /tx/:txid — fetch and parse transaction with full protocol support
    if (req.method === 'GET' && path.startsWith('/tx/')) {
      const txid = path.slice(4)
      if (!txid || txid.length !== 64) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Invalid txid' }))
        return
      }

      let rawHex = null
      let source = null

      // Check mempool first
      if (this._txRelay && this._txRelay.mempool.has(txid)) {
        rawHex = this._txRelay.mempool.get(txid)
        source = 'mempool'
      }

      // Try P2P
      if (!rawHex && this._bsvNodeClient) {
        try {
          const result = await this._bsvNodeClient.getTx(txid, 5000)
          rawHex = result.rawHex
          source = 'p2p'
        } catch {}
      }

      // Fall back to WoC
      if (!rawHex) {
        try {
          const resp = await fetch(`https://api.whatsonchain.com/v1/bsv/main/tx/${txid}/hex`)
          if (!resp.ok) throw new Error(`WoC ${resp.status}`)
          rawHex = await resp.text()
          source = 'woc'
        } catch (err) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: `tx not found: ${err.message}` }))
          return
        }
      }

      // Parse with full protocol support
      try {
        const parsed = parseTx(rawHex)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          txid: parsed.txid,
          source,
          size: rawHex.length / 2,
          inputs: parsed.inputs,
          outputs: parsed.outputs
        }))
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ txid, source, size: rawHex.length / 2, error: 'parse failed: ' + err.message }))
      }
      return
    }

    // POST /register — operator: start async registration
    if (req.method === 'POST' && path === '/register') {
      if (!authenticated) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized. Provide statusSecret via ?auth= or Authorization header.' }))
        return
      }
      const { runRegister } = await import('./actions.js')
      const { jobId, log } = this._createJob()
      res.writeHead(202, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jobId, stream: `/jobs/${jobId}` }))
      // Run async — don't await
      runRegister({ config: this._config, store: this._store, log }).catch(err => {
        log('error', err.message)
      })
      return
    }

    // POST /deregister — operator: start async deregistration
    if (req.method === 'POST' && path === '/deregister') {
      if (!authenticated) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized. Provide statusSecret via ?auth= or Authorization header.' }))
        return
      }
      const { runDeregister } = await import('./actions.js')
      const body = await this._readBody(req)
      const { jobId, log } = this._createJob()
      res.writeHead(202, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jobId, stream: `/jobs/${jobId}` }))
      runDeregister({ config: this._config, store: this._store, reason: body.reason || 'shutdown', log }).catch(err => {
        log('error', err.message)
      })
      return
    }

    // POST /fund — operator: store a funding tx (synchronous)
    if (req.method === 'POST' && path === '/fund') {
      if (!authenticated) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized. Provide statusSecret via ?auth= or Authorization header.' }))
        return
      }
      const { runFund } = await import('./actions.js')
      const body = await this._readBody(req)
      if (!body.rawHex) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'rawHex required' }))
        return
      }
      try {
        const result = await runFund({ config: this._config, store: this._store, rawHex: body.rawHex, log: () => {} })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: err.message }))
      }
      return
    }

    // POST /connect — operator: connect to a peer endpoint
    if (req.method === 'POST' && path === '/connect') {
      if (!authenticated) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized. Provide statusSecret via ?auth= or Authorization header.' }))
        return
      }
      const body = await this._readBody(req)
      if (!body.endpoint) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'endpoint required (e.g. ws://host:port)' }))
        return
      }
      if (!this._peerManager || !this._performOutboundHandshake) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Bridge not running — peer manager unavailable' }))
        return
      }
      try {
        const conn = this._peerManager.connectToPeer({ endpoint: body.endpoint })
        if (conn) {
          conn.on('open', () => this._performOutboundHandshake(conn))
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ endpoint: body.endpoint, status: 'connecting' }))
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ endpoint: body.endpoint, status: 'already_connected_or_failed' }))
        }
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: err.message }))
      }
      return
    }

    // POST /send — operator: send BSV from bridge wallet
    if (req.method === 'POST' && path === '/send') {
      if (!authenticated) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized. Provide statusSecret via ?auth= or Authorization header.' }))
        return
      }
      const { runSend } = await import('./actions.js')
      const body = await this._readBody(req)
      if (!body.toAddress || !body.amount) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'toAddress and amount required' }))
        return
      }
      const { jobId, log } = this._createJob()
      res.writeHead(202, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jobId, stream: `/jobs/${jobId}` }))
      runSend({ config: this._config, store: this._store, toAddress: body.toAddress, amount: Number(body.amount), log }).catch(err => {
        log('error', err.message)
      })
      return
    }

    // GET /jobs/:id — SSE stream for job progress
    if (req.method === 'GET' && path.startsWith('/jobs/')) {
      const jobId = path.slice(6)
      const job = this._jobs.get(jobId)
      if (!job) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Job not found' }))
        return
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      })
      // Replay past events
      for (const event of job.events) {
        res.write(`data: ${JSON.stringify(event)}\n\n`)
      }
      if (job.done) {
        res.write(`data: ${JSON.stringify({ type: 'end', status: job.status })}\n\n`)
        res.end()
        return
      }
      // Stream new events
      const listener = (event) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`)
        if (event.type === 'done' || event.type === 'error') {
          res.write(`data: ${JSON.stringify({ type: 'end', status: event.type === 'error' ? 'failed' : 'completed' })}\n\n`)
          res.end()
          job.listeners.delete(listener)
        }
      }
      job.listeners.add(listener)
      req.on('close', () => job.listeners.delete(listener))
      return
    }

    // GET /logs — SSE stream of live bridge logs
    if (req.method === 'GET' && path === '/logs') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      })
      // Replay buffer
      for (const entry of this._logs) {
        res.write(`data: ${JSON.stringify(entry)}\n\n`)
      }
      // Stream new
      const listener = (entry) => {
        res.write(`data: ${JSON.stringify(entry)}\n\n`)
      }
      this._logListeners.add(listener)
      req.on('close', () => this._logListeners.delete(listener))
      return
    }

    // GET /inscriptions — query indexed inscriptions
    if (req.method === 'GET' && path === '/inscriptions') {
      if (!this._store) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Store not available' }))
        return
      }
      const mime = url.searchParams.get('mime')
      const address = url.searchParams.get('address')
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 200)
      try {
        const inscriptions = await this._store.getInscriptions({ mime, address, limit })
        const total = await this._store.getInscriptionCount()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ total, count: inscriptions.length, inscriptions, filters: { mime: mime || null, address: address || null } }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: err.message }))
      }
      return
    }

    // GET /address/:addr/history — local sessions first, WoC fallback
    const addrMatch = path.match(/^\/address\/([13][a-km-zA-HJ-NP-Z1-9]{24,33})\/history$/)
    if (req.method === 'GET' && addrMatch) {
      const addr = addrMatch[1]
      const cached = this._addressCache.get(addr)
      if (cached && Date.now() - cached.time < 60000) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ address: addr, history: cached.data, cached: true }))
        return
      }
      try {
        // Local sessions from LevelDB (source of truth)
        const localSessions = await this._store.getSessions(addr, 2000)
        const seen = new Set(localSessions.map(s => s.txId))
        const history = localSessions.map(s => ({ tx_hash: s.txId, height: -1 }))

        // WoC fallback for older txs + block heights
        try {
          const resp = await fetch('https://api.whatsonchain.com/v1/bsv/main/address/' + addr + '/confirmed/history', { signal: AbortSignal.timeout(10000) })
          if (resp.ok) {
            const data = await resp.json()
            const wocHistory = Array.isArray(data) ? data : (data.result || [])
            for (const entry of wocHistory) {
              if (seen.has(entry.tx_hash)) {
                const match = history.find(h => h.tx_hash === entry.tx_hash)
                if (match && entry.height > 0) match.height = entry.height
              } else {
                history.push(entry)
                seen.add(entry.tx_hash)
              }
            }
          }
        } catch {} // WoC failure doesn't block response

        this._addressCache.set(addr, { data: history, time: Date.now() })
        if (this._addressCache.size > 100) {
          const oldest = this._addressCache.keys().next().value
          this._addressCache.delete(oldest)
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ address: addr, history, cached: false }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Failed to fetch address history: ' + err.message }))
      }
      return
    }

    // GET /price — cached BSV/USD exchange rate
    if (req.method === 'GET' && path === '/price') {
      const now = Date.now()
      if (!this._priceCache || now - this._priceCache.timestamp > 60000) {
        try {
          const resp = await fetch('https://api.whatsonchain.com/v1/bsv/main/exchangerate')
          if (resp.ok) {
            const data = await resp.json()
            this._priceCache = { data, timestamp: now }
          }
        } catch {}
      }
      if (this._priceCache) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          usd: this._priceCache.data.rate || this._priceCache.data.USD,
          currency: 'USD',
          source: 'whatsonchain',
          cached: this._priceCache.timestamp,
          ttl: 60000
        }))
        return
      }
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Price unavailable' }))
      return
    }

    // GET /tokens — list all deployed tokens
    if (req.method === 'GET' && path === '/tokens') {
      if (!this._store) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Store not available' }))
        return
      }
      const tokens = await this._store.listTokens()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ tokens }))
      return
    }

    // GET /token/:tick — token deploy info
    const tokenMatch = path.match(/^\/token\/([^/]+)$/)
    if (req.method === 'GET' && tokenMatch) {
      if (!this._store) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Store not available' }))
        return
      }
      const token = await this._store.getToken(decodeURIComponent(tokenMatch[1]))
      if (!token) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Token not found' }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(token))
      return
    }

    // GET /token/:tick/balance/:scriptHash — token balance for owner
    const balMatch = path.match(/^\/token\/([^/]+)\/balance\/([0-9a-f]{64})$/)
    if (req.method === 'GET' && balMatch) {
      if (!this._store) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Store not available' }))
        return
      }
      const tick = decodeURIComponent(balMatch[1])
      const ownerScriptHash = balMatch[2]
      const balance = await this._store.getTokenBalance(tick, ownerScriptHash)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ tick, ownerScriptHash, balance }))
      return
    }

    // GET /tx/:txid/status — tx lifecycle state
    const statusMatch = path.match(/^\/tx\/([0-9a-f]{64})\/status$/)
    if (req.method === 'GET' && statusMatch) {
      if (!this._store) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Store not available' }))
        return
      }
      const txid = statusMatch[1]
      const status = await this._store.getTxStatus(txid)
      const block = await this._store.getTxBlock(txid)
      if (!status) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Transaction not found' }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ txid, ...status, block: block || undefined }))
      return
    }

    // GET /proof/:txid — merkle proof for confirmed tx
    const proofMatch = path.match(/^\/proof\/([0-9a-f]{64})$/)
    if (req.method === 'GET' && proofMatch) {
      if (!this._store) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Store not available' }))
        return
      }
      const txid = proofMatch[1]
      const block = await this._store.getTxBlock(txid)
      if (!block || !block.proof) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Proof not available' }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ txid, blockHash: block.blockHash, height: block.height, proof: block.proof }))
      return
    }

    // GET /inscription/:txid/:vout/content — serve raw inscription content
    const inscMatch = path.match(/^\/inscription\/([0-9a-f]{64})\/(\d+)\/content$/)
    if (req.method === 'GET' && inscMatch) {
      if (!this._store) {
        res.writeHead(500, { 'Content-Type': 'text/plain' })
        res.end('Store not available')
        return
      }
      try {
        const record = await this._store.getInscription(inscMatch[1], parseInt(inscMatch[2], 10))
        if (!record) {
          res.writeHead(404, { 'Content-Type': 'text/plain' })
          res.end('Not found')
          return
        }
        // Resolve content: inline hex first, then CAS fallback
        let buf = record.content ? Buffer.from(record.content, 'hex') : null
        if (!buf && record.contentHash) {
          buf = await this._store.getContentBytes(record.contentHash)
        }
        if (!buf) {
          res.writeHead(404, { 'Content-Type': 'text/plain' })
          res.end('Content not available')
          return
        }
        res.writeHead(200, {
          'Content-Type': record.contentType || 'application/octet-stream',
          'Content-Length': buf.length,
          'Cache-Control': 'public, max-age=31536000, immutable'
        })
        res.end(buf)
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' })
        res.end(err.message)
      }
      return
    }

    // POST /scan-address — scan an address for inscriptions via WhatsOnChain
    if (req.method === 'POST' && path === '/scan-address') {
      if (!this._store) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Store not available' }))
        return
      }
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', async () => {
        try {
          const { address } = JSON.parse(body)
          if (!address || typeof address !== 'string' || address.length < 25 || address.length > 35) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Invalid address' }))
            return
          }

          // Stream progress via SSE
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
          })

          const result = await scanAddress(address, this._store, (progress) => {
            res.write('data: ' + JSON.stringify(progress) + '\n\n')
          })

          res.write('data: ' + JSON.stringify({ phase: 'complete', result }) + '\n\n')
          res.end()
        } catch (err) {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: err.message }))
          } else {
            res.write('data: ' + JSON.stringify({ phase: 'error', error: err.message }) + '\n\n')
            res.end()
          }
        }
      })
      return
    }

    // POST /rebuild-inscription-index — deduplicate and rebuild secondary indexes
    if (req.method === 'POST' && path === '/rebuild-inscription-index') {
      if (!this._store) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Store not available' }))
        return
      }
      try {
        const count = await this._store.rebuildInscriptionIndex()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ rebuilt: count }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: err.message }))
      }
      return
    }

    // GET /apps — app health, SSL, and usage data
    if (req.method === 'GET' && path === '/apps') {
      const apps = []
      if (this._config.apps) {
        for (const app of this._config.apps) {
          const entry = this._appChecks.get(app.url) || { checks: [], lastError: null }
          const checks = entry.checks
          const checksUp = checks.filter(c => c.up).length
          const latest = checks.length > 0 ? checks[checks.length - 1] : null

          let ssl = null
          try {
            const hostname = new URL(app.url).hostname
            const cached = this._appSSLCache.get(hostname)
            if (cached && cached.data && Date.now() - cached.checkedAt < 3600000) {
              ssl = cached.data
            } else {
              ssl = await this._checkSSL(hostname)
              this._appSSLCache.set(hostname, { data: ssl, checkedAt: Date.now() })
            }
          } catch {}

          const usage = this._requestTracker.get(app.bridgeDomain) || { total: 0, endpoints: {}, lastSeen: null }

          apps.push({
            name: app.name,
            url: app.url,
            bridgeDomain: app.bridgeDomain,
            health: {
              status: latest ? (latest.up ? 'online' : 'offline') : 'unknown',
              statusCode: latest ? latest.statusCode : 0,
              responseTimeMs: latest ? latest.responseTimeMs : 0,
              lastCheck: latest ? latest.timestamp : null,
              lastError: entry.lastError,
              uptimePercent: checks.length > 0 ? Math.round((checksUp / checks.length) * 1000) / 10 : 0,
              checksTotal: checks.length,
              checksUp
            },
            ssl,
            usage: {
              totalRequests: usage.total,
              endpoints: { ...usage.endpoints },
              lastSeen: usage.lastSeen
            }
          })
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ apps }))
      return
    }

    // GET /x402 — payment gate stats (operator-only details when authenticated)
    if (req.method === 'GET' && path === '/x402') {
      const x402Config = this._config.x402 || {}
      const enabled = !!(x402Config.enabled && x402Config.payTo)
      const result = {
        enabled,
        payTo: x402Config.payTo || '',
        endpoints: []
      }

      // Build pricing table
      if (x402Config.endpoints) {
        for (const [key, satoshis] of Object.entries(x402Config.endpoints)) {
          const colonIdx = key.indexOf(':')
          if (colonIdx === -1) continue
          result.endpoints.push({
            method: key.slice(0, colonIdx),
            path: key.slice(colonIdx + 1),
            satoshis
          })
        }
      }

      // Read receipts from LevelDB if store is available
      if (this._store && this._store._paymentReceipts) {
        let totalReceipts = 0
        let totalSatsEarned = 0n
        let pendingClaims = 0
        const recentReceipts = []
        const now = Date.now()
        const oneDayAgo = now - 86400000
        const oneWeekAgo = now - 604800000
        let todaySats = 0n
        let weekSats = 0n

        try {
          for await (const [key, val] of this._store._paymentReceipts.iterator({ gte: 'u!', lt: 'u~' })) {
            if (val.status === 'receipt') {
              totalReceipts++
              const paid = BigInt(val.satoshisPaid || val.satoshisRequired || '0')
              totalSatsEarned += paid
              if (val.createdAt && val.createdAt > oneDayAgo) todaySats += paid
              if (val.createdAt && val.createdAt > oneWeekAgo) weekSats += paid
              if (recentReceipts.length < 20) {
                recentReceipts.push({
                  txid: val.txid || key.slice(2),
                  satoshisPaid: (val.satoshisPaid || val.satoshisRequired || '0'),
                  endpoint: val.endpointKey || val.endpoint || '',
                  createdAt: val.createdAt || null
                })
              }
            } else if (val.status === 'claimed') {
              pendingClaims++
            }
          }
        } catch {}

        result.revenue = {
          totalReceipts,
          totalSatsEarned: totalSatsEarned.toString(),
          todaySats: todaySats.toString(),
          weekSats: weekSats.toString(),
          pendingClaims
        }
        if (authenticated) {
          result.recentReceipts = recentReceipts.reverse()
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
      return
    }

    // PATCH /x402 — update x402 settings (operator-only)
    if (req.method === 'PATCH' && path === '/x402') {
      if (!authenticated) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }

      try {
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const body = JSON.parse(Buffer.concat(chunks).toString())

        // Update in-memory config
        if (!this._config.x402) this._config.x402 = {}
        if (body.enabled !== undefined) this._config.x402.enabled = !!body.enabled
        if (body.payTo !== undefined) this._config.x402.payTo = String(body.payTo)
        if (body.endpoints !== undefined && typeof body.endpoints === 'object') {
          // Validate all prices are non-negative safe integers
          for (const [key, price] of Object.entries(body.endpoints)) {
            if (!Number.isSafeInteger(price) || price < 0) {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: `Invalid price for ${key}: must be a non-negative integer` }))
              return
            }
          }
          this._config.x402.endpoints = body.endpoints
        }

        // Write config to disk
        const configDir = this._config.dataDir ? dirname(this._config.dataDir) : join(os.homedir(), '.relay-bridge')
        const configPath = join(configDir, 'config.json')
        writeFileSync(configPath, JSON.stringify(this._config, null, 2))

        // Recreate payment gate with new settings
        if (this._config.x402.enabled && this._config.x402.payTo && this._store) {
          try {
            const fetchTx = async (txid, opts) => {
              const resp = await fetch(
                `https://api.whatsonchain.com/v1/bsv/main/tx/${txid}`,
                { signal: opts?.signal || AbortSignal.timeout(5000) }
              )
              if (!resp.ok) {
                const err = new Error(`WoC ${resp.status}`)
                err.httpStatus = resp.status
                throw err
              }
              return await resp.json()
            }
            this._paymentGate = createPaymentGate(this._config, this._store, fetchTx)
          } catch (err) {
            console.error('[x402] Failed to recreate payment gate:', err.message)
            this._paymentGate = null
          }
        } else {
          this._paymentGate = null
        }

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, x402: this._config.x402 }))
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: err.message }))
      }
      return
    }

    // GET /health — MCP/CLI compatibility
    if (req.method === 'GET' && path === '/health') {
      const status = await this.getStatus()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        status: 'ok',
        headerHeight: status.headers.bestHeight,
        connectedPeers: status.bsvNode.peers,
        synced: status.headers.bestHeight > 0
      }))
      return
    }

    // GET /api/address/:addr/unspent — local store first, GorillaPool fallback
    const unspentMatch = path.match(/^\/api\/address\/([13][a-km-zA-HJ-NP-Z1-9]{24,33})\/unspent$/)
    if (req.method === 'GET' && unspentMatch) {
      const addr = unspentMatch[1]

      // Auto-watch this address so future P2P txs are tracked locally
      if (this._addressWatcher) {
        try { this._addressWatcher.watchAddress(addr) } catch {}
      }

      // Query both local store and GorillaPool in parallel, merge, dedupe
      const localPromise = this._store
        ? this._store.getUnspentByAddress(addr).catch(() => [])
        : Promise.resolve([])
      const gpPromise = fetch(
        `https://ordinals.gorillapool.io/api/txos/address/${addr}/unspent`,
        { signal: AbortSignal.timeout(10000) }
      ).then(r => r.ok ? r.json() : []).catch(() => [])

      const [localUtxos, gpData] = await Promise.all([localPromise, gpPromise])

      // Merge GP + local, filtering out UTXOs spent by recent broadcasts.
      // GP is authoritative for confirmed UTXOs but doesn't know about
      // unconfirmed spends. Local store tracks both new outputs and spends.
      const seen = new Set()
      const merged = []

      // Start with GP data, filter out locally-spent inputs
      for (const u of gpData) {
        const key = `${u.txid}:${u.vout}`
        if (seen.has(key)) continue
        let spent = false
        if (this._store) {
          try { spent = await this._store.isInputSpent(u.txid, u.vout) } catch {}
        }
        if (!spent) { seen.add(key); merged.push({ tx_hash: u.txid, tx_pos: u.vout, value: u.satoshis }) }
      }

      // Add local unspent UTXOs that GP doesn't have (unconfirmed outputs)
      for (const u of localUtxos) {
        const key = `${u.txid}:${u.vout}`
        if (!seen.has(key)) { seen.add(key); merged.push({ tx_hash: u.txid, tx_pos: u.vout, value: u.satoshis }) }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(merged))
      return
    }

    // GET /api/tx/:txid/hex — raw transaction hex
    const hexMatch = path.match(/^\/api\/tx\/([0-9a-f]{64})\/hex$/)
    if (req.method === 'GET' && hexMatch) {
      const txid = hexMatch[1]
      let rawHex = null
      // Mempool first
      if (this._txRelay && this._txRelay.mempool.has(txid)) {
        rawHex = this._txRelay.mempool.get(txid)
      }
      // Local PersistentStore (broadcast-tracked txs)
      if (!rawHex && this._store) {
        try {
          const stored = await this._store.getTx(txid)
          if (stored) rawHex = stored
        } catch {}
      }
      // P2P second
      if (!rawHex && this._bsvNodeClient) {
        try {
          const result = await this._bsvNodeClient.getTx(txid, 5000)
          rawHex = result.rawHex
        } catch {}
      }
      // WoC fallback
      if (!rawHex) {
        try {
          const resp = await fetch(`https://api.whatsonchain.com/v1/bsv/main/tx/${txid}/hex`)
          if (resp.ok) rawHex = await resp.text()
        } catch {}
      }
      if (rawHex) {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end(rawHex)
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'tx not found' }))
      }
      return
    }

    // POST /api/broadcast — MCP/CLI compatibility (accepts { rawTx } key)
    if (req.method === 'POST' && path === '/api/broadcast') {
      const body = await this._readBody(req)
      const rawHex = body.rawTx || body.rawHex
      if (!rawHex || typeof rawHex !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'rawTx or rawHex required' }))
        return
      }
      if (!/^[0-9a-fA-F]+$/.test(rawHex) || rawHex.length % 2 !== 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Invalid hex string' }))
        return
      }
      const buf = Buffer.from(rawHex, 'hex')
      const hash = createHash('sha256').update(createHash('sha256').update(buf).digest()).digest()
      const txid = Buffer.from(hash).reverse().toString('hex')
      const sent = this._txRelay ? this._txRelay.broadcastTx(txid, rawHex) : 0
      // Store raw tx + mark spent inputs atomically
      if (this._store) {
        try {
          await this._store.putTx(txid, rawHex)
          // Mark each input as spent so /unspent filters them immediately
          const parsed = parseTx(rawHex)
          for (const input of parsed.inputs) {
            await this._store.markInputSpent(input.prevTxid, input.prevVout, txid)
          }
        } catch {}
      }
      // AddressWatcher already processes this tx via txRelay 'tx:new' event
      // (broadcastTx above emits tx:new → AddressWatcher._processTx)
      // Removed duplicate processTxManual call that caused double UTXO events
      // Forward to ARC (fire-and-forget) so tx reaches miners
      fetch('https://arc.gorillapool.io/v1/tx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: buf,
        signal: AbortSignal.timeout(5000)
      }).catch(() => {})
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ txid, peers: sent }))
      return
    }

    // GET /api/address/:addr/history — local sessions first, WoC fallback (web app compat)
    const apiHistMatch = path.match(/^\/api\/address\/([13][a-km-zA-HJ-NP-Z1-9]{24,33})\/history$/)
    if (req.method === 'GET' && apiHistMatch) {
      const addr = apiHistMatch[1]
      const cached = this._addressCache.get(addr)
      if (cached && Date.now() - cached.time < 60000) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(cached.data))
        return
      }
      try {
        // Local sessions from LevelDB (source of truth)
        const localSessions = await this._store.getSessions(addr, 2000)
        const seen = new Set(localSessions.map(s => s.txId))
        const history = localSessions.map(s => ({ tx_hash: s.txId, height: -1 }))

        // WoC fallback for older txs + block heights
        try {
          const resp = await fetch('https://api.whatsonchain.com/v1/bsv/main/address/' + addr + '/confirmed/history', { signal: AbortSignal.timeout(10000) })
          if (resp.ok) {
            const data = await resp.json()
            const wocHistory = Array.isArray(data) ? data : (data.result || [])
            for (const entry of wocHistory) {
              if (seen.has(entry.tx_hash)) {
                const match = history.find(h => h.tx_hash === entry.tx_hash)
                if (match && entry.height > 0) match.height = entry.height
              } else {
                history.push(entry)
                seen.add(entry.tx_hash)
              }
            }
          }
        } catch {} // WoC failure doesn't block response

        this._addressCache.set(addr, { data: history, time: Date.now() })
        if (this._addressCache.size > 100) {
          const oldest = this._addressCache.keys().next().value
          this._addressCache.delete(oldest)
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(history))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Failed to fetch address history: ' + err.message }))
      }
      return
    }

    // GET /api/address/:addr/balance — local store first, GorillaPool fallback
    const apiBalMatch = path.match(/^\/api\/address\/([13][a-km-zA-HJ-NP-Z1-9]{24,33})\/balance$/)
    if (req.method === 'GET' && apiBalMatch) {
      const addr = apiBalMatch[1]

      // Auto-watch
      if (this._addressWatcher) {
        try { this._addressWatcher.watchAddress(addr) } catch {}
      }

      // Query both sources in parallel, merge, dedupe, sum
      const localBal = this._store
        ? this._store.getUnspentByAddress(addr).catch(() => [])
        : Promise.resolve([])
      const gpBal = fetch(
        `https://ordinals.gorillapool.io/api/txos/address/${addr}/unspent`,
        { signal: AbortSignal.timeout(10000) }
      ).then(r => r.ok ? r.json() : []).catch(() => [])

      const [localUtxos, gpData] = await Promise.all([localBal, gpBal])
      // GP is authoritative — it tracks the real UTXO set.
      // Local store only used as fallback when GP is down/empty.
      const seen = new Set()
      let confirmed = 0
      const source = gpData.length > 0 ? gpData : localUtxos
      for (const u of source) {
        const key = `${u.txid}:${u.vout}`
        if (!seen.has(key)) { seen.add(key); confirmed += u.satoshis || 0 }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ confirmed, unconfirmed: 0 }))
      return
    }

    // GET /api/tx/:txid — parsed tx JSON from bridge data (mempool/store/P2P)
    const apiTxMatch = path.match(/^\/api\/tx\/([0-9a-f]{64})$/)
    if (req.method === 'GET' && apiTxMatch) {
      const txid = apiTxMatch[1]
      let rawHex = null
      // Mempool first
      if (this._txRelay && this._txRelay.mempool.has(txid)) {
        rawHex = this._txRelay.mempool.get(txid)
      }
      // Local PersistentStore
      if (!rawHex && this._store) {
        try {
          const stored = await this._store.getTx(txid)
          if (stored) rawHex = stored
        } catch {}
      }
      // P2P
      if (!rawHex && this._bsvNodeClient) {
        try {
          const result = await this._bsvNodeClient.getTx(txid, 5000)
          rawHex = result.rawHex
        } catch {}
      }
      if (!rawHex) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'tx not found' }))
        return
      }
      try {
        const buf = Buffer.from(rawHex, 'hex')
        let pos = 4
        const readVarint = () => {
          const first = buf[pos++]
          if (first < 0xfd) return first
          if (first === 0xfd) { const v = buf.readUInt16LE(pos); pos += 2; return v }
          if (first === 0xfe) { const v = buf.readUInt32LE(pos); pos += 4; return v }
          const v = Number(buf.readBigUInt64LE(pos)); pos += 8; return v
        }
        const inCount = readVarint()
        for (let i = 0; i < inCount; i++) {
          pos += 32 + 4
          const scriptLen = readVarint()
          pos += scriptLen + 4
        }
        const outCount = readVarint()
        const vout = []
        for (let i = 0; i < outCount; i++) {
          const satoshis = Number(buf.readBigUInt64LE(pos)); pos += 8
          const scriptLen = readVarint()
          const scriptHex = buf.subarray(pos, pos + scriptLen).toString('hex')
          pos += scriptLen
          vout.push({ value: satoshis / 1e8, n: i, scriptPubKey: { hex: scriptHex } })
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ txid, vout }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'tx parse failed: ' + err.message }))
      }
      return
    }

    // GET /api/mesh/status — alias for /status (web app compat)
    if (req.method === 'GET' && path === '/api/mesh/status') {
      const status = await this.getStatus({ authenticated })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(status))
      return
    }

    // ── Session Storage (Indelible) ─────────────────────────

    // POST /api/sessions/index — MCP/CLI pushes session metadata after broadcast (open, like /api/broadcast)
    if (req.method === 'POST' && path === '/api/sessions/index') {
      try {
        const body = await this._readBody(req)
        if (!body.txId || !body.address) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'txId and address required' }))
          return
        }
        const record = await this._store.putSession(body)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true, txId: record.txId }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: err.message }))
      }
      return
    }

    // GET /api/sessions/{addr} — read session list for an address
    if (req.method === 'GET' && path.startsWith('/api/sessions/')) {
      const addr = path.slice('/api/sessions/'.length)
      if (!addr) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'address required' }))
        return
      }
      try {
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '200', 10), 2000)
        const sessions = await this._store.getSessions(addr, limit)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ sessions, count: sessions.length }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: err.message }))
      }
      return
    }

    // POST /api/sessions/backfill — bulk import for migration
    if (req.method === 'POST' && path === '/api/sessions/backfill') {
      if (!authenticated) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized. Provide statusSecret via ?auth= or Authorization header.' }))
        return
      }
      try {
        const body = await this._readBody(req)
        const sessions = (body.sessions || []).map(s => ({
          txId: s.txId, address: body.address || s.address,
          session_id: s.session_id || s.sessionId || null,
          prev_session_id: s.prev_session_id || s.prevTxId || null,
          summary: s.summary || '',
          message_count: s.message_count || s.messageCount || 0,
          save_type: s.save_type || s.saveType || 'full',
          timestamp: s.timestamp || null
        }))
        const imported = await this._store.putSessionsBatch(sessions)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true, imported }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: err.message }))
      }
      return
    }

    res.writeHead(404)
    res.end('Not Found')
  }

  /**
   * Stop the HTTP server.
   * @returns {Promise<void>}
   */
  stop () {
    this.stopAppMonitoring()
    return new Promise((resolve) => {
      if (this._server) {
        this._server.close(() => resolve())
        this._server = null
      } else {
        resolve()
      }
    })
  }

  /**
   * Get the port this server is configured to use.
   * @returns {number}
   */
  get port () {
    return this._port
  }
}
