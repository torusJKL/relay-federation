# @relay-federation/sdk

JavaScript SDK for the [Federated SPV Relay Mesh](https://github.com/zcoolz/relay-federation). Connect to any bridge from your app.

## Install

```
npm install @relay-federation/sdk
```

## Quick Start

```javascript
import { RelayBridge } from '@relay-federation/sdk'

const bridge = new RelayBridge('http://your-bridge:9333')

// Get bridge status
const status = await bridge.getStatus()
console.log(`Height: ${status.headers.bestHeight}, Peers: ${status.peers.connected}`)

// Fetch a transaction
const tx = await bridge.getTx('abc123...')
console.log(`Source: ${tx.source}, Outputs: ${tx.outputs.length}`)

// Broadcast a raw transaction
const result = await bridge.broadcast('0100000001...')
console.log(`Relayed to ${result.peers} peers`)

// Query inscriptions
const images = await bridge.getInscriptions({ mime: 'image/png', limit: 10 })
console.log(`Found ${images.count} of ${images.total} total`)

// Get address history
const history = await bridge.getAddressHistory('1Abc...')

// Discover other bridges on the mesh
const mesh = await bridge.discover()
console.log(`${mesh.count} bridges on the network`)
```

## API

### Constructor

```javascript
const bridge = new RelayBridge(baseUrl, options?)
```

| Option | Type | Default | Description |
|---|---|---|---|
| `auth` | string | — | Operator `statusSecret` for authenticated endpoints |
| `timeout` | number | 10000 | Request timeout in milliseconds |

### Public Methods

| Method | Returns | Description |
|---|---|---|
| `getStatus()` | status object | Bridge status (peers, headers, mempool, BSV node) |
| `getMempool()` | `{ count, txs }` | Parsed mempool transactions |
| `getTx(txid)` | tx object | Fetch and parse a transaction |
| `broadcast(rawHex)` | `{ txid, peers }` | Relay a raw transaction to mesh peers |
| `getInscriptions(filters?)` | `{ total, count, inscriptions }` | Query indexed inscriptions |
| `getInscriptionContent(txid, vout)` | `{ data, contentType }` | Raw inscription content |
| `getAddressHistory(address)` | `{ address, history }` | Transaction history for an address |
| `discover()` | `{ count, bridges }` | All bridges known to this node |
| `getApps()` | `{ apps }` | Health/SSL/usage for configured apps |
| `getSessions(address)` | `{ address, sessions, count }` | Session metadata for an address |
| `indexSession(session)` | `{ ok }` | Index a session (syncs to peers via SessionRelay) |
| `backfillSessions(sessions)` | `{ ok, indexed }` | Bulk-index sessions |
| `getRawTx(txid)` | hex string | Raw transaction hex |
| `getUnspent(address)` | array of UTXOs | Unspent outputs for an address |
| `getBalance(address)` | `{ address, balance, utxos }` | Total balance for an address |
| `getKnownTx(txid)` | `{ known, source?, firstSeen? }` | Fast check if tx seen on network |
| `getPrice()` | `{ price, source, timestamp }` | Current BSV/USD exchange rate |
| `submitData(envelope)` | `{ ok }` | Submit a signed data envelope |
| `getTopics()` | `{ topics }` | List all data topics |
| `getData(topic, opts?)` | `{ topic, envelopes, hasMore }` | Query cached data envelopes |
| `getTokens()` | `{ tokens }` | List all deployed tokens |
| `getToken(tick)` | token info | Get token deployment details |
| `getTokenBalance(tick, scriptHash)` | `{ balance }` | Token balance for script hash |

### Operator Methods (require `auth`)

| Method | Returns | Description |
|---|---|---|
| `register()` | `{ jobId, stream }` | Start on-chain registration |
| `deregister(reason?)` | `{ jobId, stream }` | Start on-chain deregistration |
| `fund(rawHex)` | `{ stored, balance }` | Store a funding transaction |
| `connect(endpoint)` | `{ endpoint, status }` | Connect to a peer |
| `send(toAddress, amount)` | `{ jobId, stream }` | Send BSV from bridge wallet |
| `scanAddress(address, onProgress?)` | `{ scanned, found, indexed }` | Scan address for inscriptions |
| `rebuildInscriptionIndex()` | `{ rebuilt }` | Rebuild inscription indexes |
| `getJob(jobId)` | events array | Get async job progress |

### Inscription Filters

```javascript
await bridge.getInscriptions({
  mime: 'image/png',       // filter by content type
  address: '1Abc...',      // filter by receiving address
  limit: 100               // max results (capped at 200)
})
```

### Error Handling

```javascript
import { RelayBridge, BridgeError } from '@relay-federation/sdk'

try {
  const tx = await bridge.getTx('bad-txid')
} catch (err) {
  if (err instanceof BridgeError) {
    console.log(err.status)  // HTTP status code (e.g. 404)
    console.log(err.message) // Error message from bridge
  }
}
```

### Multi-Bridge Discovery

```javascript
// Connect to one bridge, discover the rest
const entry = new RelayBridge('http://your-bridge:9333')
const mesh = await entry.discover()

// Connect to all bridges
const bridges = mesh.bridges.map(b => new RelayBridge(b.statusUrl))

// Query across the mesh
for (const bridge of bridges) {
  const status = await bridge.getStatus()
  console.log(`${status.bridge.pubkeyHex?.slice(0, 8)}... height=${status.headers.bestHeight}`)
}
```

### Round-Robin Failover

For production apps, round-robin across multiple bridges so one failure doesn't take you down:

```javascript
const bridges = [
  new RelayBridge('http://bridge-alpha:9333', { timeout: 8000 }),
  new RelayBridge('http://bridge-beta:9333', { timeout: 8000 }),
  new RelayBridge('http://bridge-gamma:9333', { timeout: 8000 }),
]

let idx = 0

async function meshCall(fn) {
  const startIdx = idx++ % bridges.length
  for (let i = 0; i < bridges.length; i++) {
    try {
      return await fn(bridges[(startIdx + i) % bridges.length])
    } catch (_) { /* try next */ }
  }
  throw new Error('All bridges failed')
}

// Usage
const tx = await meshCall(b => b.getTx('abc123...'))
const result = await meshCall(b => b.broadcast('0100...'))
```

## Building Apps

Apps are consumers of the federation — they run anywhere and talk to bridges via this SDK or plain REST. See the full guide: **[Building Apps on the Federation](../../docs/app-integration.md)**

## Requirements

- Node.js >= 18 (uses native `fetch`)
- Works in browsers with `fetch` support

## License

MIT
