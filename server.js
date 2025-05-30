// package.json - what you'll need
{
  "name": "ringcentral-podcast-ivr",
  "version": "1.0.0",
  "dependencies": {
    "express": "^4.18.0",
    "@ringcentral/sdk": "^5.0.0", 
    "axios": "^1.6.0",
    "dotenv": "^16.0.0"
  },
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js"
  }
}

// Main app structure
const express = require('express');
const RingCentral = require('@ringcentral/sdk').SDK;
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

// RingCentral setup
const rcsdk = new RingCentral({
  server: process.env.RC_SERVER_URL,
  clientId: process.env.RC_CLIENT_ID,
  clientSecret: process.env.RC_CLIENT_SECRET
});

// Podcast configuration
const PODCASTS = {
  '1': {
    name: 'Tech News Daily',
    streamUrl: 'https://your-cdn.com/tech-latest.mp3'
  },
  '2': {
    name: 'Comedy Hour', 
    streamUrl: 'https://your-cdn.com/comedy-latest.mp3'
  },
  '3': {
    name: 'True Crime Weekly',
    streamUrl: 'https://your-cdn.com/crime-latest.mp3'
  },
  '4': {
    name: 'Business Insights',
    streamUrl: 'https://your-cdn.com/business-latest.mp3'
  },
  '5': {
    name: 'Health Talk',
    streamUrl: 'https://your-cdn.com/health-latest.mp3'
  },
  '11': {
    name: 'Science Explained',
    streamUrl: 'https://your-cdn.com/science-latest.mp3'
  },
  '12': {
    name: 'History Deep Dive', 
    streamUrl: 'https://your-cdn.com/history-latest.mp3'
  }
};

// Main IVR webhook - handles incoming calls
app.post('/webhooks/main-menu', async (req, res) => {
  const response = {
    "action": "talk",
    "text": "Welcome to the Podcast Hotline! Press 1 for Tech News, 2 for Comedy, 3 for True Crime, 4 for Business, 5 for Health, 11 for Science, 12 for History, 77 for weather forecast, 90 for voicemail, or 0 to repeat options.",
    "language": "en-US"
  };
  
  res.json([response, {
    "action": "input",
    "type": "dtmf",
    "options": {
      "maxDigits": 2,
      "timeout": 10,
      "submitOnHash": true
    },
    "eventUrl": `${process.env.BASE_URL}/webhooks/handle-input`
  }]);
});

// Handle DTMF input
app.post('/webhooks/handle-input', async (req, res) => {
  const { dtmf } = req.body;
  
  // Podcast selection
  if (PODCASTS[dtmf]) {
    const podcast = PODCASTS[dtmf];
    res.json([
      {
        "action": "talk",
        "text": `Now playing ${podcast.name}. Press star to return to the main menu.`,
        "language": "en-US"
      },
      {
        "action": "playAudio", 
        "uri": podcast.streamUrl,
        "options": {
          "bargeIn": true
        }
      },
      {
        "action": "input",
        "type": "dtmf",
        "options": {
          "maxDigits": 1,
          "timeout": 3600 // 1 hour timeout for long podcasts
        },
        "eventUrl": `${process.env.BASE_URL}/webhooks/during-podcast`
      }
    ]);
  }
  
  // Weather service
  else if (dtmf === '77') {
    res.json([
      {
        "action": "talk",
        "text": "Weather forecast service. Please enter your 5-digit zip code followed by the pound key.",
        "language": "en-US"
      },
      {
        "action": "input",
        "type": "dtmf", 
        "options": {
          "maxDigits": 5,
          "timeout": 15,
          "submitOnHash": true
        },
        "eventUrl": `${process.env.BASE_URL}/webhooks/get-weather`
      }
    ]);
  }
  
  // Voicemail
  else if (dtmf === '90') {
    res.json([
      {
        "action": "talk",
        "text": "Please leave your message after the beep. Press pound when finished.",
        "language": "en-US"
      },
      {
        "action": "record",
        "options": {
          "maxDuration": 180, // 3 minutes max
          "playBeep": true,
          "submitOnHash": true
        },
        "eventUrl": `${process.env.BASE_URL}/webhooks/save-voicemail`
      }
    ]);
  }
  
  // Repeat menu
  else if (dtmf === '0') {
    res.redirect(307, '/webhooks/main-menu');
  }
  
  // Invalid input
  else {
    res.json([
      {
        "action": "talk",
        "text": "Invalid selection. Please try again.",
        "language": "en-US"
      }
    ]);
    // Redirect back to main menu after brief pause
    setTimeout(() => {
      res.redirect(307, '/webhooks/main-menu');
    }, 2000);
  }
});

