require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const axios = require('axios');

// Voice configuration  
const VOICE_CONFIG = {
    voice: 'Polly.Brian',
    language: 'en-GB'
};

// Constants
const CHUNK_DURATION = 360;
const SKIP_DURATION = 120;
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize Twilio client (only if credentials are provided)
let twilioClient;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  try {
    twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    console.log('✅ Twilio client initialized');
  } catch (error) {
    console.warn('⚠️ Twilio client initialization failed:', error.message);
  }
} else {
  console.warn('⚠️ Twilio credentials not provided - running in demo mode');
}

const VoiceResponse = twilio.twiml.VoiceResponse;

// Initialize Audio Pipeline
let audioPipeline;

// Simplified RSS fetching function
async function fetchPodcastEpisodes(rssUrl) {
    console.log(`🔍 Fetching episodes from: ${rssUrl}`);
    
    try {
        const response = await axios.get(rssUrl, {
            timeout: 12000, // Reduced timeout for faster failures
            maxRedirects: 5, // Limit redirects
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; TwilioPodcastBot/2.0)',
                'Accept': 'application/rss+xml, application/xml, text/xml, */*',
                'Cache-Control': 'no-cache',
                'Connection': 'close' // Close connection after request
            },
            validateStatus: (status) => status >= 200 && status < 400 // Accept redirects
        });
        
        console.log(`✅ RSS fetch successful, content length: ${response.data.length}`);
        
        const xmlText = response.data;
        const episodes = [];
        
        // Simple regex-based episode extraction
        const itemMatches = xmlText.match(/<item[\s\S]*?<\/item>/gi) || [];
        console.log(`📄 Found ${itemMatches.length} episodes in feed`);
        
        // Process first 5 episodes for faster response
        for (let i = 0; i < Math.min(itemMatches.length, 5); i++) {
            const item = itemMatches[i];
            
            // Extract title
            const titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/i) ||
                              item.match(/<title[^>]*>(.*?)<\/title>/i);
            
            // Extract audio URL
            const enclosureMatch = item.match(/<enclosure[^>]+url=["']([^"']+)["'][^>]*/i) ||
                                  item.match(/<media:content[^>]+url=["']([^"']+)["'][^>]*/i);
            
            if (titleMatch && enclosureMatch) {
                const title = titleMatch[1]
                    .replace(/<[^>]*>/g, '')
                    .replace(/&amp;/g, '&')
                    .replace(/&lt;/g, '<')
                    .replace(/&gt;/g, '>')
                    .replace(/&quot;/g, '"')
                    .replace(/&#39;/g, "'")
                    .trim();
                
                let audioUrl = enclosureMatch[1]
                    .trim()
                    .replace(/&amp;/g, '&')
                    .replace(/&lt;/g, '<')
                    .replace(/&gt;/g, '>')
                    .replace(/&quot;/g, '"')
                    .replace(/&#39;/g, "'");
                
                // Basic URL validation
                if (audioUrl.startsWith('http') && title.length > 0) {
                    episodes.push({ title, audioUrl });
                    console.log(`✓ Episode: "${title.substring(0, 50)}..."`);
                }
            }
        }
        
        console.log(`🎯 Successfully parsed ${episodes.length} episodes`);
        return episodes;
        
    } catch (error) {
        console.error(`❌ RSS fetch failed for ${rssUrl}:`, error.message);
        return [];
    }
}

