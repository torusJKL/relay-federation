import { EventEmitter } from 'node:events'
import { createServer } from 'node:net'
import { resolve4 } from 'node:dns/promises'
import { readFileSync, writeFileSync } from 'node:fs'
import { BSVPeer } from './bsv-peer.js'

/**
 * BSVNodeClient — multi-peer pool manager for BSV P2P connections.
 *
 * Manages a pool of BSVPeer connections for redundancy:
 * - DNS seed + P2P addr exchange peer discovery (no WoC dependency)
 * - Connects to multiple BSV nodes simultaneously
 * - Broadcasts transactions to ALL connected peers
 * - Fetches transactions from first available peer
 * - Maintains peer pool with periodic health checks
 *
 * Ported from production Indelible SPV bridge (spv-client.js)
 * peer management, adapted for the open protocol (no third-party APIs).
 *
 * Events (proxied from all peers):
 *   'headers'      — { headers, count }
 *   'connected'    — { host, port }
 *   'handshake'    — { version, userAgent, startHeight }
 *   'disconnected' — { host, port }
 *   'error'        — Error
 *   'tx'           — { txid, rawHex }
 *   'tx:inv'       — { txids }
 */

const DEFAULT_SEEDS = [
  'seed.bitcoinsv.io',
  'seed.satoshisvision.network',
  'seed.cascharia.com',
  'seed.indelible.one'
]

// Hardcoded BSV node IPs — fallback when DNS seeds are dead
const FALLBACK_PEERS = [
  '135.181.137.155', '198.154.93.210', '47.243.139.168',
  '57.129.76.3', '198.154.93.204', '57.128.233.172',
  '15.204.53.222', '95.217.38.93', '65.108.102.125',
  '51.75.213.175', '99.127.49.102', '162.19.222.167',
  '141.95.126.79', '162.19.138.6', '95.217.204.168',
  '195.144.22.198', '198.154.93.212', '135.125.170.182',
  '37.27.131.85', '15.235.232.121', '57.128.216.248',
  '51.89.99.162', '198.154.93.195', '51.222.249.3'
]

const DEFAULT_PORT = 8333
const MAINTAIN_INTERVAL_MS = 60000

const DEFAULT_CHECKPOINT = {
  height: 930000,
  hash: '00000000000000001c2e04e4375cfa4b46588aa27795b2c7f8d4d34cb568a382',
  prevHash: '000000000000000015ec9abde40c7537fc422e5af81b6028ac376d7cf23bd0c8'
}

