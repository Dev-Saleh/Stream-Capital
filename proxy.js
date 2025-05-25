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
const MARKET_STATUS_URL = 'https://api-capital.backend-capital.com/api/v1/markets/GOLD';
const TOKEN_FILE = path.join(__dirname, 'session.json');

let CST = null;
let X_SECURITY_TOKEN = null;
let capitalSocket = null;
let reconnectTimer = null;

let noDataTimeout = null;
const NO_DATA_LIMIT_MS = 15000;
let mockInterval = null;
const MOCK_INTERVAL_MS = 2000;
let mockPrice = null;
let marketIsOpen = false;

const app = express();
app.use(cors());

app.get('/', (req, res) => res.send('🟢 Capital.com Proxy is running'));
app.get('/healthz', (req, res) => res.send('OK'));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

function saveTokens(cst, token) {
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ cst, securityToken: token }));
  } catch (err) {
    console.error('❌ Failed to save tokens:', err.message);
  }
}

function loadTokens() {
  if (fs.existsSync(TOKEN_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      CST = data.cst;
      X_SECURITY_TOKEN = data.securityToken;
      console.log('🔁 Loaded session tokens from file');
    } catch (err) {
      console.warn('⚠️ Failed to parse session.json, ignoring. Will login fresh.');
      CST = null;
      X_SECURITY_TOKEN = null;
    }
  } else {
    console.log('there is session.json file');
  }
}

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
    try {
      await loginToCapital();
    } catch (e) {
      console.error('❌ Re-login failed during session keep-alive:', e.message);
    }
  }
}

setInterval(() => keepSessionAlive().catch(console.error), 9 * 60 * 1000);

async function checkMarketStatus() {
  try {
    if (!CST || !X_SECURITY_TOKEN) {
      await loginToCapital();
    }

    const res = await axios.get(MARKET_STATUS_URL, {
      headers: {
        CST,
        'X-SECURITY-TOKEN': X_SECURITY_TOKEN
      }
    });

    const marketStatus = res.data.snapshot?.marketStatus;
    marketIsOpen = marketStatus === 'OPEN';
    mockPrice = res.data.snapshot?.bid || 3400;
    console.log(`ℹ️ Market status: ${marketIsOpen ? 'OPEN' : 'CLOSED'}`);
    return marketIsOpen;

  } catch (e) {
    console.error('❌ Failed to fetch market status:', e.response?.data || e.message);
    return false;
  }
}

function startMockData() {
  if (mockInterval) return;

  console.log('🟠 Starting mock gold price feed');
  let fakePrice = mockPrice;

  mockInterval = setInterval(() => {
    try {
      fakePrice += (Math.random() - 0.5) * 5;
      const mockData = {
        source: 'Mock',
        bid: parseFloat(fakePrice.toFixed(2)),
        ask: parseFloat((fakePrice + 0.3).toFixed(2)),
        bidQty: 10 + Math.floor(Math.random() * 10),
        askQty: 10 + Math.floor(Math.random() * 10),
        timestamp: Date.now(),
        note: 'mock price, market closed'
      };
      wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify(mockData));
        }
      });
    } catch (err) {
      console.error('❌ Error in mock data generation:', err.message);
    }
  }, MOCK_INTERVAL_MS);
}

function stopMockData() {
  try {
    if (mockInterval) {
      clearInterval(mockInterval);
      mockInterval = null;
      console.log('🟢 Stopped mock price feed');
    }
  } catch (err) {
    console.error('❌ Failed to stop mock data:', err.message);
  }
}

function resetNoDataTimer() {
  if (noDataTimeout) clearTimeout(noDataTimeout);
  noDataTimeout = setTimeout(() => {
    console.warn(`⚠️ No real data received for ${NO_DATA_LIMIT_MS / 1000}s, switching to mock prices`);
    startMockData();
  }, NO_DATA_LIMIT_MS);
}

async function connectToCapitalSocket() {
  try {
    if (!CST || !X_SECURITY_TOKEN) await loginToCapital();

    capitalSocket = new WebSocket(STREAM_URL);

    capitalSocket.on('open', () => {
      try {
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
        resetNoDataTimer();
      } catch (err) {
        console.error('❌ Error sending subscription message:', err.message);
      }
    });

    capitalSocket.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.destination === 'quote' && msg.payload?.epic === 'GOLD') {
          stopMockData();
          resetNoDataTimer();

          const clean = {
            source: 'Real',
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

    capitalSocket.on('close', async () => {
      console.warn('🔌 Capital WebSocket closed.');
      startMockData();

      reconnectTimer = setTimeout(async () => {
        reconnectTimer = null;
        const open = await checkMarketStatus();
        if (open) {
          await connectToCapitalSocket();
        } else {
          console.log('ℹ️ Market closed, continuing mock prices');
        }
      }, 5000);
    });

    capitalSocket.on('error', (err) => {
      console.error('❌ WebSocket error:', err.message);
      if (capitalSocket) capitalSocket.close();
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

wss.on('connection', (client) => {
  console.log('📡 Client connected');
  console.log(`👥 Live clients: ${wss.clients.size}`);
  client.send(JSON.stringify({ message: 'Connected to GOLD price feed' }));

  client.on('close', (code, reason) => {
    console.log(`❌ Client disconnected. Code: ${code}, Reason: ${reason}`);
    console.log(`👥 Live clients: ${wss.clients.size}`);
  });
});

(async () => {
  try {

    loadTokens();
    server.listen(PORT, '0.0.0.0', async () => {
      console.log(`🚀 Server running on ws://0.0.0.0:${PORT}`);
      marketIsOpen = await checkMarketStatus();
      console.log(marketIsOpen);
      if (marketIsOpen) {
        await connectToCapitalSocket();
      } else {
        startMockData();
      }
    });
  } catch (err) {
    console.error('❌ Failed to start server:', err.message);
  }
})();
process.on('uncaughtException', (err) => {
  console.error('🚨 Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🚨 Unhandled Rejection at:', promise, 'reason:', reason);
});
console.log(`🔁 Server cold boot at ${new Date().toISOString()}`);

function shutdown() {
  console.log('\n🛑 Shutting down...');
  try {
    if (capitalSocket) capitalSocket.close();
    stopMockData();
    server.close(() => process.exit(0));
  } catch (err) {
    console.error('❌ Error during shutdown:', err.message);
    process.exit(1);
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
