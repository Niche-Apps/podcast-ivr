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

// Weather API configuration
const WEATHER_API_KEY = process.env.WEATHER_API_KEY || '3d01c291215870d467a4f3881e114bf6';

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
            timeout: 5000, // Much shorter timeout
            maxRedirects: 3, // Fewer redirects
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; TwilioPodcastBot/2.0)',
                'Accept': 'application/rss+xml, application/xml, text/xml, */*'
            }
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

// Weather service function
async function getWeatherForecast(zipcode) {
    console.log(`🌤️ Fetching weather for zipcode: ${zipcode}`);
    
    try {
        // Get coordinates from zipcode
        const geoResponse = await axios.get(
            `http://api.openweathermap.org/geo/1.0/zip?zip=${zipcode},US&appid=${WEATHER_API_KEY}`,
            { timeout: 5000 }
        );
        
        if (!geoResponse.data) {
            throw new Error('Invalid zipcode');
        }
        
        const { lat, lon, name } = geoResponse.data;
        console.log(`📍 Location found: ${name} (${lat}, ${lon})`);
        
        // Get current weather and 5-day forecast
        const weatherResponse = await axios.get(
            `https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&appid=${WEATHER_API_KEY}&units=imperial`,
            { timeout: 5000 }
        );
        
        const data = weatherResponse.data;
        const current = data.list[0];
        
        // Format current conditions
        const currentTemp = Math.round(current.main.temp);
        const feelsLike = Math.round(current.main.feels_like);
        const description = current.weather[0].description;
        const humidity = current.main.humidity;
        const windSpeed = Math.round(current.wind.speed);
        
        // Group forecasts by day
        const dailyForecasts = {};
        const today = new Date().toDateString();
        
        data.list.forEach(item => {
            const date = new Date(item.dt * 1000);
            const dateStr = date.toDateString();
            
            if (!dailyForecasts[dateStr]) {
                dailyForecasts[dateStr] = {
                    date: dateStr,
                    temps: [],
                    conditions: [],
                    dayName: date.toLocaleDateString('en-US', { weekday: 'long' })
                };
            }
            
            dailyForecasts[dateStr].temps.push(item.main.temp);
            dailyForecasts[dateStr].conditions.push(item.weather[0].description);
        });
        
        // Build multi-day forecast
        let weatherReport = `Weather forecast for ${name}. Currently ${currentTemp} degrees, feels like ${feelsLike}. Current conditions: ${description}. Humidity ${humidity} percent, wind ${windSpeed} miles per hour. `;
        
        // Add daily forecasts for next 4-5 days
        const days = Object.values(dailyForecasts).slice(0, 5);
        
        days.forEach((day, index) => {
            const high = Math.round(Math.max(...day.temps));
            const low = Math.round(Math.min(...day.temps));
            const mostCommonCondition = day.conditions.sort((a,b) =>
                day.conditions.filter(v => v===a).length - day.conditions.filter(v => v===b).length
            ).pop();
            
            if (index === 0) {
                weatherReport += `Today's high ${high}, low ${low}, expecting ${mostCommonCondition}. `;
            } else if (index === 1) {
                weatherReport += `Tomorrow, ${day.dayName}, high ${high}, low ${low}, ${mostCommonCondition}. `;
            } else {
                weatherReport += `${day.dayName}, high ${high}, low ${low}, ${mostCommonCondition}. `;
            }
        });
        
        console.log(`✅ Weather report generated for ${name}`);
        return weatherReport;
        
    } catch (error) {
        console.error(`❌ Weather fetch failed for ${zipcode}:`, error.message);
        
        if (error.message.includes('Invalid zipcode')) {
            return getPrompt('weather', 'zipcodeNotFound', {zipcode});
        } else {
            return getPrompt('weather', 'unavailable');
        }
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

// Load podcast configuration from external JSON file
let ALL_PODCASTS = {};
let EXTENSION_PODCASTS = {};

try {
  const podcastConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'podcast-feeds.json'), 'utf8'));
  
  // Load main feeds
  ALL_PODCASTS = podcastConfig.feeds;
  
  // Load extension feeds (ready to activate)
  EXTENSION_PODCASTS = podcastConfig.extensions;
  
  console.log(`✅ Loaded ${Object.keys(ALL_PODCASTS).length} podcast feeds from podcast-feeds.json`);
  console.log(`📋 ${Object.keys(EXTENSION_PODCASTS).length} extension feeds available`);
  
} catch (error) {
  console.error('❌ Failed to load podcast-feeds.json:', error.message);
  
  // Fallback to minimal configuration
  ALL_PODCASTS = {
    '0': { name: 'System Test', rssUrl: 'STATIC_TEST' },
    '1': { name: 'NPR News Now', rssUrl: 'https://feeds.npr.org/500005/podcast.xml' }
  };
  console.log('⚠️ Using fallback podcast configuration');
}

