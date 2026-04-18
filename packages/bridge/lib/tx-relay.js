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
 *   tx_announce — { type, txid }
 *   tx_request  — { type, txid }
 *   tx          — { type, txid, rawHex }
 *
 * Events:
 *   'tx:new' — { txid, rawHex } — new transaction received or submitted
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
}
