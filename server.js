require('dotenv').config();
const express = require('express');
const SDK = require('@ringcentral/sdk');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// RingCentral configuration
const rc = new SDK({
  server: process.env.RC_SERVER_URL,
  clientId: process.env.RC_CLIENT_ID,
  clientSecret: process.env.RC_CLIENT_SECRET
});

let rcAuthStatus = 'not authenticated';

// Initialize RingCentral JWT authentication
async function initializeRingCentral() {
  try {
    await rc.login({ jwt: process.env.RC_JWT_TOKEN });
    console.log('RingCentral JWT authentication successful');
    rcAuthStatus = 'authenticated';
  } catch (error) {
    console.error('RingCentral authentication failed:', error);
    rcAuthStatus = 'failed';
  }
}

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    const uptime = process.uptime();
    
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: uptime,
      environment: process.env.NODE_ENV || 'development',
      ringcentral_auth: rcAuthStatus
    });
  } catch (error) {
    console.error('Health check error:', error);
    res.status(500).json({
      status: 'error',
      error: error.message
    });
  }
});

// Test endpoint
app.get('/test', (req, res) => {
  res.json({
    message: 'IVR System Test Successful',
    timestamp: new Date().toISOString(),
    endpoints: {
      health: `${process.env.BASE_URL}/health`,
      webhook: `${process.env.BASE_URL}/webhook`,
      test: `${process.env.BASE_URL}/test`
    },
    webhook_url: `${process.env.BASE_URL}/webhook`,
    system_status: {
      server: 'running',
      ringcentral_auth: rcAuthStatus,
      environment: process.env.NODE_ENV || 'development'
    }
  });
});

// Webhook endpoint for RingCentral events
app.post('/webhook', async (req, res) => {
  try {
    console.log('Webhook received:', JSON.stringify(req.body, null, 2));
    
    const events = req.body.body || [];
    
    for (const event of events) {
      if (event.eventType === 'call-session-event') {
        await handleCallEvent(event);
      }
    }
    
    res.status(200).json({ status: 'received' });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Handle call events and implement IVR logic
async function handleCallEvent(event) {
  try {
    const callId = event.body?.sessionId;
    const eventType = event.body?.eventType;
    
    console.log(`Call event: ${eventType} for call ${callId}`);
    
    if (eventType === 'established') {
      // Call answered - start IVR flow
      await startIVRFlow(callId);
    } else if (eventType === 'dtmf') {
      // Handle keypress
      const digit = event.body?.digit;
      await handleDTMFInput(callId, digit);
    }
  } catch (error) {
    console.error('Error handling call event:', error);
  }
}

// Start IVR flow
async function startIVRFlow(callId) {
  try {
    const welcomeMessage = "Welcome to the Podcast IVR! Press 1 for today's weather, Press 2 for a fun fact, Press 3 for the latest news, or Press 0 to speak with someone.";
    
    await playMessage(callId, welcomeMessage);
  } catch (error) {
    console.error('Error starting IVR flow:', error);
  }
}

// Handle DTMF input (keypress)
async function handleDTMFInput(callId, digit) {
  try {
    let message = '';
    
    switch (digit) {
      case '1':
        message = await getWeatherUpdate();
        break;
      case '2':
        message = getFunFact();
        break;
      case '3':
        message = await getLatestNews();
        break;
      case '0':
        message = "Transferring you to a representative. Please hold.";
        // In a real implementation, you would transfer the call here
        break;
      default:
        message = "Invalid selection. Press 1 for weather, 2 for fun fact, 3 for news, or 0 for representative.";
    }
    
    await playMessage(callId, message);
    
    // After playing message, return to main menu (except for transfer)
    if (digit !== '0') {
      setTimeout(() => {
        startIVRFlow(callId);
      }, 3000);
    }
  } catch (error) {
    console.error('Error handling DTMF input:', error);
  }
}

// Play message using RingCentral TTS
async function playMessage(callId, message) {
  try {
    await rc.post(`/restapi/v1.0/account/~/telephony/sessions/${callId}/parties/~/play`, {
      text: message,
      language: { languageCode: 'en-US' },
      voice: { voiceName: 'Joanna' }
    });
    
    console.log(`Played message to call ${callId}: ${message}`);
  } catch (error) {
    console.error('Error playing message:', error);
  }
}

// Get weather update
async function getWeatherUpdate() {
  try {
    if (!process.env.WEATHER_API_KEY) {
      return "Weather service is currently unavailable.";
    }
    
    // Using OpenWeatherMap API for Dallas, TX
    const response = await axios.get(`https://api.openweathermap.org/data/2.5/weather?q=Dallas,TX,US&appid=${process.env.WEATHER_API_KEY}&units=imperial`);
    
    const weather = response.data;
    const temp = Math.round(weather.main.temp);
    const description = weather.weather[0].description;
    
    return `Today's weather in Dallas: ${temp} degrees Fahrenheit with ${description}.`;
  } catch (error) {
    console.error('Weather API error:', error);
    return "Sorry, weather information is currently unavailable.";
  }
}

// Get fun fact
function getFunFact() {
  const facts = [
    "Did you know? Honey never spoils. Archaeologists have found pots of honey in ancient Egyptian tombs that are over 3,000 years old and still edible!",
    "Fun fact: A group of flamingos is called a 'flamboyance'!",
    "Interesting fact: Octopuses have three hearts and blue blood!",
    "Amazing fact: Bananas are berries, but strawberries aren't!",
    "Cool fact: A single cloud can weigh more than a million pounds!"
  ];
  
  const randomFact = facts[Math.floor(Math.random() * facts.length)];
  return randomFact;
}

// Get latest news (placeholder)
async function getLatestNews() {
  // In a real implementation, you would fetch from a news API
  return "Here's today's top story: Technology continues to advance rapidly, with new innovations in AI and automation making headlines worldwide.";
}

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Express error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Start server
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await initializeRingCentral();
});