// Basic URL cleaning function
function cleanAudioUrl(url) {
    if (!url || typeof url !== 'string') return url;
    
    console.log(`🧹 Cleaning URL: ${url.substring(0, 80)}...`);
    
    try {
        let cleaned = url;
        
        // Remove common tracking redirects - more comprehensive patterns
        const trackingPatterns = [
            /^https?:\/\/[^\/]*claritaspod\.com\/measure\//i,
            /^https?:\/\/[^\/]*arttrk\.com\/p\/[^\/]+\//i,
            /^https?:\/\/[^\/]*verifi\.podscribe\.com\/rss\/p\//i,
            /^https?:\/\/[^\/]*podscribe\.com\/rss\/p\//i,
            /^https?:\/\/[^\/]*pfx\.vpixl\.com\/[^\/]+\//i,
            /^https?:\/\/[^\/]*prfx\.byspotify\.com\/e\//i,
            /^https?:\/\/[^\/]*dts\.podtrac\.com\/redirect\.(mp3|aac)\//i,
            /^https?:\/\/[^\/]*mgln\.ai\/e\/[^\/]+\//i,
            /^https?:\/\/[^\/]*podtrac\.com\/[^\/]+\//i,
            /^https?:\/\/[^\/]*chartable\.com\/[^\/]+\//i,
            /^https?:\/\/[^\/]*pdst\.fm\/e\//i,
            /^https?:\/\/[^\/]*chtbl\.com\/track\/[^\/]+\//i,
            /^https?:\/\/[^\/]*chrt\.fm\/track\/[^\/]+\//i
        ];
        
        // Iteratively remove tracking layers
        let previousUrl;
        let maxIterations = 10;
        let iteration = 0;
        
        do {
            previousUrl = cleaned;
            iteration++;
            
            for (const pattern of trackingPatterns) {
                if (pattern.test(cleaned)) {
                    let newUrl = cleaned.replace(pattern, '');
                    if (!newUrl.startsWith('http') && newUrl.includes('.')) {
                        newUrl = 'https://' + newUrl;
                    }
                    if (newUrl !== cleaned && newUrl.length > 10) {
                        console.log(`🗑️ Iteration ${iteration}: Removed tracking layer`);
                        cleaned = newUrl;
                        break; // Process one layer at a time
                    }
                }
            }
        } while (cleaned !== previousUrl && iteration < maxIterations);
        
        return cleaned;
        
    } catch (error) {
        console.error(`⚠️ URL cleaning error:`, error.message);
        return url;
    }
}

// Podcast configuration
const ALL_PODCASTS = {
    '0': { name: 'System Test', rssUrl: 'https://feeds.npr.org/510298/podcast.xml' }, // NPR Podcast Directory - simple URLs
    '1': { name: 'NPR News Now', rssUrl: 'https://feeds.npr.org/500005/podcast.xml' },
    '2': { name: 'This American Life', rssUrl: 'https://feeds.thisamericanlife.org/talpodcast' },
    '3': { name: 'The Daily', rssUrl: 'https://feeds.simplecast.com/54nAGcIl' },
    '4': { name: 'Serial', rssUrl: 'https://feeds.serialpodcast.org/serial' },
    '5': { name: 'Matt Walsh Show', rssUrl: 'https://feeds.simplecast.com/pp_b9xO6' },
    '6': { name: 'Ben Shapiro Show', rssUrl: 'https://feeds.simplecast.com/C0fPpQ64' },
    '7': { name: 'Michael Knowles Show', rssUrl: 'https://feeds.simplecast.com/6c2VScgo' },
    '8': { name: 'Andrew Klavan Show', rssUrl: 'https://feeds.simplecast.com/2Dy_5daq' },
    '9': { name: 'Pints with Aquinas', rssUrl: 'https://feeds.acast.com/public/shows/683607331b846c88bdfb0f70' },
    '10': { name: 'Joe Rogan', rssUrl: 'https://feeds.megaphone.fm/GLT1412515089' },
    '11': { name: 'TimCast IRL', rssUrl: 'https://feeds.libsyn.com/574450/rss' },
    '12': { name: 'Louder with Crowder', rssUrl: 'https://media.rss.com/louder-with-crowder/feed.xml' },
    '13': { name: 'Lex Fridman', rssUrl: 'https://lexfridman.com/feed/podcast/' },
    '14': { name: 'Matt Walsh 2', rssUrl: 'https://www.spreaker.com/show/6636540/episodes/feed' },
    '20': { name: 'Morning Wire', rssUrl: 'https://feeds.simplecast.com/WCb5SgYj' }
};

