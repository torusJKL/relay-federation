import { EventEmitter } from 'node:events'

/**
 * TxRelay — relays transactions between peers.
 *
 * Uses the INV/GETDATA pattern (like Bitcoin P2P):
 * 1. Peer announces a txid via tx_announce
 * 2. If we haven't seen it, we request the full tx via tx_request
 * 3. Peer responds with the raw tx hex via tx message
 * 4. We store it and re-announce to other peers
 *
 * Message types:
 *   tx_announce   — { type, txid }
 *   tx_request    — { type, txid }
 *   tx            — { type, txid, rawHex }
 *   tx_confirmed  — { type, txid, source, bsvPeers, bridge, ts }
 *
 * Events:
 *   'tx:new'       — { txid, rawHex } — new transaction received or submitted
 *   'tx:confirmed' — { txid, source, bsvPeers, bridge, ts } — remote bridge confirmed broadcast
 */
export class TxRelay extends EventEmitter {
  /**
   * @param {import('./peer-manager.js').PeerManager} peerManager
   * @param {object} [opts]
   * @param {number} [opts.maxMempool=1000] — Max txs in local mempool
   */
  constructor (peerManager, opts = {}) {
    super()
    this.peerManager = peerManager
    this.bridgeName = opts.bridgeName || 'unknown'
    /** @type {Map<string, string>} txid → rawHex */
    this.mempool = new Map()
    /** @type {Set<string>} txids we've already seen (dedup) */
    this.seen = new Set()
    this._maxMempool = opts.maxMempool || 1000
    this._seenMax = opts.maxSeen || 50000

    /** @type {Map<string, number>} txid → timestamp first seen via BSV P2P inv */
    this.knownTxids = new Map()
    this._knownTxidMax = opts.maxKnownTxids || 10000
    this._knownTxidTtlMs = opts.knownTxidTtlMs || 600000 // 10 min

    /** @type {Map<string, Array>} txid → array of confirmation reports from other bridges */
    this.confirmations = new Map()
    this._confirmMax = 5000
    this._confirmTtlMs = 120000 // 2 min — short-lived, just for the broadcast response window

    this.peerManager.on('peer:message', ({ pubkeyHex, message }) => {
      this._handleMessage(pubkeyHex, message)
    })
  }

  /**
   * Submit a new tx for relay to all peers.
   * @param {string} txid
   * @param {string} rawHex
   * @returns {number} Number of peers the announce was sent to
   */
  broadcastTx (txid, rawHex) {
    if (this.seen.has(txid)) return 0
    this._trackSeen(txid)
    this._storeTx(txid, rawHex)
    this.emit('tx:new', { txid, rawHex })
    return this.peerManager.broadcast({ type: 'tx_announce', txid })
  }

  /**
   * Get a tx from the local mempool.
   * @param {string} txid
   * @returns {string|null} rawHex or null
   */
  getTx (txid) {
    return this.mempool.get(txid) || null
  }

  /**
   * Record a txid as "seen on the BSV network" without storing the full tx.
   * @param {string} txid
   */
  trackTxid (txid) {
    if (this.knownTxids.has(txid)) return
    // LRU eviction: when at capacity, delete oldest entry
    if (this.knownTxids.size >= this._knownTxidMax) {
      const oldest = this.knownTxids.keys().next().value
      this.knownTxids.delete(oldest)
    }
    this.knownTxids.set(txid, Date.now())
  }

  /**
   * Check if we've seen a txid on the network (inv or mempool).
   * @param {string} txid
   * @returns {boolean}
   */
  hasSeen (txid) {
    return this.seen.has(txid) || this.knownTxids.has(txid)
  }

  /**
   * Report that THIS bridge confirmed a tx to BSV miners.
   * Gossips the confirmation to all mesh peers so the originator can collect the aggregate.
   * @param {string} txid
   * @param {string} source — 'p2p', 'arc', or 'woc'
   * @param {number} bsvPeers — number of BSV P2P peers that accepted
   */
  confirmTx (txid, source, bsvPeers = 0) {
    const report = { txid, source, bsvPeers, bridge: this.bridgeName, ts: Date.now() }
    this._storeConfirmation(txid, report)
    this.peerManager.broadcast({ type: 'tx_confirmed', ...report })
  }