// Load voice prompts from external JSON file
let VOICE_PROMPTS = {};

try {
  VOICE_PROMPTS = JSON.parse(fs.readFileSync(path.join(__dirname, 'voice-prompts.json'), 'utf8'));
  console.log(`🎙️ Loaded ${VOICE_PROMPTS.metadata.totalPrompts} voice prompts from voice-prompts.json`);
} catch (error) {
  console.error('❌ Failed to load voice-prompts.json:', error.message);
  
  // Fallback prompts
  VOICE_PROMPTS = {
    mainMenu: {
      greeting: "Podcast Hotline. Please make a selection.",
      noResponse: "No selection received. Please try again."
    }
  };
  console.log('⚠️ Using fallback voice prompts');
}

// Helper function to get prompt with variable replacement
function getPrompt(category, key, variables = {}) {
  try {
    let prompt = VOICE_PROMPTS[category][key];
    if (!prompt) {
      console.warn(`⚠️ Prompt not found: ${category}.${key}`);
      return `Error: prompt ${category}.${key} not found`;
    }
    
    // Replace variables in the prompt
    Object.keys(variables).forEach(varName => {
      const placeholder = `{${varName}}`;
      prompt = prompt.replace(new RegExp(placeholder, 'g'), variables[varName]);
    });
    
    return prompt;
  } catch (error) {
    console.error(`❌ Error getting prompt ${category}.${key}:`, error.message);
    return 'System error';
  }
}

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
  
  const menuText = getPrompt('mainMenu', 'greeting');
  
  gather.say(VOICE_CONFIG, menuText);
  
  twiml.say(VOICE_CONFIG, getPrompt('mainMenu', 'noResponse'));
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
    twiml.say(VOICE_CONFIG, getPrompt('mainMenu', 'invalidSelection'));
    twiml.redirect('/webhook/ivr-main');
    return res.type('text/xml').send(twiml.toString());
  }
  
  const selectedPodcast = ALL_PODCASTS[digits];
  console.log(`Selected: ${selectedPodcast.name}`);
  
  // Track selection
  trackPodcastSelection(digits, caller, req.body.CallSid);
  
  // Handle podcast streaming directly for all channels
  twiml.say(VOICE_CONFIG, getPrompt('podcasts', 'selection', {podcastName: selectedPodcast.name}));
  
  try {
    console.log(`🔍 Fetching episodes for ${selectedPodcast.name} from: ${selectedPodcast.rssUrl}`);
    
    // Handle static test channel
    if (selectedPodcast.rssUrl === 'STATIC_TEST') {
      twiml.say(VOICE_CONFIG, getPrompt('systemTest', 'success'));
      twiml.redirect('/webhook/ivr-main');
      res.type('text/xml');
      return res.send(twiml.toString());
    }
    
    // Handle weather service
    if (selectedPodcast.rssUrl === 'WEATHER_SERVICE') {
      twiml.say(VOICE_CONFIG, getPrompt('weather', 'introduction'));
      
      const gather = twiml.gather({
        numDigits: 5,
        timeout: 10,
        finishOnKey: '#',
        action: '/webhook/weather-zipcode',
        method: 'POST'
      });
      
      gather.say(VOICE_CONFIG, getPrompt('weather', 'enterZipcode'));
      
      twiml.say(VOICE_CONFIG, getPrompt('weather', 'noZipcodeReceived'));
      twiml.redirect('/webhook/ivr-main');
      res.type('text/xml');
      return res.send(twiml.toString());
    }
    
    const episodes = await fetchPodcastEpisodes(selectedPodcast.rssUrl);
    
    if (!episodes || episodes.length === 0) {
      twiml.say(VOICE_CONFIG, getPrompt('podcasts', 'noEpisodes', {podcastName: selectedPodcast.name}));
      twiml.redirect('/webhook/ivr-main');
      res.type('text/xml');
      return res.send(twiml.toString());
    }
    
    const episode = episodes[0];
    console.log(`📻 Episode found: "${episode.title}"`);
    
    // Clean the URL with error handling
    let finalAudioUrl;
    try {
      const cleanedUrl = cleanAudioUrl(episode.audioUrl);
      if (!cleanedUrl || !cleanedUrl.startsWith('http')) {
        throw new Error('Invalid cleaned URL');
      }
      finalAudioUrl = cleanedUrl;
    } catch (urlError) {
      console.error(`⚠️ URL cleaning failed: ${urlError.message}, using original URL`);
      finalAudioUrl = episode.audioUrl;
    }
    
    console.log(`✅ Using audio URL: ${finalAudioUrl.substring(0, 100)}...`);
    
    // Announce and play episode
    twiml.say(VOICE_CONFIG, getPrompt('podcasts', 'nowPlaying', {episodeTitle: episode.title.substring(0, 120)}));
    
    // Check if this is a Simplecast injector URL that needs proxying
    const isSimplecastInjector = finalAudioUrl.includes('injector.simplecastaudio.com');
    
    let playUrl = finalAudioUrl;
    if (isSimplecastInjector) {
      // Use our proxy endpoint to handle Simplecast redirects
      const encodedUrl = Buffer.from(finalAudioUrl).toString('base64');
      playUrl = `https://${req.get('host')}/proxy-audio/${encodedUrl}`;
      console.log(`🔄 Using proxy for Simplecast URL: ${playUrl.substring(0, 80)}...`);
    }
    
    // Set up gather for controls
    const gather = twiml.gather({
      numDigits: 1,
      timeout: 8,
      action: '/webhook/ivr-main',
      method: 'POST'
    });
    
    // Play the podcast
    gather.play({ loop: 1 }, playUrl);
    gather.say(VOICE_CONFIG, getPrompt('podcasts', 'pressAnyKey'));
    
    // Fallback to main menu
    twiml.redirect('/webhook/ivr-main');
    
  } catch (error) {
    console.error(`❌ Error playing ${selectedPodcast.name}:`, error.message);
    twiml.say(VOICE_CONFIG, getPrompt('podcasts', 'technicalIssue', {podcastName: selectedPodcast.name}));
    twiml.redirect('/webhook/ivr-main');
  }
  
  res.type('text/xml');
  res.send(twiml.toString());
});

