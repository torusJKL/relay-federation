# Bridge Operator Handbook

How to set up and run your own bridge on the Indelible Federation.

## What is a bridge?

A bridge is a lightweight server that connects to the Bitcoin SV network, syncs block headers, and relays transactions. Bridges peer with each other to form a mesh network. Your bridge will discover other bridges automatically from the blockchain — no manual configuration needed.

## Requirements

| Requirement | Minimum | Recommended |
|---|---|---|
| **Node.js** | v22 LTS | v22.22+ |
| **RAM** | 1 GB | 2 GB+ |
| **Disk** | 500 MB | 1 GB |
| **OS** | Any Linux | Ubuntu 22.04+ / Debian 12+ |
| **Network** | Static IP or domain | VPS with reliable uptime |
| **BSV** | 0.01 BSV (1M sats) | For surety bond |

**Node.js version:** Use v22 LTS. Node v24+ is not yet supported — the `/status` endpoint may crash. Check with `node --version`.

**Bun:** You can use `bun install` for dependencies, but the bridge runtime requires Node.js. Bun's event loop handles idle TCP connections differently and the process will exit after a few seconds.

## Step 1: Install Node.js

SSH into your VPS and run:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
```

Verify it installed:

```bash
node --version
```

You should see v22 or higher.

## Step 2: Open firewall ports FIRST

Your bridge needs two ports open. Do this before starting so the mesh can reach you:

```bash
sudo ufw allow 8333/tcp    # Bitcoin P2P — connects to BSV nodes and other bridges
sudo ufw allow 9333/tcp    # Dashboard + REST API — health checks ping this port
```

If port 9333 is not open, your bridge will work but show as **offline** on the dashboard.

## Step 3: Install the bridge software

```bash
npm install -g @relay-federation/bridge@4.0.0
```

**Important:** Use version 4.0.0. Version 4.2.5 on npm has a bug where the `/status` endpoint returns Internal Server Error. This will be fixed in the next release.

This gives you the `relay-bridge` command.

## Step 4: Initialize your bridge

```bash
relay-bridge init
```

It will ask you to name your bridge, then output something like:

```
Bridge initialized!

  Name:     my-bridge
  Config:   /root/.relay-bridge/config.json
  Endpoint: ws://123.45.67.89:8333
  Pubkey:   0245f32e453b42a9...
  Address:  1PVrvQAaHTD24w2Z137HG2HyLHbPWkWNDE
  Secret:   55621d9fdc3baa06...

  Save your operator secret! You need it to log into the dashboard.
```

**Important:** Save your operator secret somewhere safe. You need it to access the dashboard's operator panel.

## Step 5: Fund your bridge

Send BSV to the address shown in Step 3. You need at least 0.01 BSV (1,000,000 satoshis) for the stake bond.

You can send from any wallet or exchange — HandCash, Centbee, RelayX, or wherever you hold BSV.

After sending, wait for the transaction to confirm (usually a few seconds on BSV), then tell the bridge to pick it up:

```bash
relay-bridge fund
```

The bridge checks its own address automatically — no need to copy anything from a block explorer.

You should see output like:

```
Checking 1PVrv...WNDE for funds...
Found 1 output(s). Importing...
  UTXO stored: abc123....:0 (1500000 sat)
  Total balance: 1500000 satoshis
```

## Step 6: Register your bridge

```bash
relay-bridge register
```

This broadcasts a registration transaction to the BSV network. Other bridges will detect it automatically and start accepting connections from you.

You should see:

```
Registration broadcast! txid: def456...
Your bridge will appear in peer lists on next scan cycle.
```

## Step 7: Start your bridge

```bash
relay-bridge start
```

Your bridge will:
1. Connect to BSV full nodes via the P2P network
2. Sync all block headers
3. Discover other bridges from the on-chain registry
4. Connect to the mesh and start relaying transactions

You should see output like:

```
Beacon backfill: GorillaPool returned 10 UTXOs
Discovered 7 peer endpoint(s) from on-chain registry
Connecting to 7 peer(s) discovered from on-chain registry...
BSV P2P: handshake complete (/Bitcoin SV:1.2.1/, height: 944554)
Peer identified: 028eee885bd1b990...
```

## Step 8: Run as a service (systemd — recommended)

Create `/etc/systemd/system/relay-bridge.service`:

```ini
[Unit]
Description=Relay Federation Bridge
After=network.target