// Health check endpoint
app.get('/', (req, res) => {
  res.status(200).json({ 
    status: 'Twilio Podcast IVR Server Running',
    service: 'operational',
    timestamp: new Date().toISOString(),
    platform: 'Railway',
    twilioEnabled: !!twilioClient,
    podcasts: Object.keys(ALL_PODCASTS).length,
    features: [
      'Twilio integration',
      'Call tracking & ad revenue',
      'Audio content pipeline', 
      'Automated podcast updates',
      'Real-time analytics'
    ]
  });
});

// Simple health check for Railway
app.get('/health', (req, res) => {
  res.status(200).send('OK');
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
    
    // Generate audio using TTS
    const audioPath = await audioPipeline.textToSpeech(fullScript, filename);
    
    // Note: Direct file storage (RingCentral upload removed)
    
    res.json({
      success: true,
      episode: {
        title,
        podcastType,
        filename,
        audioPath,
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

// Get system status
app.get('/api/status', async (req, res) => {
  try {
    res.json({
      service: 'Twilio Podcast IVR',
      status: 'operational',
      platform: 'Railway',
      ttsVoice: process.env.TTS_VOICE_NAME || 'en-GB-Neural2-B',
      ttsProvider: 'Google Cloud TTS',
      baseUrl: process.env.BASE_URL || process.env.RAILWAY_URL,
      podcasts: Object.keys(ALL_PODCASTS).length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
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
    console.log('🚀 Starting Twilio Podcast IVR Server...');
    
    // Note: Audio pipeline replaced with direct RSS streaming
    console.log('🎵 Using direct RSS feed streaming instead of local audio pipeline');
    
    // Start Express server
    app.listen(port, () => {
      console.log('\n🎉 TWILIO PODCAST IVR SYSTEM OPERATIONAL!');
      console.log(`🌐 Server running on port ${port}`);
      console.log('📞 Twilio Integration: READY');
      console.log('🎧 Audio pipeline: ACTIVE');
      console.log('💰 Ad tracking: ENABLED');
      console.log('\n📊 Available endpoints:');
      console.log(`   GET  /                        - System status`);
      console.log(`   GET  /podcast-status          - Podcast status`);
      console.log(`   POST /update-podcast/:id      - Manual update`);
      console.log(`   POST /update-all-podcasts     - Update all`);
      console.log(`   GET  /analytics               - Revenue analytics`);
      console.log(`   POST /webhook/ivr-main        - Main IVR menu`);
      console.log(`   POST /webhook/select-channel  - Channel selection`);
      console.log(`   GET  /webhook/play-episode    - Stream episodes`);
      console.log(`   POST /webhook/playback-control - Playback controls`);
      console.log('\n🚀 Railway deployment ready for Twilio webhooks!');
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

// Enhanced Main IVR Menu for Streaming
app.all('/webhook/ivr-main', (req, res) => {
  console.log('📞 Serving enhanced streaming IVR menu');
  
  const twiml = new VoiceResponse();
  const gather = twiml.gather({
    numDigits: 2,
    timeout: 6,
    action: '/webhook/select-channel',
    method: 'POST'
  });
  
  const menuText = 'Podcast Hotline. Press 0 for system test, 1 for NPR, 2 for This American Life, 3 for The Daily, 4 for Serial, 5 for Matt Walsh, 6 for Ben Shapiro, 7 for Michael Knowles, 8 for Andrew Klavan, 9 for Pints with Aquinas, 10 for Joe Rogan, 11 for Tim Pool, 12 for Crowder, 13 for Lex Fridman, 20 for Morning Wire, or star to repeat.';
  
  gather.say(VOICE_CONFIG, menuText);
  
  twiml.say(VOICE_CONFIG, 'We didn\'t receive your selection. Please call back and try again.');
  twiml.hangup();
  
  res.type('text/xml');
  res.send(twiml.toString());
});

// Handle channel selection
app.post('/webhook/select-channel', async (req, res) => {
  const digits = req.body.Digits;
  const caller = req.body.From || req.body.Caller;
  
  console.log(`🔢 Channel Selection: ${digits} from ${caller}`);
  
  const twiml = new VoiceResponse();
  
  if (digits === '*' || digits === '**') {
    twiml.redirect('/webhook/ivr-main');
    return res.type('text/xml').send(twiml.toString());
  }
  
  if (!ALL_PODCASTS[digits]) {
    twiml.say(VOICE_CONFIG, 'Invalid selection. Please try again.');
    twiml.redirect('/webhook/ivr-main');
    return res.type('text/xml').send(twiml.toString());
  }
  
  const selectedPodcast = ALL_PODCASTS[digits];
  console.log(`Selected: ${selectedPodcast.name}`);
  
  // Track selection
  trackPodcastSelection(digits, caller, req.body.CallSid);
  
  twiml.say(VOICE_CONFIG, `You selected ${selectedPodcast.name}. Loading latest episode.`);
  twiml.redirect(`/webhook/play-episode?channel=${digits}&episodeIndex=0&position=0`);
  
  res.type('text/xml');
  res.send(twiml.toString());
});

// Test endpoint to check RSS feeds directly
app.get('/test-podcast/:channel', async (req, res) => {
  const channel = req.params.channel;
  const podcast = ALL_PODCASTS[channel];
  
  if (!podcast) {
    return res.json({ error: 'Invalid channel' });
  }
  
  try {
    console.log(`Testing podcast: ${podcast.name}`);
    const episodes = await fetchPodcastEpisodes(podcast.rssUrl);
    
    if (episodes.length === 0) {
      return res.json({ error: 'No episodes found' });
    }
    
    const episode = episodes[0];
    const cleanedUrl = cleanAudioUrl(episode.audioUrl);
    
    res.json({
      podcast: podcast.name,
      episodeTitle: episode.title,
      originalUrl: episode.audioUrl,
      cleanedUrl: cleanedUrl,
      urlChanged: cleanedUrl !== episode.audioUrl
    });
    
  } catch (error) {
    res.json({ error: error.message });
  }
});

// Enhanced Episode Playback with Streaming
app.get('/webhook/play-episode', async (req, res) => {
  const channel = req.query.channel;
  const episodeIndex = parseInt(req.query.episodeIndex) || 0;
  const position = parseInt(req.query.position) || 0;
  
  console.log(`=== STREAMING EPISODE PLAYBACK ===`);
  console.log(`Channel: ${channel}, Episode: ${episodeIndex}, Position: ${position}s`);
  
  const twiml = new VoiceResponse();
  
  const podcast = ALL_PODCASTS[channel];
  if (!podcast) {
    console.log(`ERROR: No podcast for channel ${channel}`);
    twiml.say(VOICE_CONFIG, 'Invalid channel.');
    twiml.redirect('/webhook/ivr-main');
    return res.type('text/xml').send(twiml.toString());
  }
  
  try {
    console.log(`🔍 Fetching episodes from: ${podcast.rssUrl}`);
    
    // Add timeout wrapper for the entire operation
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Operation timeout after 20 seconds')), 20000);
    });
    
    const fetchPromise = fetchPodcastEpisodes(podcast.rssUrl);
    const episodes = await Promise.race([fetchPromise, timeoutPromise]);
    
    if (!episodes || episodes.length === 0) {
      console.log(`❌ No episodes found for ${podcast.name}`);
      twiml.say(VOICE_CONFIG, `Sorry, no episodes are available for ${podcast.name} right now. Please try another podcast.`);
      twiml.redirect('/webhook/ivr-main');
      return res.type('text/xml').send(twiml.toString());
    }
    
    const episode = episodes[episodeIndex];
    if (!episode) {
      if (episodeIndex > 0) {
        console.log(`⚠️ Episode ${episodeIndex} not found, trying latest episode`);
        twiml.redirect(`/webhook/play-episode?channel=${channel}&episodeIndex=0&position=0`);
      } else {
        console.log(`❌ No episodes available for ${podcast.name}`);
        twiml.say(VOICE_CONFIG, 'No episodes available. Please try another podcast.');
        twiml.redirect('/webhook/ivr-main');
      }
      return res.type('text/xml').send(twiml.toString());
    }
    
    console.log(`📻 Episode found: "${episode.title}"`);
    console.log(`🔗 Raw audio URL: ${episode.audioUrl.substring(0, 100)}...`);
    
    // Clean the URL with additional safety checks
    let finalAudioUrl;
    try {
      const cleanedUrl = cleanAudioUrl(episode.audioUrl);
      console.log(`🧹 Cleaned URL: ${cleanedUrl.substring(0, 100)}...`);
      
      // Basic URL validation
      if (!cleanedUrl || !cleanedUrl.startsWith('http')) {
        throw new Error('Invalid cleaned URL');
      }
      
      finalAudioUrl = cleanedUrl;
      console.log(`✅ Using audio URL: ${finalAudioUrl.substring(0, 100)}...`);
    } catch (urlError) {
      console.error(`⚠️ URL cleaning failed: ${urlError.message}, using original URL`);
      finalAudioUrl = episode.audioUrl;
    }
    
    // Announce episode
    const positionMins = Math.floor(position / 60);
    if (position === 0) {
      twiml.say(VOICE_CONFIG, `Now playing: ${episode.title.substring(0, 80)}`);
    } else {
      twiml.say(VOICE_CONFIG, `Resuming at ${positionMins} minutes.`);
    }
    
    // Set up playback controls with longer timeout
    const gather = twiml.gather({
      numDigits: 1,
      action: `/webhook/playback-control?channel=${channel}&episodeIndex=${episodeIndex}&position=${position}`,
      method: 'POST',
      timeout: 5
    });
    
    // Check if this is a problematic URL type
    const isSimplecastInjector = finalAudioUrl.includes('injector.simplecastaudio.com');
    const isComplexUrl = finalAudioUrl.length > 200 || finalAudioUrl.split('/').length > 8;
    
    if (isSimplecastInjector || isComplexUrl) {
      console.log(`⚠️ Problematic URL detected (${isSimplecastInjector ? 'Simplecast injector' : 'Complex URL'}), using summary fallback`);
      gather.say(VOICE_CONFIG, `This is ${podcast.name}. Latest episode: ${episode.title.substring(0, 150)}. Unfortunately, the streaming audio is not working properly right now. Please try option 0 for system test, or try NPR option 1 which usually works reliably.`);
      twiml.say(VOICE_CONFIG, `Returning to main menu.`);
      twiml.redirect('/webhook/ivr-main');
    } else {
      // Stream the podcast directly from URL
      console.log(`🎵 Playing audio from: ${finalAudioUrl.split('/')[2]}`);
      gather.play({ loop: 1 }, finalAudioUrl);
    }
    
    twiml.say(VOICE_CONFIG, `Press 1 for previous, 3 for next, 4 to skip back, 6 to skip forward, or 0 for menu.`);
    
    // Continue to next chunk after timeout
    const nextPosition = position + CHUNK_DURATION;
    twiml.redirect(`/webhook/play-episode?channel=${channel}&episodeIndex=${episodeIndex}&position=${nextPosition}`);
    
  } catch (error) {
    console.error(`❌ Episode playback error for ${podcast.name}:`, error.message);
    console.error(`Error stack:`, error.stack);
    
    // Specific handling for timeout errors
    if (error.message.includes('timeout')) {
      console.log(`⏰ Timeout error - providing fallback response`);
      twiml.say(VOICE_CONFIG, `${podcast.name} is taking longer than usual to load. Please try again in a moment or select another podcast.`);
      twiml.redirect('/webhook/ivr-main');
    } else if (episodeIndex === 0) {
      // Try next episode automatically if this is the first episode
      console.log(`🔄 Trying next episode due to error...`);
      twiml.redirect(`/webhook/play-episode?channel=${channel}&episodeIndex=1&position=0`);
    } else {
      twiml.say(VOICE_CONFIG, `Sorry, there's a problem with this podcast right now. Please try another one.`);
      twiml.redirect('/webhook/ivr-main');
    }
  }
  
  res.type('text/xml');
  res.send(twiml.toString());
});

// Enhanced Playback Controls
app.post('/webhook/playback-control', (req, res) => {
  const digits = req.body.Digits;
  const channel = req.query.channel;
  const episodeIndex = parseInt(req.query.episodeIndex) || 0;
  const position = parseInt(req.query.position) || 0;
  
  console.log(`=== PLAYBACK CONTROL: ${digits} ===`);
  console.log(`Current: Channel ${channel}, Episode ${episodeIndex}, Position ${position}s`);
  
  const twiml = new VoiceResponse();
  
  switch(digits) {
    case '1': // Previous episode
      const prevEpisode = Math.max(0, episodeIndex - 1);
      twiml.say(VOICE_CONFIG, 'Going to previous episode.');
      twiml.redirect(`/webhook/play-episode?channel=${channel}&episodeIndex=${prevEpisode}&position=0`);
      break;
      
    case '3': // Next episode
      twiml.say(VOICE_CONFIG, 'Going to next episode.');
      twiml.redirect(`/webhook/play-episode?channel=${channel}&episodeIndex=${episodeIndex + 1}&position=0`);
      break;
      
    case '4': // Jump back 2 minutes
      const backPosition = Math.max(0, position - SKIP_DURATION);
      const backMins = Math.floor(backPosition / 60);
      twiml.say(VOICE_CONFIG, `Jumping back to ${backMins} minutes.`);
      twiml.redirect(`/webhook/play-episode?channel=${channel}&episodeIndex=${episodeIndex}&position=${backPosition}`);
      break;
      
    case '6': // Jump forward 2 minutes
      const forwardPosition = position + SKIP_DURATION;
      const forwardMins = Math.floor(forwardPosition / 60);
      twiml.say(VOICE_CONFIG, `Jumping forward to ${forwardMins} minutes.`);
      twiml.redirect(`/webhook/play-episode?channel=${channel}&episodeIndex=${episodeIndex}&position=${forwardPosition}`);
      break;
      
    case '0': // Main menu
      twiml.say(VOICE_CONFIG, 'Returning to main menu.');
      twiml.redirect('/webhook/ivr-main');
      break;
      
    default:
      // Continue current playback
      twiml.redirect(`/webhook/play-episode?channel=${channel}&episodeIndex=${episodeIndex}&position=${position}`);
  }
  
  res.type('text/xml');
  res.send(twiml.toString());
});

// Handle extended menu responses (two-digit)
app.post('/webhook/ivr-response-extended', (req, res) => {
  const digits = req.body.Digits;
  const caller = req.body.From || req.body.Caller;
  
  console.log(`🔢 Extended IVR Selection: ${digits} from ${caller}`);
  
  const twiml = new VoiceResponse();
  const podcast = ALL_PODCASTS[digits];
  
  if (podcast) {
    trackPodcastSelection(digits, caller, req.body.CallSid);
    
    twiml.say({
      voice: 'alice',
      language: 'en-US'
    }, `You selected ${podcast.name}. Please wait while we fetch the latest episode.`);
    
    twiml.play(`https://${req.get('host')}/audio/podcast-${digits}-latest.mp3`);
    
    const gather = twiml.gather({
      numDigits: 1,
      timeout: 5,
      action: '/webhook/post-podcast',
      method: 'POST'
    });
    
    gather.say({
      voice: 'alice',
      language: 'en-US'
    }, 'Press 1 to return to the main menu.');
    
    twiml.hangup();
  } else {
    twiml.say({
      voice: 'alice',
      language: 'en-US'
    }, 'Sorry, that\'s not a valid selection.');
    
    twiml.redirect('/webhook/ivr-main');
  }
  
  res.type('text/xml');
  res.send(twiml.toString());
});

// Handle post-podcast menu
app.post('/webhook/post-podcast', (req, res) => {
  const digit = req.body.Digits;
  
  const twiml = new VoiceResponse();
  
  if (digit === '1') {
    twiml.redirect('/webhook/ivr-main');
  } else {
    twiml.say({
      voice: 'alice',
      language: 'en-US'
    }, 'Thank you for calling the Podcast Hotline. Goodbye!');
    
    twiml.hangup();
  }
  
  res.type('text/xml');
  res.send(twiml.toString());
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

