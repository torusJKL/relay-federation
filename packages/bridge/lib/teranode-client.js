import { EventEmitter } from 'node:events'

// ---------------------------------------------------------------------------
// Topic names — matches Go reference client (go-teranode-p2p-client/topics.go)
// Built inline so the bridge works without our upstream PRs being merged.
// ---------------------------------------------------------------------------

const PROTOCOL_PREFIX = 'teranode/bitcoin/1.0.0'

const NETWORK_LABELS = {
  main: 'mainnet', mainnet: 'mainnet',
  test: 'testnet', testnet: 'testnet',
  stn: 'stn', teratestnet: 'teratestnet'
}

function topicName (network, topic) {
  const label = NETWORK_LABELS[network] || network
  return `${PROTOCOL_PREFIX}/${label}-${topic}`
}

// ---------------------------------------------------------------------------
// Two-layer message decoder
// ---------------------------------------------------------------------------
// Teranode gossip messages use a two-layer JSON format:
//   Layer 1 (envelope): { "name": "<sender>", "data": "<base64 inner JSON>" }
//   Layer 2 (payload):  topic-specific JSON (block, subtree, rejected-tx, node_status)
//
// Libp2p also sends 89-byte protobuf discovery probes on every topic —
// these are not application messages and should be silently dropped.
// ---------------------------------------------------------------------------

const decoder = new TextDecoder()

function decodeGossipMessage (data) {
  if (!(data instanceof Uint8Array)) return data
  const text = decoder.decode(data)
  const envelope = JSON.parse(text) // throws on discovery probes (binary, not JSON)
  if (!envelope.data || !envelope.name) return envelope

  // Decode base64 inner payload
  const innerBytes = Buffer.from(envelope.data, 'base64')
  const payload = JSON.parse(innerBytes.toString())

  return { sender: envelope.name, payload }
}

function tryDecodeGossipMessage (data) {
  try { return decodeGossipMessage(data) } catch { return null }
}

/**
 * TeranodeClient — subscribes to Teranode's libp2p gossip network.
 *
 * Pipe #4: receives block announcements + tx batches directly from miners
 * via the @bsv/teranode-listener package (libp2p + GossipSub).
 *
 * Emits the same event interface as BSVNodeClient so the bridge can
 * wire both identically:
 *   'block'        — { sender, payload } (payload: Height, Hash, Header, Coinbase)
 *   'bestblock'    — { height, hash }
 *   'subtree'      — { sender, payload } (payload: Hash, ClientName)
 *   'rejected_tx'  — { sender, payload } (payload: TxID, Reason)
 *   'connected'    — { peerCount }
 *   'disconnected' — { peerCount }
 *   'status'       — { sender, payload } (payload: best_height, miner_name, fsm_state)
 */
export class TeranodeClient extends EventEmitter {
  constructor (opts = {}) {
    super()
    this._listener = null
    this._peerCount = 0
    this._blockCount = 0
    this._subtreeCount = 0
    this._rejectedCount = 0
    this._statusCount = 0
    this._connected = false
    this._startTime = null
    this._lastBlock = null
    this._lastStatus = null
    this._network = opts.network || 'main'
    this._enabled = opts.enabled !== false // enabled by default
  }

  /**
   * Connect to Teranode gossip network.
   * Dynamic import so the bridge still starts if @bsv/teranode-listener isn't installed.
   */
  async connect () {
    if (!this._enabled) {
      console.log('Teranode P2P: disabled in config')
      return
    }

    try {
      // Only need TeranodeListener from the npm package — topic names and
      // message decoding are handled inline so no dependency on our PRs.
      const { TeranodeListener } = await import('@bsv/teranode-listener')

      this._startTime = Date.now()
      const net = this._network

      this._listener = new TeranodeListener({
        [topicName(net, 'block')]: (data, topic, from) => {
          const msg = tryDecodeGossipMessage(data)
          if (!msg) return // discovery probe, skip
          this._connected = true
          this._blockCount++
          this._lastBlock = msg
          this.emit('block', { data: msg, from })
          const height = msg.payload?.Height || ''
          const sender = msg.sender || from.slice(0, 16)
          console.log(`Teranode: block ${height} from ${sender}`)
        },

        [topicName(net, 'subtree')]: (data, topic, from) => {
          const msg = tryDecodeGossipMessage(data)
          if (!msg) return
          this._connected = true
          this._subtreeCount++
          this.emit('subtree', { data: msg, from })
        },

        [topicName(net, 'rejected-tx')]: (data, topic, from) => {
          const msg = tryDecodeGossipMessage(data)
          if (!msg) return
          this._rejectedCount++
          this.emit('rejected_tx', { data: msg, from })
          const reason = msg.payload?.Reason || ''
          const txid = msg.payload?.TxID || ''
          if (reason) console.log(`Teranode: rejected ${txid.slice(0, 16)}... — ${reason}`)
        },

        [topicName(net, 'node_status')]: (data, topic, from) => {
          const msg = tryDecodeGossipMessage(data)
          if (!msg) return
          this._connected = true
          this._statusCount++
          this._lastStatus = msg
          this.emit('status', { data: msg, from })
          const miner = msg.payload?.miner_name || msg.sender || from.slice(0, 16)
          const height = msg.payload?.best_height || ''
          console.log(`Teranode: ${miner} height ${height}`)
        }
      })

      // Poll peer count (TeranodeListener exposes getConnectedPeerCount)
      this._peerTimer = setInterval(() => {
        if (!this._listener) return
        const count = this._listener.getConnectedPeerCount()
        const changed = count !== this._peerCount
        this._peerCount = count
        this._connected = count > 0

        if (changed) {
          if (count > 0) {
            this.emit('connected', { peerCount: count })
            console.log(`Teranode P2P: ${count} peers connected`)
          } else {
            this.emit('disconnected', { peerCount: 0 })
            console.log('Teranode P2P: no peers')
          }
        }
      }, 15000)

      console.log('Teranode P2P: connecting to miner gossip network...')
    } catch (err) {
      console.log(`Teranode P2P: failed to start — ${err.message}`)
      this._enabled = false
    }
  }

  /** Disconnect from Teranode network */
  async disconnect () {
    if (this._peerTimer) {
      clearInterval(this._peerTimer)
      this._peerTimer = null
    }
    if (this._listener) {
      try {
        await this._listener.stop()
      } catch {}
      this._listener = null
    }
    this._connected = false
    this._peerCount = 0
  }

  /** Status snapshot for dashboard/health endpoint */
  getStatus () {
    return {
      enabled: this._enabled,
      connected: this._connected,
      peers: this._peerCount,
      blocks: this._blockCount,
      subtrees: this._subtreeCount,
      rejected: this._rejectedCount,
      statusUpdates: this._statusCount,
      lastBlock: this._lastBlock,
      lastStatus: this._lastStatus,
      reconnects: this._listener ? this._listener.getReconnectCount() : 0,
      uptime: this._startTime ? Math.floor((Date.now() - this._startTime) / 1000) : 0
    }
  }
}
