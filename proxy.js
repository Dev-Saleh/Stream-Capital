require('dotenv').config();
const axios = require('axios');
const WebSocket = require('ws');
const http = require('http');

const SESSION_URL = 'https://api-capital.backend-capital.com/api/v1/session';
const STREAM_URL = 'wss://api-streaming-capital.backend-capital.com/connect';

// Store CST and token
let CST = null;
let X_SECURITY_TOKEN = null;
let capitalSocket = null;

// Create HTTP and WebSocket proxy server for your devs
const server = http.createServer();
const wss = new WebSocket.Server({ server });

// Step 1: Authenticate session
async function loginToCapital() {
  try {
    const response = await axios.post(SESSION_URL, {
      identifier: process.env.CAPITAL_EMAIL,
      password: process.env.CAPITAL_PASSWORD,
    }, {
      headers: {
        'X-CAP-API-KEY': process.env.CAPITAL_API_KEY,
        'Content-Type': 'application/json',
      }
    });

    CST = response.headers['cst'];
    X_SECURITY_TOKEN = response.headers['x-security-token'];

    console.log('✅ Logged in. CST & Security Token received.');
  } catch (err) {
    console.error('❌ Failed to log in:', err.response?.data || err.message);
    throw err;
  }
}

// Step 2: Connect to WebSocket stream
async function connectToStream() {
  await loginToCapital();

  capitalSocket = new WebSocket(STREAM_URL);

  capitalSocket.on('open', () => {
    console.log('✅ WebSocket connected to Capital.com');
    
    // Subscribe to GOLD
    capitalSocket.send(JSON.stringify({
      destination: "marketData.subscribe",
      correlationId: "100",
      cst: CST,
      securityToken: X_SECURITY_TOKEN,
      payload: {
        epics: ["GOLD"]
      }
    }));
  });

  capitalSocket.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
  
      // Only forward quote updates
      if (msg.destination === 'quote' && msg.payload?.epic === 'GOLD') {
        const cleanData = {
          bid: msg.payload.bid,
          ask: msg.payload.ofr,
          bidQty: msg.payload.bidQty,
          askQty: msg.payload.ofrQty,
          timestamp: msg.payload.timestamp
        };
  
        // Broadcast to all frontend clients
        wss.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(cleanData));
          }
        });
      }
    } catch (err) {
      console.error('❌ Failed to parse Capital.com message:', err.message);
    }
  });
  

  capitalSocket.on('close', () => {
    console.warn('❗ WebSocket closed. Attempting to reconnect...');
    setTimeout(connectToStream, 5000); // retry
  });

  capitalSocket.on('error', (err) => {
    console.error('❌ WebSocket error:', err.message);
  });
}

// Step 3: Proxy server for frontend devs
wss.on('connection', (ws) => {
  console.log('📡 Frontend client connected to proxy');
  ws.send(JSON.stringify({ message: 'Connected to GOLD price proxy' }));
});

// Step 4: Start everything
server.listen(8080, () => {
  console.log('🌐 Proxy server is running on ws://localhost:8080');
  connectToStream();
});
