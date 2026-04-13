# Bridge Operator Handbook

How to set up and run your own bridge on the Indelible Federation.

## What is a bridge?

A bridge is a lightweight server that connects to the Bitcoin SV network, syncs block headers, and relays transactions. Bridges peer with each other to form a mesh network. Your bridge will discover other bridges automatically from the blockchain — no manual configuration needed.

## Requirements

- A VPS (Ubuntu recommended, 1 vCPU, 2GB RAM, 20GB disk)
- BSV for staking (minimum ~0.01 BSV / 1,000,000 satoshis)
- SSH access to your server

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

## Step 2: Install the bridge software

```bash
npm install -g @relay-federation/bridge
```

This gives you the `relay-bridge` command.

## Step 3: Initialize your bridge

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

## Step 4: Fund your bridge

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

## Step 5: Register your bridge

```bash
relay-bridge register
```

This broadcasts a registration transaction to the BSV network. Other bridges will detect it automatically and start accepting connections from you.

You should see:

```
Registration broadcast! txid: def456...
Your bridge will appear in peer lists on next scan cycle.
```

## Step 6: Start your bridge

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

To run it in the background so it stays running after you disconnect:

```bash
nohup relay-bridge start >> /root/relay-bridge.log 2>&1 &
```

## Step 7: Open firewall ports

Your bridge needs two ports open:

```bash
ufw allow 8333/tcp
ufw allow 9333/tcp
```

- **8333** — mesh peering (other bridges connect to you)
- **9333** — dashboard and API

## Step 8: Verify

Open your browser and go to:

```
http://YOUR-IP:9333
```

You should see the bridge dashboard showing your peers, mempool transactions, and block height.

From the command line, you can also check:

```bash
relay-bridge status
```

## Stopping your bridge

```bash
pkill -f relay-bridge
```

## Restarting your bridge

```bash
pkill -f relay-bridge
sleep 3
nohup relay-bridge start >> /root/relay-bridge.log 2>&1 &
```

## Checking logs

```bash
tail -100 /root/relay-bridge.log
```

## Troubleshooting

**"Bridge is not running" when checking status**
Your bridge process isn't running. Start it with `relay-bridge start`.

**No peers connecting**
- Make sure port 8333 is open: `ufw allow 8333/tcp`
- Check that registration completed: look for "Registration broadcast!" in your logs
- Wait a few minutes — other bridges scan for new registrations periodically

**Dashboard not loading**
- Make sure port 9333 is open: `ufw allow 9333/tcp`
- Check if the bridge is running: `pgrep -f relay-bridge`

**LevelDB LOCK error**
A previous process didn't shut down cleanly. Remove the stale lock:
```bash
rm -f /root/.relay-bridge/data/*/LOCK
```
Then start again.

**Port already in use**
Another process is using port 8333 or 9333:
```bash
fuser -k 8333/tcp
fuser -k 9333/tcp
```
Then start again.

## Updating your bridge

When a new version is released:

```bash
pkill -f relay-bridge
npm install -g @relay-federation/bridge
nohup relay-bridge start >> /root/relay-bridge.log 2>&1 &
```

Your config and data are preserved — only the software is updated.

## Summary

The full setup is five commands:

```bash
relay-bridge init
relay-bridge fund
relay-bridge register
relay-bridge start
```

Your bridge discovers the mesh automatically from the blockchain. No seed peers to configure, no manual setup needed.