// Handle input during podcast playback
app.post('/webhooks/during-podcast', async (req, res) => {
  const { dtmf } = req.body;
  
  if (dtmf === '*') {
    // Return to main menu
    res.json([
      {
        "action": "talk",
        "text": "Returning to main menu.",
        "language": "en-US"
      }
    ]);
    // Redirect to main menu
    setTimeout(() => {
      res.redirect(307, '/webhooks/main-menu');
    }, 1000);
  } else {
    // Continue playing podcast
    res.json([]);
  }
});

// Weather service integration
app.post('/webhooks/get-weather', async (req, res) => {
  const { dtmf: zipCode } = req.body;
  
  try {
    // Using OpenWeatherMap API (free tier available)
    const weatherResponse = await axios.get(
      `https://api.openweathermap.org/data/2.5/weather?zip=${zipCode},US&appid=${process.env.WEATHER_API_KEY}&units=imperial`
    );
    
    const weather = weatherResponse.data;
    const forecast = `The current weather in ${weather.name} is ${Math.round(weather.main.temp)} degrees with ${weather.weather[0].description}. 
                     The high today is ${Math.round(weather.main.temp_max)} and the low is ${Math.round(weather.main.temp_min)} degrees.`;
    
    res.json([
      {
        "action": "talk",
        "text": forecast,
        "language": "en-US"
      },
      {
        "action": "talk",
        "text": "Press any key to return to the main menu.",
        "language": "en-US"
      },
      {
        "action": "input",
        "type": "dtmf",
        "options": { "maxDigits": 1, "timeout": 10 },
        "eventUrl": `${process.env.BASE_URL}/webhooks/main-menu`
      }
    ]);
    
  } catch (error) {
    res.json([
      {
        "action": "talk", 
        "text": "Sorry, weather information is currently unavailable. Press any key to return to the main menu.",
        "language": "en-US"
      },
      {
        "action": "input",
        "type": "dtmf",
        "options": { "maxDigits": 1, "timeout": 10 },
        "eventUrl": `${process.env.BASE_URL}/webhooks/main-menu`
      }
    ]);
  }
});

// Save voicemail 
app.post('/webhooks/save-voicemail', async (req, res) => {
  const { recordingUrl, duration } = req.body;
  
  // Here you could:
  // 1. Save recording URL to database
  // 2. Send notification email
  // 3. Transcribe the message
  // 4. Store caller info
  
  console.log(`New voicemail received: ${recordingUrl}, Duration: ${duration}s`);
  
  res.json([
    {
      "action": "talk",
      "text": "Thank you for your message. Have a great day!",
      "language": "en-US"
    },
    {
      "action": "hangup"
    }
  ]);
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`RingCentral Podcast IVR running on port ${PORT}`);
});

// Environment variables you'll need in .env file:
const envExample = `
RC_SERVER_URL=https://platform.ringcentral.com
RC_CLIENT_ID=your_client_id
RC_CLIENT_SECRET=your_client_secret
RC_JWT_TOKEN=your_jwt_token_here
RC_USERNAME=your_phone_number  # fallback auth
RC_PASSWORD=your_password      # fallback auth
WEATHER_API_KEY=your_openweathermap_key
BASE_URL=https://your-app.herokuapp.com
`;

module.exports = app;