export class BSVNodeClient extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {string[]} [opts.seeds] — DNS seeds (default: 3 BSV seeds)
   * @param {number} [opts.port] — BSV node port (default 8333)
   * @param {{ height, hash, prevHash }} [opts.checkpoint] — Starting checkpoint
   * @param {number} [opts.syncIntervalMs] — Header sync interval (default 30s)
   * @param {number} [opts.pingIntervalMs] — Keepalive interval (default 120s)
   */
  constructor (opts = {}) {
    super()
    this._seeds = opts.seeds || DEFAULT_SEEDS
    this._port = opts.port || DEFAULT_PORT
    this._checkpoint = opts.checkpoint || DEFAULT_CHECKPOINT
    this._syncIntervalMs = opts.syncIntervalMs || 30000
    this._pingIntervalMs = opts.pingIntervalMs || 120000

    /** @type {Map<string, BSVPeer>} host → peer */
    this._peers = new Map()
    this._destroyed = false
    this._maintainTimer = null

    // Reconnect backoff: host → { until: timestamp, delay: ms }
    this._peerCooldown = new Map()
    this._baseCooldownMs = 30000       // 30s initial cooldown
    this._maxCooldownMs = 1800000      // 30 min cap (prevents refreshing 24hr bans on BSV nodes)
    // Permanent blacklist for non-BSV peers (BCH/BTC) — never reconnect
    this._blacklist = new Set()

    // Peers discovered via P2P addr exchange (not just DNS)
    this._addrPool = new Set()

    // Transaction relay — dedup set to prevent relay loops
    this._seenTxids = new Set()

    // Shared tx cache for immediate inv relay (Fix 2)
    // When we relay inv before having rawHex, the tx arrives later and goes here.
    // Any peer's getdata handler checks this cache.
    this._txCache = new Map()
    this._txCacheMax = 500

    // Persist good peers across restarts
    this._goodPeers = new Map() // host → { port, lastSeen }
    this._persistPath = opts.persistPath || null

    // Crawler URL — fetch verified alive peers from federation crawler
    this._crawlerUrl = opts.crawlerUrl || null

    // Inbound listener
    this._server = null
    this._listenPort = opts.listenPort || 8333
    this._enableInbound = opts.enableInbound ?? false
    this._publicIp = opts.publicIp || null // our IP for addr self-advertisement

    // Track best height across all peers
    this._bestHeight = this._checkpoint.height
    this._bestHash = this._checkpoint.hash

    // Shared header store — all peers reference these instead of creating their own
    this._sharedHeaderHashes = new Map()
    this._sharedHashToHeight = new Map()
    this._sharedHeaderHashes.set(this._checkpoint.height, this._checkpoint.hash)
    this._sharedHashToHeight.set(this._checkpoint.hash, this._checkpoint.height)
    if (this._checkpoint.prevHash) {
      this._sharedHeaderHashes.set(this._checkpoint.height - 1, this._checkpoint.prevHash)
      this._sharedHashToHeight.set(this._checkpoint.prevHash, this._checkpoint.height - 1)
    }
  }

  /**
   * Discover BSV nodes via DNS seeds and connect to all discovered peers.
   * Emits 'connected' and 'handshake' events as peers come online.
   * Does not block — connections established in background.
   */
  async connect () {
    if (this._destroyed) return

    // Load persisted good peers first — these get priority
    this._loadGoodPeers()
    const goodPeerList = [...this._goodPeers.entries()]
    const goodAddrs = goodPeerList.map(([host, info]) => ({ host, port: info.port || 8333 }))

    const addresses = await this._discoverPeers()

    // Shuffle for load distribution
    for (let i = addresses.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [addresses[i], addresses[j]] = [addresses[j], addresses[i]]
    }

    // Merge good peers + discovered, deduplicate
    const dnsAddrs = addresses.filter(a => !goodAddrs.some(g => g.host === a.host))
    const allAddrs = [...goodAddrs, ...dnsAddrs]

    // Connect to all peers — cooldown handles throttling, no stagger needed.
    // Headers sync naturally via getheaders/headers exchange after handshake.
    console.log(`[P2P] Connecting to ${allAddrs.length} peers (${goodAddrs.length} good, ${dnsAddrs.length} discovered)`)
    for (const addr of allAddrs) {
      this._connectToPeer(addr.host, addr.port)
    }

    // Start maintenance timer
    this._maintainTimer = setInterval(() => this._maintainPeers(), MAINTAIN_INTERVAL_MS)
    if (this._maintainTimer.unref) this._maintainTimer.unref()

    // Clear seen txids periodically (prevent unbounded memory growth)
    this._seenTxidTimer = setInterval(() => this._seenTxids.clear(), 120000)
    if (this._seenTxidTimer.unref) this._seenTxidTimer.unref()

    // Start inbound listener if enabled
    if (this._enableInbound) {
      this.startListening()
    }
  }

  /**
   * Disconnect all peers and stop maintenance.
   */
  disconnect () {
    this._destroyed = true
    clearInterval(this._maintainTimer)
    clearInterval(this._seenTxidTimer)
    if (this._server) {
      this._server.close()
      this._server = null
    }
    for (const peer of this._peers.values()) {
      peer.disconnect()
    }
    this._peers.clear()
  }

  /**
   * Start listening for inbound P2P connections.
   * Other BSV nodes can connect to us, increasing peer count significantly.
   * @param {number} [port=8333]
   */
  startListening (port) {
    const listenPort = port || this._listenPort
    this._server = createServer((socket) => {
      const host = socket.remoteAddress?.replace('::ffff:', '') || 'unknown'
      if (this._blacklist.has(host) || this._peers.has(host)) {
        socket.destroy()
        return
      }
      // Cap total peers (inbound + outbound)
      if (this._peers.size >= 32) {
        socket.destroy()
        return
      }

      this._acceptInboundPeer(socket, host)
    })

    this._server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[P2P] Port ${listenPort} already in use — inbound disabled`)
      } else {
        console.error(`[P2P] Listen error:`, err.message)
      }
    })

    this._server.listen(listenPort, '0.0.0.0', () => {
      console.log(`[P2P] Listening for inbound connections on port ${listenPort}`)
    })
  }

  /**
   * Accept an inbound peer connection. Same event wiring as outbound.
   * @param {import('node:net').Socket} socket
   * @param {string} host
   */
  async _acceptInboundPeer (socket, host) {
    const peer = new BSVPeer({
      checkpoint: this._checkpoint,
      syncIntervalMs: this._syncIntervalMs,
      pingIntervalMs: this._pingIntervalMs,
      headerHashes: this._sharedHeaderHashes,
      hashToHeight: this._sharedHashToHeight,
      sharedTxCache: this._txCache
    })

    this._peers.set(host, peer)

    // Wire events — same as outbound
    peer.on('headers', (data) => {
      for (const h of data.headers) {
        if (h.height > this._bestHeight) {
          this._bestHeight = h.height
          this._bestHash = h.hash
        }
      }
      this._clearCooldown(host)
      if (!this._goodPeers.has(host)) {
        console.log(`[P2P good-peer] ${host} marked good (sent headers)`)
      }
      this._goodPeers.set(host, { port: peer._port || 8333, lastSeen: Date.now(), consecutiveFails: 0 })
      this.emit('headers', data)
    })

    peer.on('connected', (data) => this.emit('connected', data))
    peer.on('handshake', (data) => {
      this.emit('handshake', data)
      peer.requestAddr()
      // Advertise our own address so peers gossip us across the network
      if (this._publicIp) {
        peer.sendSelfAddr(this._publicIp, this._listenPort)
      }
    })

    peer.on('addr', ({ addrs }) => {
      for (const a of addrs) {
        if (!this._peers.has(a.host) && !this._blacklist.has(a.host)) {
          this._addrPool.add(`${a.host}:${a.port}`)
          this._connectToPeer(a.host, a.port)
        }
      }
    })

    peer.on('disconnected', (data) => {
      const wasBch = !peer._handshakeComplete && peer._peerUserAgent && !peer._peerUserAgent.includes('Bitcoin SV')
      this._peers.delete(host)
      if (wasBch) {
        this._blacklist.add(host)
      }
      this.emit('disconnected', data)
    })

    peer.on('error', (err) => this.emit('error', err))

    peer.on('tx', (data) => {
      this.emit('tx', data)
      // Store in shared cache for getdata from relayed-inv peers
      if (this._txCache.size >= this._txCacheMax) {
        const oldest = this._txCache.keys().next().value
        this._txCache.delete(oldest)
      }
      this._txCache.set(data.txid, data.rawHex)
    })

    peer.on('tx:inv', ({ txids, peer: sourcePeer }) => {
      this.emit('tx:inv', { txids, peer: sourcePeer })
      const newTxids = txids.filter(t => !this._seenTxids.has(t))
      for (const t of newTxids) this._seenTxids.add(t)
      if (newTxids.length > 0 && peer._handshakeComplete) {
        // Fix 2: immediate inv relay (same as outbound handler)
        let relayCount = 0
        for (const [h, p] of this._peers) {
          if (p !== peer && p._handshakeComplete) {
            for (const t of newTxids) p.relayInv(t)
            relayCount++
          }
        }
        if (relayCount > 0) {
          console.log(`[P2P relay] ${newTxids.length} inv → ${relayCount} peers (immediate)`)
        }
        peer.requestTxs(newTxids)
      }
    })

    try {
      await peer.acceptInbound(socket, host)
      console.log(`[P2P] Inbound peer ${host} connected (${this._peers.size} total)`)
    } catch {
      this._peers.delete(host)
    }
  }

  /**
   * Broadcast a raw transaction to ALL connected peers.
   * @param {string} rawTxHex
   * @returns {string} txid
   */
  broadcastTx (rawTxHex) {
    let txid = null
    for (const peer of this._peers.values()) {
      if (peer._handshakeComplete) {
        txid = peer.broadcastTx(rawTxHex)
      }
    }
    return txid
  }

  /**
   * Push a raw transaction directly to ALL connected peers (no inv/getdata).
   * @param {string} rawTxHex
   * @returns {string} txid
   */
  pushTx (rawTxHex) {
    let txid = null
    for (const peer of this._peers.values()) {
      if (peer._handshakeComplete) {
        txid = peer.pushTx(rawTxHex)
      }
    }
    return txid
  }

  /**
   * Broadcast a raw tx and wait for at least one BSV node to request it via getdata.
   * Returns when the tx is actually delivered, not just announced.
   *
   * @param {string} rawTxHex
   * @param {number} [timeoutMs=10000]
   * @returns {Promise<string>} txid
   */
  broadcastTxAndWait (rawTxHex, timeoutMs = 10000) {
    const txid = this.broadcastTx(rawTxHex)
    if (!txid) return Promise.reject(new Error('No connected BSV peers for broadcast'))

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`Broadcast timeout: no peer requested tx ${txid.slice(0, 16)}... within ${timeoutMs}ms`))
      }, timeoutMs)

      const onBroadcast = (broadcastTxid) => {
        if (broadcastTxid === txid) {
          cleanup()
          resolve(txid)
        }
      }

      const cleanup = () => {
        clearTimeout(timer)
        for (const peer of this._peers.values()) {
          peer.removeListener('tx:broadcast', onBroadcast)
        }
      }

      for (const peer of this._peers.values()) {
        peer.on('tx:broadcast', onBroadcast)
      }
    })
  }

  /**
   * Wait for header sync to reach the chain tip (reported by peers at handshake).
   * BSV nodes ignore inv from peers that appear unsynced.
   *
   * @param {number} targetHeight — Chain tip height from peer handshake
   * @param {number} [timeoutMs=30000]
   * @returns {Promise<number>} — Synced height
   */
  waitForSync (targetHeight, timeoutMs = 30000) {
    if (this._bestHeight >= targetHeight) return Promise.resolve(this._bestHeight)

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`Header sync timeout: at ${this._bestHeight}, need ${targetHeight}`))
      }, timeoutMs)

      const onHeaders = () => {
        if (this._bestHeight >= targetHeight) {
          cleanup()
          resolve(this._bestHeight)
        }
      }

      const cleanup = () => {
        clearTimeout(timer)
        this.removeListener('headers', onHeaders)
      }

      this.on('headers', onHeaders)
    })
  }

  /**
   * Fetch a transaction from the first available peer.
   * @param {string} txid
   * @param {number} [timeoutMs=10000]
   * @returns {Promise<{ txid, rawHex }>}
   */
  getTx (txid, timeoutMs = 10000) {
    for (const peer of this._peers.values()) {
      if (peer._handshakeComplete) {
        return peer.getTx(txid, timeoutMs)
      }
    }
    return Promise.reject(new Error('not connected to BSV node'))
  }

  /**
   * Fetch a transaction from a specific peer (the one that announced it via inv).
   * Falls back to any connected peer if the target peer is unavailable.
   * @param {import('./bsv-peer.js').BSVPeer} peer
   * @param {string} txid
   * @param {number} [timeoutMs=5000]
   * @returns {Promise<{ txid, rawHex }>}
   */
  getTxFromPeer (peer, txid, timeoutMs = 5000) {
    if (peer && peer._handshakeComplete) {
      return peer.getTx(txid, timeoutMs)
    }
    return this.getTx(txid, timeoutMs)
  }

  /**
   * Trigger header sync on connected peers.
   */
  syncHeaders () {
    for (const peer of this._peers.values()) {
      if (peer._handshakeComplete) {
        peer.syncHeaders()
        break // sync from one peer at a time
      }
    }
  }

  /**
   * Seed a header hash to all peers.
   * @param {number} height
   * @param {string} hash
   */
  seedHeader (height, hash) {
    for (const peer of this._peers.values()) {
      peer.seedHeader(height, hash)
    }
    if (height > this._bestHeight) {
      this._bestHeight = height
      this._bestHash = hash
    }
  }

  /** Best synced height across all peers */
  get bestHeight () { return this._bestHeight }
  /** Best synced hash */
  get bestHash () { return this._bestHash }

  /** Number of peers with completed handshake */
  get connectedCount () {
    let count = 0
    for (const peer of this._peers.values()) {
      if (peer._handshakeComplete) count++
    }
    return count
  }

  /** List of connected peers with status info */
  get peerList () {
    const list = []
    for (const [host, peer] of this._peers) {
      list.push({
        host,
        connected: peer._connected,
        handshake: peer._handshakeComplete,
        bestHeight: peer._bestHeight,
        userAgent: peer._peerUserAgent,
        inbound: !!peer._inbound
      })
    }
    return list
  }

  // ── Private: peer discovery ────────────────────────────────

  /**
   * Discover BSV node IPs from DNS seeds.
   * No WoC, no third-party APIs — pure DNS.
   */
  async _discoverPeers () {
    const seen = new Set()
    const peers = []

    for (const seed of this._seeds) {
      try {
        const addrs = await resolve4(seed)
        for (const addr of addrs) {
          if (!seen.has(addr)) {
            seen.add(addr)
            peers.push({ host: addr, port: this._port })
          }
        }
      } catch {
        // DNS resolution failed for this seed — try others
      }
    }

    // Always include fallback peers — DNS seeds may resolve but reject connections
    for (const addr of FALLBACK_PEERS) {
      if (!seen.has(addr)) {
        seen.add(addr)
        peers.push({ host: addr, port: this._port })
      }
    }

    // Fetch verified alive peers from federation crawler
    if (this._crawlerUrl) {
      try {
        const res = await fetch(this._crawlerUrl, { signal: AbortSignal.timeout(5000) })
        const data = await res.json()
        const crawlerPeers = data.peers || data
        for (const p of crawlerPeers) {
          if (p.host && !seen.has(p.host)) {
            seen.add(p.host)
            peers.push({ host: p.host, port: p.port || this._port })
          }
        }
        if (crawlerPeers.length > 0) {
          console.log(`[P2P] Fetched ${crawlerPeers.length} peers from crawler`)
        }
      } catch {
        // Crawler unavailable — continue with DNS + fallback
      }
    }

    return peers
  }

  // ── Private: peer management ───────────────────────────────

  /**
   * Check if a host is in cooldown. Returns true if we should skip connecting.
   * Good peers use normal cooldown — they only get priority ordering, not bypass.
   */
  _isInCooldown (host) {
    // Demote good peers after 3 consecutive failures
    if (this._goodPeers.has(host)) {
      const gp = this._goodPeers.get(host)
      if ((gp.consecutiveFails || 0) >= 3) {
        console.log(`[P2P demote] ${host} dropped from good-peers (${gp.consecutiveFails} consecutive fails)`)
        this._goodPeers.delete(host)
      }
    }
    const entry = this._peerCooldown.get(host)
    if (!entry) return false
    if (Date.now() < entry.until) return true
    // Cooldown expired — allow reconnect
    return false
  }

  /**
   * Apply cooldown to a host with exponential backoff.
   * @param {string} host
   * @param {number} [overrideMs] — fixed cooldown (e.g. BCH blacklist)
   */
  _applyCooldown (host, overrideMs) {
    const existing = this._peerCooldown.get(host)
    const delay = overrideMs || (existing ? Math.min(existing.delay * 2, this._maxCooldownMs) : this._baseCooldownMs)
    this._peerCooldown.set(host, { until: Date.now() + delay, delay })
  }

  /**
   * Clear cooldown on successful stable connection.
   */
  _clearCooldown (host) {
    this._peerCooldown.delete(host)
  }

  /**
   * Connect to a single BSV peer. Fire-and-forget.
   * @param {string} host
   * @param {number} port
   */
  async _connectToPeer (host, port) {
    if (this._peers.has(host) || this._destroyed) return
    if (this._blacklist.has(host)) return
    if (this._isInCooldown(host)) return
    // Cap total peers to prevent unbounded growth
    if (this._peers.size >= 32) return

    const peer = new BSVPeer({
      checkpoint: this._checkpoint,
      syncIntervalMs: this._syncIntervalMs,
      pingIntervalMs: this._pingIntervalMs,
      headerHashes: this._sharedHeaderHashes,
      hashToHeight: this._sharedHashToHeight,
      sharedTxCache: this._txCache
    })

    this._peers.set(host, peer)
    const connectTime = Date.now()

    // Wire events — proxy to callers
    peer.on('headers', (data) => {
      // Update pool best height
      for (const h of data.headers) {
        if (h.height > this._bestHeight) {
          this._bestHeight = h.height
          this._bestHash = h.hash
        }
      }
      // Stable peer — clear its cooldown and mark as good
      this._clearCooldown(host)
      if (!this._goodPeers.has(host)) {
        console.log(`[P2P good-peer] ${host} marked good (sent headers)`)
      }
      this._goodPeers.set(host, { port: peer._port || 8333, lastSeen: Date.now(), consecutiveFails: 0 })
      this.emit('headers', data)
    })

    peer.on('connected', (data) => this.emit('connected', data))
    peer.on('handshake', (data) => {
      // Handshake success = peer accepted us. Clear cooldown immediately.
      this._clearCooldown(host)
      this.emit('handshake', data)
      // Ask this peer for its known peers
      peer.requestAddr()
      // Advertise our own address so we become discoverable
      if (this._publicIp) {
        peer.sendSelfAddr(this._publicIp, this._listenPort)
      }
    })

    // Discover new peers through P2P addr exchange
    peer.on('addr', ({ addrs }) => {
      for (const a of addrs) {
        if (!this._peers.has(a.host) && !this._blacklist.has(a.host)) {
          this._addrPool.add(`${a.host}:${a.port}`)
          this._connectToPeer(a.host, a.port)
        }
      }
    })

    peer.on('disconnected', (data) => {
      // Check if peer was rejected for being non-BSV (no handshake completed)
      const wasBch = !peer._handshakeComplete && peer._peerUserAgent && !peer._peerUserAgent.includes('Bitcoin SV')
      this._peers.delete(host)
      if (wasBch) {
        // BCH/BTC node — permanent blacklist, never reconnect
        this._blacklist.add(host)
      } else {
        // Track consecutive failures for good peers
        if (this._goodPeers.has(host)) {
          const gp = this._goodPeers.get(host)
          gp.consecutiveFails = (gp.consecutiveFails || 0) + 1
        }
        // Ban detection: instant disconnect without handshake = likely IP-banned.
        // Apply 30-min cooldown to avoid refreshing the remote node's 24hr ban timer.
        const elapsed = Date.now() - connectTime
        if (!peer._handshakeComplete && elapsed < 3000) {
          this._applyCooldown(host, this._maxCooldownMs) // 30 min — suspected ban
        } else {
          this._applyCooldown(host)
        }
      }
      this.emit('disconnected', data)
    })

    peer.on('error', (err) => {
      // Don't crash the pool — just log
      this.emit('error', err)
    })

    peer.on('tx', (data) => {
      this.emit('tx', data)
      // Store in shared cache — getdata from relayed-inv peers will find it here
      if (this._txCache.size >= this._txCacheMax) {
        const oldest = this._txCache.keys().next().value
        this._txCache.delete(oldest)
      }
      this._txCache.set(data.txid, data.rawHex)
    })

    peer.on('tx:inv', ({ txids, peer: sourcePeer }) => {
      this.emit('tx:inv', { txids, peer: sourcePeer })
      const newTxids = txids.filter(t => !this._seenTxids.has(t))
      for (const t of newTxids) this._seenTxids.add(t)
      if (newTxids.length > 0 && peer._handshakeComplete) {
        // Fix 2: Relay inv IMMEDIATELY to other peers, then fetch tx in parallel.
        // Old flow: inv → fetch tx (100ms) → relay inv. We lose the race.
        // New flow: inv → relay inv + fetch tx simultaneously. Win more races.
        let relayCount = 0
        for (const [h, p] of this._peers) {
          if (p !== peer && p._handshakeComplete) {
            for (const t of newTxids) p.relayInv(t)
            relayCount++
          }
        }
        if (relayCount > 0) {
          console.log(`[P2P relay] ${newTxids.length} inv → ${relayCount} peers (immediate)`)
        }
        // Fetch full tx from source (arrives later, stored in _txCache by tx handler)
        peer.requestTxs(newTxids)
      }
    })

    try {
      await peer.connect(host, port)
    } catch {
      // Connection or handshake failed — remove from pool, apply cooldown
      this._peers.delete(host)
      this._applyCooldown(host)
    }
  }

  /**
   * Periodic maintenance: clean dead peers, reconnect if below target.
   */
  async _maintainPeers () {
    if (this._destroyed) return
    // Guard: skip if a previous maintain cycle is still running
    if (this._maintaining) return
    this._maintaining = true

    try {
      // Clean disconnected peers
      for (const [host, peer] of this._peers) {
        if (!peer._connected) {
          this._peers.delete(host)
        }
      }

      // Collect peers to reconnect
      const toConnect = []

      // DNS-discovered peers
      try {
        const addresses = await this._discoverPeers()
        for (const addr of addresses) {
          if (!this._peers.has(addr.host)) {
            toConnect.push({ host: addr.host, port: addr.port })
          }
        }
      } catch {
        // DNS failed during maintenance — try again next cycle
      }

      // Addr pool peers
      for (const entry of this._addrPool) {
        const [host, portStr] = entry.split(':')
        if (!this._peers.has(host) && !toConnect.some(a => a.host === host)) {
          toConnect.push({ host, port: parseInt(portStr, 10) })
        }
      }

      // Connect to all discovered peers — cooldown handles throttling per-host.
      // Banned hosts get 30-min cooldown, normal failures get exponential backoff.
      for (const addr of toConnect) {
        this._connectToPeer(addr.host, addr.port)
      }
    } finally {
      this._maintaining = false
    }

    // Ask existing peers for more addrs periodically
    for (const peer of this._peers.values()) {
      if (peer._handshakeComplete) {
        peer.requestAddr()
      }
    }

    // Persist good peers to file
    this._saveGoodPeers()
  }

  /**
   * Stagger connection attempts — 4 at a time with 2s gaps.
   * Prevents hammering 26 peers simultaneously which triggers mass eviction.
   */
  async _staggerConnect (addresses, label) {
    if (!addresses.length) return
    const BATCH_SIZE = 4
    const BATCH_DELAY_MS = 2000
    const totalBatches = Math.ceil(addresses.length / BATCH_SIZE)
    for (let i = 0; i < addresses.length; i += BATCH_SIZE) {
      if (this._destroyed) return
      const batchNum = Math.floor(i / BATCH_SIZE) + 1
      const batch = addresses.slice(i, i + BATCH_SIZE)
      console.log(`[P2P stagger] ${label} batch ${batchNum}/${totalBatches} (${batch.map(a => a.host).join(', ')})`)
      for (const addr of batch) {
        if (!this._peers.has(addr.host)) {
          this._connectToPeer(addr.host, addr.port)
        }
      }
      if (i + BATCH_SIZE < addresses.length) {
        await new Promise(r => setTimeout(r, BATCH_DELAY_MS))
      }
    }
  }

  /**
   * Load good peers from file. Called once on connect().
   */
  _loadGoodPeers () {
    if (!this._persistPath) return
    try {
      const data = JSON.parse(readFileSync(this._persistPath, 'utf8'))
      for (const entry of data) {
        // Only load peers seen in last 24 hours
        if (Date.now() - entry.lastSeen < 86400000) {
          this._goodPeers.set(entry.host, { port: entry.port || 8333, lastSeen: entry.lastSeen })
        }
      }
      if (this._goodPeers.size > 0) {
        console.log(`[P2P] Loaded ${this._goodPeers.size} good peers from file`)
      }
    } catch {
      // File doesn't exist yet — first run
    }
  }

  /**
   * Save good peers to file. Called every maintain cycle.
   */
  _saveGoodPeers () {
    if (!this._persistPath) return
    const peers = []
    for (const [host, info] of this._goodPeers) {
      // Only persist peers seen in last 24 hours
      if (Date.now() - info.lastSeen < 86400000) {
        peers.push({ host, port: info.port, lastSeen: info.lastSeen })
      }
    }
    try {
      writeFileSync(this._persistPath, JSON.stringify(peers, null, 2))
    } catch {}
  }
}
