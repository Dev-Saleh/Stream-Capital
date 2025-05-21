const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());

const port = process.env.PORT || 3000;
const server = http.createServer(app); // هذا مهم

const wss = new WebSocket.Server({ server }); // نربطه بنفس السيرفر

// --- إعدادات Capital.com ---
const loginUrl = 'https://api-capital.backend-capital.com/api/v1/session';
const TOKEN_FILE = path.join(__dirname, 'session.json');

let currentTokens = {
  cst: null,
  securityToken: null
};

const credentials = {
  identifier: process.env.LOGIN_EMAIL || 'dvlpr.saleh@gmail.com',
  password: process.env.LOGIN_PASSWORD || 'Cc-0537221210'
};

function saveTokensToFile(cst, securityToken) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ cst, securityToken }));
}

function loadTokensFromFile() {
  if (fs.existsSync(TOKEN_FILE)) {
    const data = fs.readFileSync(TOKEN_FILE);
    return JSON.parse(data);
  }
  return null;
}

async function getSessionTokens() {
  try {
    const response = await axios.post(loginUrl, credentials, {
      headers: {
        'Content-Type': 'application/json',
        'X-CAP-API-KEY': process.env.API_KEY || 'vQ5hjpmakUVD0N3N'
      }
    });

    const cst = response.headers['cst'];
    const securityToken = response.headers['x-security-token'];

    currentTokens = { cst, securityToken };
    saveTokensToFile(cst, securityToken);
    console.log('✅ Session tokens refreshed');
  } catch (error) {
    console.error('❌ Login failed:', error.response?.data || error.message);
  }
}

async function keepSessionAlive() {
  try {
    const { cst, securityToken } = currentTokens;
    await axios.get('https://api-capital.backend-capital.com/api/v1/ping', {
      headers: {
        'CST': cst,
        'X-SECURITY-TOKEN': securityToken
      }
    });
    console.log('🔁 Session is alive');
  } catch (error) {
    console.log('⚠️ Session expired, refreshing...');
    await getSessionTokens();
  }
}

function startKeepAlive() {
  setInterval(keepSessionAlive, 9 * 60 * 1000);
}

// --- WebSocket Events ---
wss.on('connection', (wsClient) => {
  console.log('🟢 Client connected');
  subscribeToCapital(wsClient);
});
// wss.on('connection', (wsClient) => {
//   console.log('✅ Client connected');
  
//   // أرسل بيانات مباشرة بعد الاتصال للتجربة
//   wsClient.send(JSON.stringify({
//     bid: 250.35,
//     offer: 250.60,
//     timestamp: Date.now()
//   }));
// });

async function subscribeToCapital(wsClient) {
  let capitalWs;

  const connect = async () => {
    const { cst, securityToken } = currentTokens;
    capitalWs = new WebSocket('wss://api-streaming-capital.backend-capital.com/connect');

    capitalWs.on('open', () => {
      console.log('📡 Connected to Capital.com WebSocket');
      const subscribeMessage = {
        destination: 'marketData.subscribe',
        correlationId: '100',
        cst,
        securityToken,
        payload: {
          epics: ['GOLD']
        }
      };
      capitalWs.send(JSON.stringify(subscribeMessage));
    });

    capitalWs.on('message', (data) => {
      const msg = JSON.parse(data);
      // if (msg.status === 'ERROR' && msg.errorCode === 'unauthorized') {
      //   getSessionTokens().then(connect);
      //   return;
      // }
  
      if (msg.status === 'OK') {
        const update = {
          bid: msg.payload.bid,
          offer: msg.payload.ofr,
          timestamp: msg.payload.timestamp
        };
        wsClient.send(JSON.stringify(update));
      }
    });

    capitalWs.on('close', () => {
      console.log('❌ Capital WebSocket closed');
    });

    wsClient.on('close', () => {
      console.log('❎ Client disconnected');
      capitalWs.close();
    });
  };

  connect();
}

// --- Routes ---
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'test.html'));
});

app.get('/healthz', (req, res) => {
  res.send('OK');
});

// --- Start Server ---
const storedTokens = loadTokensFromFile();
if (storedTokens) {
  currentTokens = storedTokens;
} else {
  getSessionTokens();
}
startKeepAlive();

server.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Server running on ws://0.0.0.0:${port}`);
});

// server.listen(port, () => {
//   console.log(`🚀 Server running at http://localhost:${port}`);
// });
