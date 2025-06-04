const express = require('express');
const RingCentral = require('@ringcentral/sdk').SDK;
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

// RingCentral setup with JWT
const rcsdk = new RingCentral({
  server: process.env.RC_SERVER_URL,
  clientId: process.env.RC_CLIENT_ID,
  clientSecret: process.env.RC_CLIENT_SECRET
});

// JWT Authentication
async function authenticateRingCentral() {
  try {
    await rcsdk.platform().login({
      jwt: process.env.RC_JWT_TOKEN
    });
    console.log('RingCentral JWT authentication successful');
  } catch (error) {
    console.error('RingCentral authentication failed:', error);
  }
}

// Initialize authentication on startup
authenticateRingCentral();

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date(),
    uptime: process.uptime()
  });
});

// Main IVR webhook
app.post('/webhooks/main-menu', async (req, res) => {
  console.log('Main menu accessed');
  
  const response = [
    {
      "action": "talk",
      "text": "Welcome to the Podcast Hotline! Press 1 for Tech News, 2 for Comedy, or 0 to repeat.",
      "language": "en-US"
    }
  ];
  
  res.json(response);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});