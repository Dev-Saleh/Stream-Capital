// capital_proxy_server.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

// === Config ===
const PORT = process.env.PORT || 8080;
const SESSION_URL = 'https://api-capital.backend-capital.com/api/v1/session';
const STREAM_URL = 'wss://api-streaming-capital.backend-capital.com/connect';
const PING_URL = 'https://api-capital.backend-capital.com/api/v1/ping';
const TOKEN_FILE = path.join(__dirname, 'session.json');

let CST = null;
let X_SECURITY_TOKEN = null;
let capitalSocket = null;
let reconnectTimer = null;

const app = express();
app.use(cors());

// === Express Routes ===
app.get('/', (req, res) => res.send('🟢 Capital.com Proxy is running'));
app.get('/healthz', (req, res) => res.send('OK'));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// === Token Persistence ===
function saveTokens(cst, token) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ cst, securityToken: token }));
}

function loadTokens() {
  if (fs.existsSync(TOKEN_FILE)) {
    const data = JSON.parse(fs.readFileSync(TOKEN_FILE));
    CST = data.cst;
    X_SECURITY_TOKEN = data.securityToken;
    console.log('🔁 Loaded session tokens from file');
  }
}

// === Auth ===
async function loginToCapital() {
  try {
    const { CAPITAL_API_KEY, CAPITAL_EMAIL, CAPITAL_PASSWORD } = process.env;
    if (!CAPITAL_API_KEY || !CAPITAL_EMAIL || !CAPITAL_PASSWORD) {
      throw new Error('Missing CAPITAL credentials');
    }

    const response = await axios.post(
      SESSION_URL,
      { identifier: CAPITAL_EMAIL, password: CAPITAL_PASSWORD },
      {
        headers: {
          'X-CAP-API-KEY': CAPITAL_API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );

    CST = response.headers['cst'];
    X_SECURITY_TOKEN = response.headers['x-security-token'];
    saveTokens(CST, X_SECURITY_TOKEN);
    console.log('✅ Logged in to Capital.com');
  } catch (err) {
    console.error('❌ Login failed:', err.response?.data || err.message);
    throw err;
  }
}

// === Keep Session Alive ===
async function keepSessionAlive() {
  try {
    await axios.get(PING_URL, {
      headers: {
        CST,
        'X-SECURITY-TOKEN': X_SECURITY_TOKEN,
      }
    });
    console.log('🔄 Session still valid');
  } catch (err) {
    console.log('⚠️ Session expired, relogin...');
    await loginToCapital();
  }
}

setInterval(() => keepSessionAlive().catch(console.error), 9 * 60 * 1000);

// === Capital Streaming ===
async function connectToCapitalSocket() {
  try {
    if (!CST || !X_SECURITY_TOKEN) await loginToCapital();

    capitalSocket = new WebSocket(STREAM_URL);

    capitalSocket.on('open', () => {
      console.log('🌐 Connected to Capital WebSocket');
      const subscribeMsg = {
        destination: 'marketData.subscribe',
        correlationId: '100',
        cst: CST,
        securityToken: X_SECURITY_TOKEN,
        payload: {
          epics: ['GOLD']
        }
      };
      capitalSocket.send(JSON.stringify(subscribeMsg));
    });

    capitalSocket.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.destination === 'quote' && msg.payload?.epic === 'GOLD') {
          const clean = {
            bid: msg.payload.bid,
            ask: msg.payload.ofr,
            bidQty: msg.payload.bidQty,
            askQty: msg.payload.ofrQty,
            timestamp: msg.payload.timestamp
          };
          wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify(clean));
            }
          });
        }
      } catch (e) {
        console.warn('⚠️ Failed to parse message:', e.message);
      }
    });

    capitalSocket.on('close', () => {
      console.warn('🔌 Capital WebSocket closed. Reconnecting...');
      scheduleReconnect();
    });

    capitalSocket.on('error', (err) => {
      console.error('❌ WebSocket error:', err.message);
      scheduleReconnect();
    });
  } catch (err) {
    console.error('❌ Failed to connect socket:', err.message);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToCapitalSocket().catch(console.error);
  }, 5000);
}

// === WebSocket Proxy ===
wss.on('connection', (client) => {
  console.log('📡 Client connected');
  client.send(JSON.stringify({ message: 'Connected to GOLD price feed' }));
});

// === Start Server ===
loadTokens();
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on ws://0.0.0.0:${PORT}`);
  connectToCapitalSocket().catch(console.error);
});

// === Graceful Shutdown ===
function shutdown() {
  console.log('\n🛑 Shutting down...');
  if (capitalSocket) capitalSocket.close();
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
