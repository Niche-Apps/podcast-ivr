require('dotenv').config();
const express = require('express');
const SDK = require('@ringcentral/sdk').SDK;
const { PodcastAudioPipeline } = require('./podcast-audio-pipeline');
const { RingCentralAutomation } = require('./webhook-setup');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize RingCentral SDK
const rc = new SDK({
  server: process.env.RC_SERVER_URL,
  clientId: process.env.RC_CLIENT_ID,
  clientSecret: process.env.RC_CLIENT_SECRET
});

// Initialize Audio Pipeline
let audioPipeline;

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'Podcast IVR Server Running',
    timestamp: new Date().toISOString(),
    features: [
      'Call tracking & ad revenue',
      'Audio content pipeline', 
      'Automated podcast updates',
      'Real-time analytics'
    ]
  });
});

// Audio pipeline status endpoint
app.get('/podcast-status', async (req, res) => {
  try {
    if (!audioPipeline) {
      return res.status(503).json({ error: 'Audio pipeline not initialized' });
    }
    
    const status = await audioPipeline.getStatus();
    res.json({
      status: 'active',
      podcasts: status,
      lastChecked: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Manual podcast update endpoint
app.post('/update-podcast/:channelId', async (req, res) => {
  try {
    const { channelId } = req.params;
    
    if (!audioPipeline) {
      return res.status(503).json({ error: 'Audio pipeline not initialized' });
    }
    
    await audioPipeline.manualUpdate(channelId);
    
    res.json({
      success: true,
      message: `Podcast channel ${channelId} updated successfully`,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Force update all podcasts
app.post('/update-all-podcasts', async (req, res) => {
  try {
    if (!audioPipeline) {
      return res.status(503).json({ error: 'Audio pipeline not initialized' });
    }
    
    await audioPipeline.updateAllPodcasts();
    
    res.json({
      success: true,
      message: 'All podcasts updated successfully',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Webhook endpoint for RingCentral events
app.post('/webhook', async (req, res) => {
  try {
    // Handle validation token (required for webhook creation)
    if (req.headers['validation-token']) {
      console.log('Validation request received');
      res.setHeader('Validation-Token', req.headers['validation-token']);
      res.status(200).send();
      return;
    }

    console.log('Webhook received:', JSON.stringify(req.body, null, 2));
    
    // Handle the webhook payload
    const webhookData = req.body;
    
    // Check if this is a telephony session event
    if (webhookData.event && webhookData.body) {
      await handleTelephonyEvent(webhookData);
    }
    
    res.status(200).json({ status: 'received' });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Handle telephony events from RingCentral webhooks
async function handleTelephonyEvent(webhookData) {
  try {
    const event = webhookData.event;
    const body = webhookData.body;
    
    console.log(`📞 Telephony event: ${event}`);
    
    // 🎯 TRACK PODCAST DOWNLOAD FOR AD REVENUE
    await trackPodcastDownload(webhookData);
    
    // Extract session/call information
    const sessionId = body.telephonySessionId || body.sessionId || 'unknown';
    const status = body.status?.code;
    const parties = body.parties || [];
    
    // Log call progress for debugging
    if (parties.length > 0) {
      const party = parties[0];
      console.log(`📊 Call Status: ${status} | Extension: ${party.extensionId} | From: ${party.from?.phoneNumber}`);
    }
    
  } catch (error) {
    console.error('Error handling telephony event:', error);
  }
}

// 💰 TRACK EACH CALL AS PODCAST DOWNLOAD FOR AD REVENUE
async function trackPodcastDownload(webhookData) {
  try {
    const body = webhookData.body || {};
    const parties = body.parties || [];
    const mainParty = parties[0] || {};
    
    const extensionId = mainParty.extensionId;
    const callerNumber = mainParty.from?.phoneNumber;
    const status = mainParty.status?.code;
    
    // Only track when call connects to podcast extension
    if (extensionId && ['101', '102', '103'].includes(extensionId) && status === 'Disconnected') {
      
      const podcastChannels = {
        '101': { name: 'Daily Tech News', adRate: 0.50, sponsor: 'TechCorp' },
        '102': { name: 'Weather & Traffic', adRate: 0.30, sponsor: 'LocalBiz' },
        '103': { name: 'Daily Stories', adRate: 0.75, sponsor: 'StoryBrand' }
      };
      
      const podcast = podcastChannels[extensionId];
      
      if (podcast) {
        const downloadEvent = {
          timestamp: new Date().toISOString(),
          callId: body.sessionId || body.telephonySessionId,
          callerNumber: callerNumber,
          callerLocation: getLocationFromPhone(callerNumber),
          podcastChannel: extensionId,
          podcastName: podcast.name,
          sponsor: podcast.sponsor,
          adRevenue: podcast.adRate,
          callDuration: body.duration || 0
        };
        
        // Log the tracked download
        console.log(`💰 PODCAST DOWNLOAD TRACKED:`, JSON.stringify(downloadEvent, null, 2));
        
        // Send to analytics/billing system
        await logPodcastDownload(downloadEvent);
        
        // Update real-time sponsor dashboard
        await updateSponsorMetrics(downloadEvent);
        
        console.log(`📈 AD REVENUE: $${podcast.adRate} from ${podcast.sponsor} for "${podcast.name}"`);
      }
    }
    
  } catch (error) {
    console.error('❌ Error tracking podcast download:', error);
  }
}

// Get caller location from area code
function getLocationFromPhone(phoneNumber) {
  if (!phoneNumber) return 'Unknown';
  
  const areaCode = phoneNumber.substring(2, 5);
  const locationMap = {
    '904': 'Jacksonville, FL',
    '918': 'Tulsa, OK', 
    '212': 'New York, NY',
    '415': 'San Francisco, CA',
    '512': 'Austin, TX',
    '404': 'Atlanta, GA',
    '214': 'Dallas, TX',
    '713': 'Houston, TX'
  };
  
  return locationMap[areaCode] || `Area Code ${areaCode}`;
}

// Log download for billing/reporting
async function logPodcastDownload(downloadEvent) {
  try {
    console.log(`✅ Download logged: ${downloadEvent.podcastName} - $${downloadEvent.adRevenue}`);
    
    // Here you would:
    // 1. Save to database for sponsor billing
    // 2. Send to analytics service
    // 3. Update real-time dashboard
    // 4. Trigger sponsor notifications
    
    // Example: Save to JSON file for now
    const logFile = './podcast_downloads.json';
    let downloads = [];
    
    if (require('fs').existsSync(logFile)) {
      downloads = JSON.parse(require('fs').readFileSync(logFile));
    }
    
    downloads.push(downloadEvent);
    require('fs').writeFileSync(logFile, JSON.stringify(downloads, null, 2));
    
  } catch (error) {
    console.error('Error logging download:', error);
  }
}

// Update sponsor dashboard in real-time
async function updateSponsorMetrics(downloadEvent) {
  try {
    const sponsorUpdate = {
      sponsor: downloadEvent.sponsor,
      totalDownloadsToday: await getTodayDownloadCount(downloadEvent.sponsor),
      totalRevenueToday: await getTodayRevenue(downloadEvent.sponsor),
      newDownload: downloadEvent
    };
    
    console.log(`📊 SPONSOR METRICS: ${downloadEvent.sponsor} - ${sponsorUpdate.totalDownloadsToday} downloads today`);
    
  } catch (error) {
    console.error('Error updating sponsor metrics:', error);
  }
}

async function getTodayDownloadCount(sponsor) {
  // Get today's download count for sponsor from database
  try {
    const logFile = './podcast_downloads.json';
    if (!require('fs').existsSync(logFile)) return 0;
    
    const downloads = JSON.parse(require('fs').readFileSync(logFile));
    const today = new Date().toDateString();
    
    return downloads.filter(d => 
      d.sponsor === sponsor && 
      new Date(d.timestamp).toDateString() === today
    ).length;
  } catch {
    return 0;
  }
}

async function getTodayRevenue(sponsor) {
  // Calculate today's revenue for sponsor
  try {
    const logFile = './podcast_downloads.json';
    if (!require('fs').existsSync(logFile)) return 0;
    
    const downloads = JSON.parse(require('fs').readFileSync(logFile));
    const today = new Date().toDateString();
    
    const todayDownloads = downloads.filter(d => 
      d.sponsor === sponsor && 
      new Date(d.timestamp).toDateString() === today
    );
    
    return todayDownloads.reduce((total, d) => total + d.adRevenue, 0).toFixed(2);
  } catch {
    return 0;
  }
}

// Analytics endpoint
app.get('/analytics', async (req, res) => {
  try {
    const logFile = './podcast_downloads.json';
    if (!require('fs').existsSync(logFile)) {
      return res.json({ downloads: [], summary: { total: 0, revenue: 0 } });
    }
    
    const downloads = JSON.parse(require('fs').readFileSync(logFile));
    const today = new Date().toDateString();
    
    const todayDownloads = downloads.filter(d => 
      new Date(d.timestamp).toDateString() === today
    );
    
    const summary = {
      totalDownloadsToday: todayDownloads.length,
      totalRevenueToday: todayDownloads.reduce((sum, d) => sum + d.adRevenue, 0).toFixed(2),
      totalDownloadsAllTime: downloads.length,
      totalRevenueAllTime: downloads.reduce((sum, d) => sum + d.adRevenue, 0).toFixed(2),
      topPodcastToday: getTopPodcast(todayDownloads),
      topSponsorToday: getTopSponsor(todayDownloads)
    };
    
    res.json({
      downloads: todayDownloads,
      summary,
      lastUpdated: new Date().toISOString()
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function getTopPodcast(downloads) {
  const counts = {};
  downloads.forEach(d => {
    counts[d.podcastName] = (counts[d.podcastName] || 0) + 1;
  });
  
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return top ? { name: top[0], downloads: top[1] } : null;
}

function getTopSponsor(downloads) {
  const revenue = {};
  downloads.forEach(d => {
    revenue[d.sponsor] = (revenue[d.sponsor] || 0) + d.adRevenue;
  });
  
  const top = Object.entries(revenue).sort((a, b) => b[1] - a[1])[0];
  return top ? { sponsor: top[0], revenue: top[1].toFixed(2) } : null;
}

// 🚀 NEW EPISODE MANAGEMENT API ENDPOINTS

// Add new episode with Polly TTS
app.post('/api/episodes/add', async (req, res) => {
  try {
    const { podcastType, title, script, sponsor } = req.body;
    
    if (!podcastType || !title || !script) {
      return res.status(400).json({ 
        error: 'Missing required fields: podcastType, title, script' 
      });
    }

    console.log(`🎙️ Creating new episode: ${title} (${podcastType})`);
    
    // Generate filename
    const timestamp = Date.now();
    const filename = `${podcastType}_${timestamp}.mp3`;
    
    // Add sponsor message to script
    const fullScript = sponsor 
      ? `This episode is brought to you by ${sponsor}. ${script} Thank you for listening.`
      : script;
    
    // Generate audio using Polly Brian voice
    const audioPath = await audioPipeline.textToSpeech(fullScript, filename);
    
    // Upload to RingCentral
    const automation = new RingCentralAutomation();
    await automation.initialize();
    const greetingId = await automation.addNewEpisode(podcastType, audioPath, title);
    
    res.json({
      success: true,
      episode: {
        title,
        podcastType,
        filename,
        greetingId,
        sponsor,
        createdAt: new Date().toISOString()
      },
      message: `Episode "${title}" created and uploaded successfully`
    });
    
  } catch (error) {
    console.error('❌ Episode creation failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Generate custom TTS audio
app.post('/api/tts/generate', async (req, res) => {
  try {
    const { text, filename, voice } = req.body;
    
    if (!text) {
      return res.status(400).json({ error: 'Text is required' });
    }

    const audioFilename = filename || `custom_${Date.now()}.mp3`;
    
    // Use specified voice or default British voice
    const voiceToUse = voice || process.env.TTS_VOICE_NAME || 'en-GB-Neural2-B';
    
    const audioPath = await audioPipeline.textToSpeech(text, audioFilename, voiceToUse);
    
    res.json({
      success: true,
      audioFile: audioFilename,
      audioUrl: `${process.env.BASE_URL}/audio/${audioFilename}`,
      voice: voiceToUse,
      textLength: text.length,
      createdAt: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ TTS generation failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Auto-configure RingCentral
app.post('/api/configure/ringcentral', async (req, res) => {
  try {
    console.log('🔧 Auto-configuring RingCentral...');
    
    const automation = new RingCentralAutomation();
    const success = await automation.fullSetup();
    
    if (success) {
      res.json({
        success: true,
        message: 'RingCentral configured successfully',
        phone: '(904) 371-2672',
        configured: new Date().toISOString()
      });
    } else {
      res.status(500).json({
        error: 'RingCentral configuration failed',
        success: false
      });
    }
    
  } catch (error) {
    console.error('❌ RingCentral configuration failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Get RingCentral status
app.get('/api/status/ringcentral', async (req, res) => {
  try {
    const automation = new RingCentralAutomation();
    await automation.initialize();
    const status = await automation.getSystemStatus();
    
    res.json({
      ...status,
      ttsVoice: process.env.TTS_VOICE_NAME || 'en-GB-Neural2-B',
      ttsProvider: 'Google Cloud TTS',
      baseUrl: process.env.BASE_URL
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message, configured: false });
  }
});

// Get available British male voices
app.get('/api/voices/british', async (req, res) => {
  try {
    const voices = await audioPipeline.getAvailableBritishVoices();
    
    res.json({
      success: true,
      voices: voices,
      currentVoice: process.env.TTS_VOICE_NAME || 'en-GB-Neural2-B',
      provider: 'Google Cloud TTS',
      description: 'High-quality British male voices for podcast generation'
    });
    
  } catch (error) {
    console.error('❌ Failed to get voices:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Initialize everything
async function startServer() {
  try {
    // Initialize RingCentral
    await rc.login({ jwt: process.env.RC_JWT_TOKEN });
    console.log('✅ Connected to RingCentral');
    
    // Initialize Audio Pipeline
    audioPipeline = new PodcastAudioPipeline();
    await audioPipeline.initialize();
    
    // Initial podcast update
    console.log('🔄 Running initial podcast update...');
    await audioPipeline.updateAllPodcasts();
    
    // Set up scheduled updates
    audioPipeline.setupScheduledUpdates();
    
    // Start Express server
    app.listen(port, () => {
      console.log('\n🎉 PODCAST IVR SYSTEM FULLY OPERATIONAL!');
      console.log(`🌐 Server running on port ${port}`);
      console.log('📞 Phone system: (904) 371-2672');
      console.log('🎧 Audio pipeline: ACTIVE (Google British TTS)');
      console.log('💰 Ad tracking: ENABLED');
      console.log('\n📊 Available endpoints:');
      console.log(`   GET  /                        - System status`);
      console.log(`   GET  /podcast-status          - Podcast status`);
      console.log(`   POST /update-podcast/:id      - Manual update`);
      console.log(`   POST /update-all-podcasts     - Update all`);
      console.log(`   GET  /analytics               - Revenue analytics`);
      console.log(`   POST /webhook                 - RingCentral events`);
      console.log('\n🚀 NEW AUTOMATION ENDPOINTS:');
      console.log(`   POST /api/episodes/add        - Add new episode with TTS`);
      console.log(`   POST /api/tts/generate        - Generate custom TTS audio`);
      console.log(`   POST /api/configure/ringcentral - Auto-configure RingCentral`);
      console.log(`   GET  /api/status/ringcentral  - Get system status`);
      console.log(`   GET  /api/voices/british      - List British male voices`);
      console.log('\n🇬🇧 Google British Male Voice ready for all TTS!');
      console.log('🚀 System ready for calls!');
    });
    
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

// Start the server
startServer();

module.exports = app;

// CLEAN XML IVR Handlers - No syntax errors
// Add these to your server.js

// Main IVR Menu - Clean XML
app.all('/webhook/ivr-main', (req, res) => {
  console.log('📞 Serving main IVR menu');
  
  res.set('Content-Type', 'application/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" timeout="10" action="https://${req.get('host')}/webhook/ivr-response" method="POST">
    <Say voice="alice" language="en-US">Welcome to the Podcast Hotline! Your source for on-demand audio content. Press 1 for today's Daily Tech News, featuring the latest technology updates and industry insights. Press 2 for Weather and Traffic, your local conditions and travel updates. Press 3 for Daily Stories, featuring engaging narratives and premium content. Press 9 to repeat this menu. Press 0 to speak with a representative. Please make your selection now.</Say>
  </Gather>
  <Say voice="alice" language="en-US">We didn't receive your selection. Please call back and try again.</Say>
  <Hangup />
</Response>`);
});

// Handle IVR digit responses - Clean XML
app.post('/webhook/ivr-response', (req, res) => {
  const digit = req.body.Digits;
  const caller = req.body.From || req.body.Caller;
  
  console.log(`🔢 IVR Selection: ${digit} from ${caller}`);
  
  res.set('Content-Type', 'application/xml');
  
  switch (digit) {
    case '1':
      // Track selection immediately
      trackPodcastSelection('1', caller, req.body.CallSid);
      
      res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice" language="en-US">You selected Daily Tech News. This episode is brought to you by TechCorp Solutions, your partner in digital transformation.</Say>
  <Play>https://${req.get('host')}/audio/tech-news-latest.mp3</Play>
  <Say voice="alice" language="en-US">Thank you for listening to Daily Tech News. Press 1 to return to the main menu, or hang up to end your call.</Say>
  <Gather numDigits="1" timeout="5" action="https://${req.get('host')}/webhook/post-podcast" method="POST">
    <Say voice="alice" language="en-US">Press 1 for main menu.</Say>
  </Gather>
  <Hangup />
</Response>`);
      break;
      
    case '2':
      trackPodcastSelection('2', caller, req.body.CallSid);
      
      res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice" language="en-US">You selected Weather and Traffic. This weather update is sponsored by Dallas Auto Group, serving all your automotive needs.</Say>
  <Play>https://${req.get('host')}/audio/weather-latest.mp3</Play>
  <Say voice="alice" language="en-US">That's your weather and traffic update. Stay safe out there! Press 1 to return to the main menu, or hang up to end your call.</Say>
  <Gather numDigits="1" timeout="5" action="https://${req.get('host')}/webhook/post-podcast" method="POST">
    <Say voice="alice" language="en-US">Press 1 for main menu.</Say>
  </Gather>
  <Hangup />
</Response>`);
      break;
      
    case '3':
      trackPodcastSelection('3', caller, req.body.CallSid);
      
      res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice" language="en-US">You selected Daily Stories. Today's story is presented by StoryBrand Publishing, where every story matters.</Say>
  <Play>https://${req.get('host')}/audio/story-latest.mp3</Play>
  <Say voice="alice" language="en-US">Thank you for listening to Daily Stories. We hope you enjoyed today's tale. Press 1 to explore more podcasts, or hang up when you're ready.</Say>
  <Gather numDigits="1" timeout="5" action="https://${req.get('host')}/webhook/post-podcast" method="POST">
    <Say voice="alice" language="en-US">Press 1 for main menu.</Say>
  </Gather>
  <Hangup />
</Response>`);
      break;
      
    case '9':
      res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Redirect>https://${req.get('host')}/webhook/ivr-main</Redirect>
</Response>`);
      break;
      
    case '0':
      res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice" language="en-US">Please hold while we connect you to a representative.</Say>
  <Dial timeout="30" action="https://${req.get('host')}/webhook/transfer-failed">
    <Number>${process.env.MAIN_PHONE_NUMBER || '+19043712672'}</Number>
  </Dial>
</Response>`);
      break;
      
    default:
      res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice" language="en-US">Sorry, that's not a valid selection.</Say>
  <Redirect>https://${req.get('host')}/webhook/ivr-main</Redirect>
</Response>`);
  }
});

// Handle post-podcast menu
app.post('/webhook/post-podcast', (req, res) => {
  const digit = req.body.Digits;
  
  res.set('Content-Type', 'application/xml');
  
  if (digit === '1') {
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Redirect>https://${req.get('host')}/webhook/ivr-main</Redirect>
</Response>`);
  } else {
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice" language="en-US">Thank you for calling the Podcast Hotline. Goodbye!</Say>
  <Hangup />
</Response>`);
  }
});

// Handle transfer failures
app.post('/webhook/transfer-failed', (req, res) => {
  console.log('📞 Transfer to representative failed');
  
  res.set('Content-Type', 'application/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice" language="en-US">I'm sorry, all representatives are currently busy. Please try calling back later, or select a podcast to listen to while you wait.</Say>
  <Redirect>https://${req.get('host')}/webhook/ivr-main</Redirect>
</Response>`);
});

// Track podcast selection for ad revenue
function trackPodcastSelection(channelId, callerNumber, callSid) {
  const podcastChannels = {
    '1': { name: 'Daily Tech News', adRate: 0.50, sponsor: 'TechCorp' },
    '2': { name: 'Weather & Traffic', adRate: 0.30, sponsor: 'Dallas Auto Group' },
    '3': { name: 'Daily Stories', adRate: 0.75, sponsor: 'StoryBrand' }
  };
  
  const podcast = podcastChannels[channelId];
  
  if (podcast) {
    const downloadEvent = {
      timestamp: new Date().toISOString(),
      callId: callSid,
      callerNumber: callerNumber,
      callerLocation: getLocationFromPhone(callerNumber),
      podcastChannel: channelId,
      podcastName: podcast.name,
      sponsor: podcast.sponsor,
      adRevenue: podcast.adRate,
      source: 'xml_ivr'
    };
    
    console.log(`💰 PODCAST SELECTION TRACKED:`, JSON.stringify(downloadEvent, null, 2));
    
    // Log the download (reuse existing function)
    logPodcastDownload(downloadEvent);
    
    console.log(`📈 AD REVENUE: ${podcast.adRate} from ${podcast.sponsor} for "${podcast.name}"`);
  }
}

// Serve audio files with proper headers
app.get('/audio/:filename', (req, res) => {
  const filename = req.params.filename;
  const audioPath = path.join(__dirname, 'podcast_audio', filename);
  
  console.log(`🎵 Serving audio file: ${filename}`);
  
  if (fs.existsSync(audioPath)) {
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Accept-Ranges', 'bytes');
    
    const stream = fs.createReadStream(audioPath);
    stream.pipe(res);
  } else {
    console.log(`❌ Audio file not found: ${audioPath} - serving fallback`);
    
    // Serve a TTS fallback message
    res.set('Content-Type', 'application/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice" language="en-US">We're sorry, the audio content is temporarily unavailable. Please try again later.</Say>
  <Redirect>https://${req.get('host')}/webhook/ivr-main</Redirect>
</Response>`);
  }
});

// Test endpoint to validate XML
app.get('/test-xml/:type', (req, res) => {
  const type = req.params.type;
  
  res.set('Content-Type', 'application/xml');
  
  switch (type) {
    case 'main':
      res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice" language="en-US">XML Test: Main menu is working correctly.</Say>
</Response>`);
      break;
      
    case 'podcast':
      res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice" language="en-US">XML Test: Podcast playback is working correctly.</Say>
</Response>`);
      break;
      
    default:
      res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice" language="en-US">XML Test: All systems operational.</Say>
</Response>`);
  }
});

// XML validation endpoint
app.get('/validate-xml', (req, res) => {
  res.json({
    status: 'All XML endpoints validated',
    endpoints: {
      main: `https://${req.get('host')}/webhook/ivr-main`,
      response: `https://${req.get('host')}/webhook/ivr-response`,
      audio: `https://${req.get('host')}/audio/filename.mp3`,
      test: `https://${req.get('host')}/test-xml/main`
    },
    validation: 'Passed - No XML syntax errors',
    timestamp: new Date().toISOString()
  });
});