[Service]
ExecStart=/usr/bin/npx relay-bridge start
WorkingDirectory=/root
Restart=always
RestartSec=10
Environment=NODE_OPTIONS=--max-old-space-size=2048

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable relay-bridge    # start on boot
sudo systemctl start relay-bridge
```

**Memory:** `NODE_OPTIONS=--max-old-space-size=2048` (2GB heap) is required. Default 512MB causes OOM crashes after ~5 hours with 15+ peers.

**RestartSec=10:** Prevents "port already in use" errors by giving the old process time to release ports.

### Alternative: pm2

```bash
npm install -g pm2
pm2 start "npx relay-bridge start" --name relay-bridge --node-args="--max-old-space-size=2048"
pm2 startup    # auto-start on boot
pm2 save
```

## Step 9: Verify

Open your browser and go to:

```
http://YOUR-IP:9333
```

You should see the bridge dashboard showing your peers, mempool transactions, and block height.

From the command line, you can also check:

```bash
relay-bridge status
```

## Managing your bridge

```bash
# systemd
sudo systemctl stop relay-bridge
sudo systemctl restart relay-bridge
sudo systemctl status relay-bridge
sudo journalctl -u relay-bridge -f         # live logs
sudo journalctl -u relay-bridge --tail 100 # last 100 lines

# pm2
pm2 stop relay-bridge
pm2 restart relay-bridge
pm2 logs relay-bridge
```

---

## Enable x402 Payments

Earn satoshis from every paid write that hits your bridge. Free reads remain free.

Add to `~/.relay-bridge/config.json`:

```json
{
  "x402": {
    "enabled": true,
    "payTo": "1YourBSVAddress..."
  }
}
```

Restart the bridge. Check the x402 tab on your dashboard to see revenue stats.

---

## HTTPS with Reverse Proxy

### Caddy (simplest)

```
your-bridge.example.com {
    reverse_proxy localhost:9333
}
```

### nginx

```nginx
server {
    server_name your-bridge.example.com;
    location / {
        proxy_pass http://127.0.0.1:9333;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

The dashboard automatically proxies cross-bridge requests through your bridge server-side, so HTTPS works without mixed-content issues.

---

## Files & Directories

| Path | What It Is |
|------|-----------|
| `~/.relay-bridge/config.json` | Private key, endpoint, all settings |
| `~/.relay-bridge/data/` | LevelDB databases (headers, peers, txs, tokens) |
| `~/.relay-bridge/good-peers.json` | Reliable BSV peers saved for warm start |

## Troubleshooting

**Dashboard shows "offline" / HTTP 500 on :9333/status**
1. Port 9333 not open — `sudo ufw allow 9333/tcp`
2. Wrong Node.js version — use v22 LTS (`node --version`)
3. Wrong npm version — use `@relay-federation/bridge@4.0.0` (v4.2.5 has a status bug)
4. Test locally: `curl http://127.0.0.1:9333/status` — if this fails too, it's a software issue not firewall

**No peers connecting**
- Make sure port 8333 is open: `ufw allow 8333/tcp`
- Check that registration completed: look for "Registration broadcast!" in your logs
- Wait a few minutes — peers discover each other through gossip, it takes time after a restart

**"Port 8333 already in use — inbound disabled"**
Previous process hasn't released the port:
```bash
sudo lsof -i :8333    # check what's using it
sudo kill <PID>        # kill stale process if needed
```
Using `RestartSec=10` in systemd prevents this on restarts.

**Teranode connection errors**
```
❌ Failed to connect to static peer /dns4/teranode-mainnet-us-01...
```
Normal. BSVA's Teranode peers go in and out. All bridges see these. Doesn't affect operation.

**Process exits immediately (Bun users)**
Bun's event loop doesn't keep the process alive for idle TCP connections. Switch to Node.js:
```bash
node $(which relay-bridge) start
```

**LevelDB LOCK error**
Previous process didn't shut down cleanly:
```bash
rm -f /root/.relay-bridge/data/*/LOCK
```

**Port already in use**
```bash
sudo fuser -k 8333/tcp
sudo fuser -k 9333/tcp
```

## Updating your bridge

When a new version is released:

```bash
pkill -f relay-bridge
npm install -g @relay-federation/bridge
nohup relay-bridge start >> /root/relay-bridge.log 2>&1 &
```

Your config and data are preserved — only the software is updated.

---

## Known Issues

| Issue | Workaround |
|-------|-----------|
| v4.2.5 `/status` broken | Install v4.0.0: `npm install -g @relay-federation/bridge@4.0.0` |
| Bun process exits | Use Node.js for runtime (Bun OK for `install`) |
| `fund` requires raw hex | Get raw hex from whatsonchain.com — auto-detect from address planned |
| No `--version` flag | Check `npm list -g @relay-federation/bridge` instead |

---

## Quick Reference

The full setup:

```bash
# 1. Open ports
sudo ufw allow 8333/tcp && sudo ufw allow 9333/tcp

# 2. Install
npm install -g @relay-federation/bridge@4.0.0

# 3. Init, fund, register, start
relay-bridge init
relay-bridge fund
relay-bridge register
relay-bridge start
```

Your bridge discovers the mesh automatically from the blockchain. No seed peers to configure, no manual setup needed.

Welcome to the federation.