  /**
   * Get all confirmation reports for a txid (local + remote).
   * @param {string} txid
   * @returns {{ bridges: number, totalBsvPeers: number, confirmations: Array }}
   */
  getConfirmations (txid) {
    const reports = this.confirmations.get(txid) || []
    let totalBsvPeers = 0
    for (const r of reports) totalBsvPeers += r.bsvPeers || 0
    return {
      bridges: reports.length,
      totalBsvPeers,
      confirmations: reports
    }
  }

  /** @private — add txid to seen set with LRU eviction */
  _trackSeen (txid) {
    if (this.seen.has(txid)) return
    if (this.seen.size >= this._seenMax) {
      this.seen.delete(this.seen.values().next().value)
    }
    this.seen.add(txid)
  }

  /** @private */
  _storeTx (txid, rawHex) {
    if (this.mempool.size >= this._maxMempool) {
      const oldest = this.mempool.keys().next().value
      this.mempool.delete(oldest)
    }
    this.mempool.set(txid, rawHex)
  }

  /** @private — store a confirmation report with LRU eviction */
  _storeConfirmation (txid, report) {
    if (!this.confirmations.has(txid)) {
      if (this.confirmations.size >= this._confirmMax) {
        const oldest = this.confirmations.keys().next().value
        this.confirmations.delete(oldest)
      }
      this.confirmations.set(txid, [])
    }
    const arr = this.confirmations.get(txid)
    // Dedup by bridge name
    if (!arr.some(r => r.bridge === report.bridge)) {
      arr.push(report)
    }
  }

  /** @private */
  _handleMessage (pubkeyHex, message) {
    switch (message.type) {
      case 'tx_announce':
        this._onTxAnnounce(pubkeyHex, message)
        break
      case 'tx_request':
        this._onTxRequest(pubkeyHex, message)
        break
      case 'tx':
        this._onTx(pubkeyHex, message)
        break
      case 'tx_confirmed':
        this._onTxConfirmed(pubkeyHex, message)
        break
    }
  }

  /** @private */
  _onTxAnnounce (pubkeyHex, msg) {
    if (this.seen.has(msg.txid)) return
    this._trackSeen(msg.txid)
    const conn = this.peerManager.peers.get(pubkeyHex)
    if (conn) {
      conn.send({ type: 'tx_request', txid: msg.txid })
    }
  }

  /** @private */
  _onTxRequest (pubkeyHex, msg) {
    const rawHex = this.mempool.get(msg.txid)
    if (rawHex) {
      const conn = this.peerManager.peers.get(pubkeyHex)
      if (conn) {
        conn.send({ type: 'tx', txid: msg.txid, rawHex })
      }
    }
  }

  /** @private */
  _onTx (pubkeyHex, msg) {
    if (!msg.txid || !msg.rawHex) return
    if (this.mempool.has(msg.txid)) return
    this._storeTx(msg.txid, msg.rawHex)
    this.emit('tx:new', { txid: msg.txid, rawHex: msg.rawHex })
    // Re-announce to all peers except the source
    this.peerManager.broadcast({ type: 'tx_announce', txid: msg.txid }, pubkeyHex)
  }

  /** @private — remote bridge confirmed a tx broadcast */
  _onTxConfirmed (pubkeyHex, msg) {
    if (!msg.txid) return
    const report = {
      txid: msg.txid,
      source: msg.source || 'unknown',
      bsvPeers: msg.bsvPeers || 0,
      bridge: msg.bridge || pubkeyHex.slice(0, 16),
      ts: msg.ts || Date.now()
    }
    this._storeConfirmation(msg.txid, report)
    this.emit('tx:confirmed', report)
  }
}