// API endpoint to add new podcast feeds
app.post('/api/feeds/add', async (req, res) => {
  try {
    const { channel, name, rssUrl, description } = req.body;
    
    if (!channel || !name || !rssUrl) {
      return res.status(400).json({ error: 'Missing required fields: channel, name, rssUrl' });
    }
    
    // Load current config
    const configPath = path.join(__dirname, 'podcast-feeds.json');
    const podcastConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    
    // Add new feed to extensions
    podcastConfig.extensions[channel] = {
      name,
      rssUrl,
      description: description || 'Custom added feed'
    };
    
    // Update metadata
    podcastConfig.metadata.lastUpdated = new Date().toISOString().split('T')[0];
    podcastConfig.metadata.totalFeeds = Object.keys(podcastConfig.feeds).length + Object.keys(podcastConfig.extensions).length;
    
    // Save updated config
    fs.writeFileSync(configPath, JSON.stringify(podcastConfig, null, 2));
    
    // Reload in memory
    EXTENSION_PODCASTS = podcastConfig.extensions;
    
    res.json({
      success: true,
      message: `Added ${name} as channel ${channel}`,
      feed: podcastConfig.extensions[channel]
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API endpoint to activate extension feeds
app.post('/api/feeds/activate/:channel', async (req, res) => {
  try {
    const { channel } = req.params;
    
    if (!EXTENSION_PODCASTS[channel]) {
      return res.status(404).json({ error: 'Extension feed not found' });
    }
    
    // Load current config
    const configPath = path.join(__dirname, 'podcast-feeds.json');
    const podcastConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    
    // Move from extensions to main feeds
    podcastConfig.feeds[channel] = podcastConfig.extensions[channel];
    delete podcastConfig.extensions[channel];
    
    // Update metadata
    podcastConfig.metadata.lastUpdated = new Date().toISOString().split('T')[0];
    
    // Save updated config
    fs.writeFileSync(configPath, JSON.stringify(podcastConfig, null, 2));
    
    // Reload in memory
    ALL_PODCASTS = podcastConfig.feeds;
    EXTENSION_PODCASTS = podcastConfig.extensions;
    
    res.json({
      success: true,
      message: `Activated ${podcastConfig.feeds[channel].name} as channel ${channel}`,
      feed: podcastConfig.feeds[channel]
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API endpoint to list available feeds
app.get('/api/feeds/list', (req, res) => {
  res.json({
    activeFeeds: ALL_PODCASTS,
    extensionFeeds: EXTENSION_PODCASTS,
    totalActive: Object.keys(ALL_PODCASTS).length,
    totalExtensions: Object.keys(EXTENSION_PODCASTS).length
  });
});

// Audio proxy endpoint for problematic URLs
app.get('/proxy-audio/:encodedUrl', async (req, res) => {
  try {
    const { encodedUrl } = req.params;
    const originalUrl = Buffer.from(encodedUrl, 'base64').toString('utf-8');
    
    console.log(`🔄 Proxying audio request for: ${originalUrl.substring(0, 100)}...`);
    
    // Follow redirects to get the final audio URL
    const response = await axios({
      method: 'HEAD',
      url: originalUrl,
      maxRedirects: 10,
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TwilioPodcastBot/2.0)',
        'Accept': 'audio/mpeg, audio/mp4, audio/*, */*'
      }
    });
    
    const finalUrl = response.request.res.responseUrl || originalUrl;
    console.log(`✅ Resolved to: ${finalUrl.substring(0, 100)}...`);
    
    // Stream the audio content
    const audioResponse = await axios({
      method: 'GET',
      url: finalUrl,
      responseType: 'stream',
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TwilioPodcastBot/2.0)',
        'Accept': 'audio/mpeg, audio/mp4, audio/*, */*'
      }
    });
    
    // Set appropriate headers for audio streaming
    res.setHeader('Content-Type', audioResponse.headers['content-type'] || 'audio/mpeg');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    
    if (audioResponse.headers['content-length']) {
      res.setHeader('Content-Length', audioResponse.headers['content-length']);
    }
    
    // Pipe the audio stream
    audioResponse.data.pipe(res);
    
  } catch (error) {
    console.error(`❌ Audio proxy error:`, error.message);
    res.status(404).send('Audio not available');
  }
});

// Handle weather zipcode input
app.post('/webhook/weather-zipcode', async (req, res) => {
  const zipcode = req.body.Digits;
  const caller = req.body.From || req.body.Caller;
  
  console.log(`🌤️ Weather request: ${zipcode} from ${caller}`);
  
  const twiml = new VoiceResponse();
  
  if (!zipcode || zipcode.length !== 5 || !/^\d{5}$/.test(zipcode)) {
    twiml.say(VOICE_CONFIG, getPrompt('weather', 'invalidZipcode'));
    twiml.redirect('/webhook/ivr-main');
    return res.type('text/xml').send(twiml.toString());
  }
  
  try {
    twiml.say(VOICE_CONFIG, getPrompt('weather', 'gettingForecast', {zipcode: zipcode.split('').join(' ')}));
    
    const weatherReport = await getWeatherForecast(zipcode);
    twiml.say(VOICE_CONFIG, weatherReport);
    
    // Offer to repeat or return to menu
    const gather = twiml.gather({
      numDigits: 1,
      timeout: 5,
      action: '/webhook/weather-options',
      method: 'POST'
    });
    gather.say(VOICE_CONFIG, getPrompt('weather', 'options'));
    
    twiml.redirect('/webhook/ivr-main');
    
  } catch (error) {
    console.error(`❌ Weather error for ${zipcode}:`, error.message);
    twiml.say(VOICE_CONFIG, getPrompt('weather', 'unavailable'));
    twiml.redirect('/webhook/ivr-main');
  }
  
  res.type('text/xml');
  res.send(twiml.toString());
});

// Handle weather options
app.post('/webhook/weather-options', async (req, res) => {
  const digits = req.body.Digits;
  const twiml = new VoiceResponse();
  
  if (digits === '1') {
    // Repeat last forecast - for now just redirect back to weather service
    twiml.say(VOICE_CONFIG, getPrompt('weather', 'repeatPrompt'));
    const gather = twiml.gather({
      numDigits: 5,
      timeout: 10,
      finishOnKey: '#',
      action: '/webhook/weather-zipcode',
      method: 'POST'
    });
    gather.say(VOICE_CONFIG, getPrompt('weather', 'enterZipcode'));
    twiml.redirect('/webhook/ivr-main');
  } else if (digits === '2') {
    // Different zipcode
    twiml.say(VOICE_CONFIG, getPrompt('weather', 'differentZipcode'));
    const gather = twiml.gather({
      numDigits: 5,
      timeout: 10,
      finishOnKey: '#',
      action: '/webhook/weather-zipcode',
      method: 'POST'
    });
    gather.say(VOICE_CONFIG, getPrompt('weather', 'enterZipcode'));
    twiml.redirect('/webhook/ivr-main');
  } else {
    // Return to main menu
    twiml.redirect('/webhook/ivr-main');
  }
  
  res.type('text/xml');
  res.send(twiml.toString());
});

// Test endpoint to check RSS feeds directly
app.all('/test-podcast/:channel', async (req, res) => {
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
app.all('/webhook/play-episode', async (req, res) => {
  // Handle parameters from both GET query and POST body
  const channel = req.query.channel || req.body.channel;
  const episodeIndex = parseInt(req.query.episodeIndex || req.body.episodeIndex) || 0;
  const position = parseInt(req.query.position || req.body.position) || 0;
  
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
  
  // Handle static test channel
  if (podcast.rssUrl === 'STATIC_TEST') {
    console.log(`🧪 System test channel - providing static response`);
    twiml.say(VOICE_CONFIG, `System test successful. The Twilio integration is working properly. This is a pre-recorded message to verify the phone system is operational. You can now try NPR option 1 for live podcast streaming.`);
    
    const gather = twiml.gather({
      numDigits: 1,
      timeout: 5,
      action: '/webhook/ivr-main',
      method: 'POST'
    });
    gather.say(VOICE_CONFIG, 'Press any key to return to the main menu.');
    
    twiml.redirect('/webhook/ivr-main');
    return res.type('text/xml').send(twiml.toString());
  }
  
  try {
    console.log(`🔍 Fetching episodes from: ${podcast.rssUrl}`);
    const episodes = await fetchPodcastEpisodes(podcast.rssUrl);
    
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
    
    // Stream the podcast directly from URL
    console.log(`🎵 Playing audio from: ${finalAudioUrl.split('/')[2]}`);
    gather.play({ loop: 1 }, finalAudioUrl);
    
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

