# zkChat Backend

Military-Grade Privacy For Everyday. End-to-end encrypted (AES-256-GCM) conversations, one-time messages and file drops.

## Overview

Zero-knowledge WebSocket relay server and REST API for zkChat. The server is cryptographically blind - it never sees plaintext content, only encrypted blobs.

## Features

- **WebSocket Relay** - Real-time message forwarding for encrypted group rooms
- **One-Time Messages (OTM)** - Encrypted pastebin with single-read enforcement
- **Private File Drop** - Encrypted file storage with single-download enforcement
- **Zero Storage** - No persistent message storage, in-memory room registry only
- **Automatic Cleanup** - Rooms destroyed 5s after last user leaves

## Project Structure

```
backend/
├── src/
│   ├── relay.ts          # WebSocket relay server
│   ├── api/
│   │   ├── otm.ts        # One-time message endpoints
│   │   └── file.ts       # File drop endpoints
│   └── utils/
│       └── cleanup.ts    # Automatic expiration handling
├── package.json
├── tsconfig.json
└── README.md
```

## Quick Start

### Prerequisites
- Node.js 18+
- npm or pnpm

### Installation

```bash
npm install
```

### Development

```bash
npm run dev
```

### Production

```bash
npm run build
NODE_ENV=production PORT=3001 node dist/relay.js
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Server port |
| `NODE_ENV` | `development` | Environment mode |

## API Reference

### WebSocket Relay

**Connect**: `ws://localhost:3001/relay?roomId=<id>`

**Client → Server**:
```json
{
  "type": "message",
  "iv": "base64url...",
  "ciphertext": "base64url..."
}
```

**Server → Client**:
```json
{
  "type": "connected|user_joined|user_left|message",
  "clientCount": 2,
  "iv": "base64url...",
  "ciphertext": "base64url..."
}
```

### One-Time Messages

**POST /otm** - Store encrypted message
```json
Request: { "ciphertext": "iv.ciphertext" }
Response: { "id": "abc123" }
```

**GET /otm/:id** - Retrieve and delete (single-read)
```json
Response: { "ciphertext": "iv.ciphertext" }
```
Returns 410 if already viewed or expired.

### File Drop

**POST /file** - Store encrypted file
```
Content-Type: application/octet-stream
Body: <encrypted binary>
Response: { "id": "xyz789" }
```

**GET /file/:id** - Retrieve and delete (single-download)
```
Response: <encrypted binary>
Content-Type: application/octet-stream
```
Returns 410 if already downloaded or expired.

## Security Model

**What the server NEVER sees:**
- Plaintext messages or file content
- Encryption keys (stored in URL fragments)
- User identities
- Original filenames or metadata

**What the server DOES see:**
- Room IDs (random, meaningless)
- Encrypted blob IDs
- Encrypted ciphertext
- Connection timing metadata

## Deployment

Recommended hosts: Railway, Fly.io, DigitalOcean App Platform, AWS Fargate

**Important configuration:**
- Use WSS (WebSocket over TLS)
- Disable detailed access logs
- Configure CORS for your frontend domain
- Allow WebSocket upgrade headers

## License

Copyright (C) 2026 OpenZK LLC

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published
by the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

**OpenZK LLC** — Wyoming, United States.
