require('dotenv').config();
const axios = require('axios');
const WebSocket = require('ws');
const http = require('http');

const SESSION_URL = 'https://api-capital.backend-capital.com/api/v1/session';
const STREAM_URL = 'wss://api-streaming-capital.backend-capital.com/connect';

const PORT = process.env.PORT || 8080;

let CST = null;
let X_SECURITY_TOKEN = null;
let capitalSocket = null;
let reconnectTimer = null;

// Create HTTP server to expose WebSocket
const server = http.createServer();
const wss = new WebSocket.Server({ server });

async function checkMarketStatus() {
  try {
    const response = await axios.get('https://api-capital.backend-capital.com/api/v1/markets/GOLD', {
      headers: {
        'CST': CST,
        'X-SECURITY-TOKEN': X_SECURITY_TOKEN
      }
    });

    const status = response.snapshot.marketStatus;
    console.log(`📊 Market status: ${status}`);
    return status;
  } catch (err) {
    console.error('❌ Failed to check market status:', err.response?.data || err.message);
    return null;
  }
}

/**
 * Authenticate to Capital.com and get session tokens
 */
async function loginToCapital() {
  try {
    const { CAPITAL_API_KEY, CAPITAL_EMAIL, CAPITAL_PASSWORD } = process.env;

    if (!CAPITAL_API_KEY || !CAPITAL_EMAIL || !CAPITAL_PASSWORD) {
      throw new Error('Missing CAPITAL API credentials in environment variables.');
    }

    const response = await axios.post(
      SESSION_URL,
      {
        identifier: CAPITAL_EMAIL,
        password: CAPITAL_PASSWORD
      },
      {
        headers: {
          'X-CAP-API-KEY': CAPITAL_API_KEY,
          'Content-Type': 'application/json',
        }
      }
    );

    CST = response.headers['cst'];
    X_SECURITY_TOKEN = response.headers['x-security-token'];

    console.log('✅ Authenticated with Capital.com');
  } catch (err) {
    console.error('❌ Login failed:', err.response?.data || err.message);
    throw err;
  }
}

/**
 * Connect and subscribe to gold prices
 */
async function connectToCapitalSocket() {
  await loginToCapital();
  
  capitalSocket = new WebSocket(STREAM_URL);

  capitalSocket.on('open', () => {
    console.log('✅ Connected to Capital.com streaming');
  
    const subscribeMsg = {
      destination: 'marketData.subscribe',
      correlationId: '100',
      cst: CST,
      securityToken: X_SECURITY_TOKEN,
      payload: {
        epics: ['GOLD'],
      }
    };

    capitalSocket.send(JSON.stringify(subscribeMsg));
  });



  capitalSocket.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);

      if (msg.destination === 'quote' && msg.payload?.epic === 'GOLD') {
        const cleanData = {
          bid: msg.payload.bid,
          ask: msg.payload.ofr,
          bidQty: msg.payload.bidQty,
          askQty: msg.payload.ofrQty,
          timestamp: msg.payload.timestamp,
        };

        wss.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(cleanData));
          }
        });
      }
    } catch (e) {
      console.warn('⚠️ Failed to parse incoming message:', e.message);
    }
  });

  capitalSocket.on('close', () => {
    console.warn('🔌 Capital.com WebSocket closed. Reconnecting...');
    attemptReconnect();
  });

  capitalSocket.on('error', (err) => {
    console.error('❌ WebSocket error:', err.message);
    attemptReconnect();
  });
}

/**
 * Retry connection to Capital after delay
 */
function attemptReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToCapitalSocket().catch(err => {
      console.error('❌ Reconnection failed:', err.message);
      attemptReconnect(); // retry again
    });
  }, 5000);
}

// Handle client connection to local proxy
wss.on('connection', async (ws) => {
  console.log('📡 Client connected to proxy');

  ws.send(JSON.stringify({ message: 'Checking market status for GOLD...' }));

  try {
    await loginToCapital(); // Ensure tokens are fresh
    const marketStatus = await checkMarketStatus();

    if (marketStatus !== 'TRADEABLE') {
      ws.send(JSON.stringify({
        status: 'CLOSED',
        message: 'Market is currently closed. Please try again later.',
        timestamp: Date.now()
      }));
      ws.close(); // Optional: close socket if no real-time stream will follow
      return;
    }

      } catch (e) {
        console.warn('⚠️ Failed to parse incoming message:', e.message);
      }
    });

    capitalWs.on('close', () => {
      console.warn('🔌 Capital.com stream closed for client');
    });

    ws.on('close', () => {
      console.log('❎ Client disconnected');
      capitalWs.close();
    });

  } catch (error) {
    console.error('❌ Error in client connection handler:', error.message);
    ws.send(JSON.stringify({
      status: 'ERROR',
      message: 'Internal server error or authentication failed.'
    }));
    ws.close();
  }
});

// wss.on('connection', (ws) => {
//   console.log('📡 Client connected to proxy');
//   ws.send(JSON.stringify({ message: 'Connected to GOLD price feed' }));
// });

// Start server
server.listen(PORT, () => {
  console.log(`🚀 Proxy running at ws://localhost:${PORT}`);
  connectToCapitalSocket().catch(err => {
    console.error('❌ Initial Capital connection failed:', err.message);
  });
});

// Graceful shutdown
function shutdown() {
  console.log('\n🔧 Shutting down...');
  if (capitalSocket) capitalSocket.close();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
