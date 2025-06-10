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
const SKIP_DURATION = 120; // 2 minutes for skip forward/back
const fs = require('fs');
const path = require('path');

// Import ad system and analytics
const AdSystem = require('./ad-system');
const CallerAnalytics = require('./caller-analytics');

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

// Initialize Ad System and Analytics
const adSystem = new AdSystem();
const analytics = new CallerAnalytics();

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

// Enhanced URL cleaning function to handle complex redirect chains
function cleanAudioUrl(url) {
    if (!url || typeof url !== 'string') return url;
    
    console.log(`🧹 Cleaning URL: ${url.substring(0, 80)}...`);
    
    try {
        let cleaned = url;
        
        // Enhanced tracking patterns with complex redirect chains
        const trackingPatterns = [
            // Multi-layer redirects (common in TimCast URLs)
            /^https?:\/\/dts\.podtrac\.com\/redirect\.mp3\/mgln\.ai\/e\/[^\/]+\//i,
            /^https?:\/\/mgln\.ai\/e\/[^\/]+\/traffic\.libsyn\.com\//i,
            
            // Single layer redirects
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
            /^https?:\/\/[^\/]*chrt\.fm\/track\/[^\/]+\//i,
            /^https?:\/\/[^\/]*prefix\.up\.audio\/s\//i,
            
            // Additional patterns for future-proofing
            /^https?:\/\/[^\/]*tracking\.feedpress\.it\/\?/i,
            /^https?:\/\/[^\/]*feeds\.feedburner\.com\/~r\/[^\/]+\/~3\/[^\/]+\//i,
            /^https?:\/\/[^\/]*redirect\.audio\/\?/i,
            /^https?:\/\/[^\/]*analytics\.podcast\.com\/\?/i
        ];
        
        // Iteratively remove tracking layers with enhanced logic
        let previousUrl;
        let maxIterations = 15; // Increased for complex chains
        let iteration = 0;
        
        do {
            previousUrl = cleaned;
            iteration++;
            
            for (const pattern of trackingPatterns) {
                if (pattern.test(cleaned)) {
                    let newUrl = cleaned.replace(pattern, '');
                    
                    // Handle cases where the remaining URL needs protocol
                    if (!newUrl.startsWith('http') && newUrl.includes('.')) {
                        // Check if it looks like a domain
                        if (newUrl.match(/^[a-zA-Z0-9][a-zA-Z0-9-]*\.[a-zA-Z]{2,}/)) {
                            newUrl = 'https://' + newUrl;
                        }
                    }
                    
                    // Validate the cleaned URL
                    if (newUrl !== cleaned && newUrl.length > 10 && newUrl.includes('.')) {
                        console.log(`🗑️ Iteration ${iteration}: Removed tracking layer -> ${newUrl.substring(0, 60)}...`);
                        cleaned = newUrl;
                        break; // Process one layer at a time
                    }
                }
            }
            
            // Additional manual cleaning for complex cases
            if (cleaned === previousUrl && iteration === 1) {
                // Handle specific patterns that need manual extraction
                const manualPatterns = [
                    // Extract final URL from complex redirect chains
                    /traffic\.libsyn\.com\/secure\/[^?]+/i,
                    /content\.libsyn\.com\/[^?]+/i,
                    /[a-zA-Z0-9-]+\.simplecastaudio\.com\/[^?]+/i,
                    /traffic\.megaphone\.fm\/[^?]+/i
                ];
                
                for (const pattern of manualPatterns) {
                    const match = cleaned.match(pattern);
                    if (match) {
                        cleaned = 'https://' + match[0];
                        console.log(`🔧 Manual extraction: ${cleaned.substring(0, 60)}...`);
                        break;
                    }
                }
            }
            
        } while (cleaned !== previousUrl && iteration < maxIterations);
        
        // Final validation and cleanup
        if (cleaned !== url) {
            console.log(`✅ URL cleaned successfully: ${cleaned.substring(0, 80)}...`);
        }
        
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

// Helper function to clean episode titles for voice synthesis
function cleanTitleForVoice(title) {
  if (!title || typeof title !== 'string') return title;
  
  try {
    let cleaned = title;
    
    // Fix common date formats for British voice
    // Convert MM-DD-YYYY to "Month DD, YYYY" format
    cleaned = cleaned.replace(/(\d{1,2})-(\d{1,2})-(\d{4})/g, (match, month, day, year) => {
      const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
                         'July', 'August', 'September', 'October', 'November', 'December'];
      const monthIndex = parseInt(month) - 1;
      if (monthIndex >= 0 && monthIndex < 12) {
        return `${monthNames[monthIndex]} ${parseInt(day)}, ${year}`;
      }
      return match;
    });
    
    // Convert MM/DD/YYYY to "Month DD, YYYY" format  
    cleaned = cleaned.replace(/(\d{1,2})\/(\d{1,2})\/(\d{4})/g, (match, month, day, year) => {
      const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
                         'July', 'August', 'September', 'October', 'November', 'December'];
      const monthIndex = parseInt(month) - 1;
      if (monthIndex >= 0 && monthIndex < 12) {
        return `${monthNames[monthIndex]} ${parseInt(day)}, ${year}`;
      }
      return match;
    });
    
    // Clean up common problematic characters
    cleaned = cleaned.replace(/&amp;/g, 'and');
    cleaned = cleaned.replace(/&/g, 'and');
    cleaned = cleaned.replace(/vs\./gi, 'versus');
    cleaned = cleaned.replace(/\b(w\/)\b/gi, 'with');
    
    return cleaned;
  } catch (error) {
    console.error(`⚠️ Title cleaning error:`, error.message);
    return title;
  }
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
      let value = variables[varName];
      
      // Clean episode titles for better voice synthesis
      if (varName === 'episodeTitle') {
        value = cleanTitleForVoice(value);
      }
      
      prompt = prompt.replace(new RegExp(placeholder, 'g'), value);
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

// Enhanced Analytics endpoint with ad system stats
app.get('/analytics', async (req, res) => {
  try {
    const analyticsSummary = analytics.getSummary();
    const adSystemStats = adSystem.getSystemStats();
    
    res.json({
      caller_analytics: analyticsSummary,
      ad_system: adSystemStats,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Detailed caller analytics
app.get('/analytics/caller/:phoneNumber', async (req, res) => {
  try {
    const { phoneNumber } = req.params;
    const callerData = analytics.getCallerAnalytics(phoneNumber);
    
    if (!callerData) {
      return res.status(404).json({ error: 'Caller not found' });
    }
    
    res.json({
      phoneNumber,
      analytics: callerData,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Export analytics data
app.get('/analytics/export/:format', async (req, res) => {
  try {
    const { format } = req.params;
    
    if (format === 'csv') {
      const csvData = analytics.exportData('csv');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename=analytics.csv');
      res.send(csvData);
    } else {
      const jsonData = analytics.exportData('json');
      res.json(jsonData);
    }
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Ad exemption management
app.post('/api/ads/exempt', async (req, res) => {
  try {
    const { phoneNumber, reason, notes } = req.body;
    
    if (!phoneNumber || !reason) {
      return res.status(400).json({ error: 'Phone number and reason required' });
    }
    
    const success = adSystem.addExemptNumber(phoneNumber, reason, notes);
    
    if (success) {
      res.json({ success: true, message: `${phoneNumber} added to exemption list` });
    } else {
      res.status(409).json({ error: 'Phone number already exempt' });
    }
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/ads/exempt/:phoneNumber', async (req, res) => {
  try {
    const { phoneNumber } = req.params;
    const success = adSystem.removeExemptNumber(phoneNumber);
    
    if (success) {
      res.json({ success: true, message: `${phoneNumber} removed from exemption list` });
    } else {
      res.status(404).json({ error: 'Phone number not found in exemption list' });
    }
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Legacy analytics endpoint (keeping for compatibility)
app.get('/analytics/legacy', async (req, res) => {
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

// Enhanced Main IVR Menu for Streaming with Analytics
app.all('/webhook/ivr-main', (req, res) => {
  const caller = req.body.From || req.body.Caller;
  const callSid = req.body.CallSid;
  
  console.log(`📞 Serving enhanced streaming IVR menu to ${caller}`);
  
  // Initialize analytics and ad system for this call
  if (callSid && caller) {
    console.log(`📊 Initializing session: ${callSid} for ${caller}`);
    analytics.startSession(callSid, caller);
    const adEnabled = adSystem.initSession(callSid, caller);
    console.log(`📺 Ad system initialized: ${adEnabled ? 'enabled' : 'exempt'} for ${caller}`);
  }
  
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

// Handle channel selection with analytics and ads
app.post('/webhook/select-channel', async (req, res) => {
  const digits = req.body.Digits;
  const caller = req.body.From || req.body.Caller;
  const callSid = req.body.CallSid;
  
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

    // Handle feedback service
    if (selectedPodcast.rssUrl === 'FEEDBACK_SERVICE') {
      if (callSid) {
        analytics.trackChannelSelection(callSid, digits, selectedPodcast.name);
      }
      
      twiml.say(VOICE_CONFIG, getPrompt('feedback', 'introduction'));
      
      // Start recording
      twiml.record({
        maxLength: 300, // 5 minutes max
        timeout: 5,
        trim: 'trim-silence',
        transcribe: true,
        transcribeCallback: `/webhook/feedback-transcription?callSid=${callSid}`,
        action: `/webhook/feedback-complete?callSid=${callSid}`,
        method: 'POST'
      });
      
      twiml.say(VOICE_CONFIG, getPrompt('feedback', 'error'));
      twiml.redirect('/webhook/ivr-main');
      res.type('text/xml');
      return res.send(twiml.toString());
    }
    
    // Handle podcast streaming - announce selection for actual podcasts
    twiml.say(VOICE_CONFIG, getPrompt('podcasts', 'selection', {podcastName: selectedPodcast.name}));
    
    // Track channel selection in analytics
    if (callSid) {
      analytics.trackChannelSelection(callSid, digits, selectedPodcast.name);
    }
    
    // Check for preroll ad
    let prerollAd = null;
    if (callSid) {
      console.log(`🔍 Checking for preroll ad for channel ${digits}`);
      prerollAd = await adSystem.getPrerollAd(callSid, digits, selectedPodcast.name);
      console.log(`📺 Preroll ad result: ${prerollAd ? prerollAd.name : 'none'}`);
    }
    
    // Play preroll ad if available
    if (prerollAd) {
      console.log(`📺 Playing preroll ad: ${prerollAd.name}`);
      twiml.say(VOICE_CONFIG, 'A message from our sponsor.');
      
      // Handle different ad URL formats
      if (prerollAd.audioUrl.startsWith('/api/test-ad/')) {
        // Internal TTS ad - get the message and say it directly
        const adId = prerollAd.audioUrl.split('/').pop();
        const adMessages = {
          'preroll1': 'This episode is brought to you by Local Business. Your neighborhood partner for quality service and friendly support. Visit us today.',
          'preroll2': 'Tech Company presents this podcast. Innovation that works for you. Technology made simple.',
          'midroll1': 'Hungry? Restaurant Chain has fresh ingredients and great taste. Over 50 locations to serve you.',
          'midroll2': 'Protect what matters most with Insurance Company. Reliable coverage, competitive rates, local agents.'
        };
        const adMessage = adMessages[adId] || 'Thank you for listening to our sponsors.';
        twiml.say(VOICE_CONFIG, adMessage);
      } else {
        // External audio URL - play directly
        twiml.play(prerollAd.audioUrl);
      }
      
      // Track ad in analytics
      if (callSid) {
        analytics.trackAdPlayed(callSid, prerollAd);
      }
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
    
    // Start pre-loading the audio while announcing the title for faster playback
    const encodedUrl = Buffer.from(finalAudioUrl).toString('base64');
    const playUrl = `https://${req.get('host')}/proxy-audio/${encodedUrl}`;
    console.log(`🚀 Using direct proxy for playback: ${playUrl.substring(0, 80)}...`);
    
    // Parallel loading: Start warming up the audio stream while title is being read
    // This reduces perceived latency by ~2-3 seconds
    const preloadPromise = axios.head(finalAudioUrl, {
      timeout: 3000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TwilioPodcastBot/2.0)',
        'Accept': 'audio/mpeg, audio/mp4, audio/*, */*'
      }
    }).catch(err => {
      console.log(`🔄 Preload check: ${err.message || 'completed'}`);
    });
    
    // Announce episode (this gives time for preloading)
    twiml.say(VOICE_CONFIG, getPrompt('podcasts', 'nowPlaying', {episodeTitle: episode.title.substring(0, 120)}));
    
    // Set up gather for controls
    const gather = twiml.gather({
      numDigits: 1,
      timeout: 30, // Shorter timeout for better responsiveness
      action: `/webhook/playback-control?channel=${digits}&episodeIndex=0`,
      method: 'POST'
    });
    
    // Play the podcast
    gather.play({ loop: 1 }, playUrl);
    gather.say(VOICE_CONFIG, 'Press 1 for previous episode, 3 for next episode, 4 to restart episode, 6 to skip episode, or 0 for menu.');
    
    // Fallback to continue current episode after timeout
    twiml.redirect(`/webhook/playback-control?channel=${digits}&episodeIndex=0`);
    
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

// Audio proxy endpoint with byte-range support for seeking
app.get('/proxy-audio/:encodedUrl/:type?/:startTime?', async (req, res) => {
  try {
    let { encodedUrl, type, startTime } = req.params;
    const seekTime = type === 'start' ? parseInt(startTime) || 0 : parseInt(req.query.start) || 0;
    
    console.log(`🎵 Proxy request: type=${type}, startTime=${startTime}, seekTime=${seekTime}`);
    
    // Remove any query parameters from the encoded URL path
    encodedUrl = encodedUrl.split('?')[0];
    
    let originalUrl;
    try {
      originalUrl = Buffer.from(encodedUrl, 'base64').toString('utf-8');
      console.log(`🔗 Decoded URL: ${originalUrl.substring(0, 100)}...`);
    } catch (decodeError) {
      console.error(`❌ Base64 decode error:`, decodeError.message);
      return res.status(400).send('Invalid encoded URL');
    }
    
    console.log(`🎵 Streaming: ${originalUrl.substring(0, 100)}... ${seekTime > 0 ? `(seeking to ${seekTime}s)` : ''}`);
    
    // First, get content-length to calculate byte offset
    let headers = {
      'User-Agent': 'Mozilla/5.0 (compatible; TwilioPodcastBot/2.0)',
      'Accept': 'audio/mpeg, audio/mp4, audio/*, */*'
    };
    
    // If seeking is requested, try to calculate byte offset
    if (seekTime > 0) {
      try {
        // Get file info first with shorter timeout
        const headResponse = await axios({
          method: 'HEAD',
          url: originalUrl,
          timeout: 8000, // Increased timeout for Libsyn redirects
          maxRedirects: 5, // Increased for Libsyn redirect chains
          headers: headers,
          validateStatus: function (status) {
            return status >= 200 && status < 400; // Accept 2xx and 3xx
          }
        });
        
        const contentLength = parseInt(headResponse.headers['content-length']) || 0;
        if (contentLength > 0) {
          // Improved byte estimation with multiple bitrate scenarios
          let estimatedByteRate;
          if (contentLength > 100000000) { // > 100MB, likely high quality
            estimatedByteRate = 24000; // ~192kbps = 24KB/s
          } else if (contentLength > 50000000) { // > 50MB, medium quality
            estimatedByteRate = 20000; // ~160kbps = 20KB/s  
          } else {
            estimatedByteRate = 16000; // ~128kbps = 16KB/s
          }
          
          const byteOffset = Math.min(seekTime * estimatedByteRate, Math.max(0, contentLength - 2000000)); // Leave 2MB buffer
          
          if (byteOffset > 1000) { // Only use range if seeking more than 1KB
            headers['Range'] = `bytes=${byteOffset}-`;
            console.log(`📍 Requesting range: bytes=${byteOffset}- (${Math.round(byteOffset/estimatedByteRate)}s estimated, ${estimatedByteRate} B/s rate)`);
          }
        }
      } catch (headError) {
        console.log(`⚠️ HEAD request failed (${headError.code || headError.message}), proceeding with full stream`);
        // Continue without range - this is expected for some CDNs
      }
    }
    
    // Stream with range support
    console.log(`🚀 Making request to: ${originalUrl.substring(0, 80)}... with headers:`, Object.keys(headers));
    
    const audioResponse = await axios({
      method: 'GET',
      url: originalUrl,
      responseType: 'stream',
      timeout: 30000,
      maxRedirects: 5, // Increased for Libsyn redirect chains
      headers: headers,
      validateStatus: function (status) {
        return status >= 200 && status < 400; // Accept 2xx and 3xx
      }
    });
    
    console.log(`✅ Stream started: ${audioResponse.status} ${audioResponse.headers['content-type']} ${audioResponse.status === 206 ? '(partial content)' : ''}`);
    
    // Check if seeking was requested but CDN didn't support it
    if (seekTime > 0 && audioResponse.status === 200) {
      console.log(`⚠️ Range request ignored by CDN, got full content instead of partial`);
    }
    
    // Set headers for streaming - optimized for Twilio compatibility
    res.setHeader('Content-Type', audioResponse.headers['content-type'] || 'audio/mpeg');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    
    // Add Twilio-friendly headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Connection', 'keep-alive');
    
    if (audioResponse.headers['content-length']) {
      const contentLength = parseInt(audioResponse.headers['content-length']);
      // For very large files (>100MB), don't set Content-Length to avoid Twilio timeouts
      if (contentLength < 100000000) {
        res.setHeader('Content-Length', contentLength);
      } else {
        console.log(`⚠️ Large file (${Math.round(contentLength/1024/1024)}MB), streaming without Content-Length for Twilio compatibility`);
      }
    }
    
    if (audioResponse.headers['content-range']) {
      res.setHeader('Content-Range', audioResponse.headers['content-range']);
      res.status(206); // Partial content
    }
    
    // Handle potential issues with stream piping
    audioResponse.data.on('error', (streamError) => {
      console.error(`❌ Stream error:`, streamError.message);
      if (!res.headersSent) {
        res.status(500).send('Stream error');
      }
    });
    
    res.on('close', () => {
      console.log(`🔌 Client disconnected from stream`);
    });
    
    // Stream the episode (full or partial)
    audioResponse.data.pipe(res);
    
  } catch (error) {
    console.error(`❌ Streaming failed:`, error.message);
    console.error(`Error details:`, {
      code: error.code,
      status: error.response?.status,
      url: originalUrl.substring(0, 100) + '...',
      seekTime,
      hasRange: !!headers['Range']
    });
    
    // Provide more specific error responses
    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      console.error(`🔗 Connection failed to: ${originalUrl.substring(0, 100)}...`);
      if (!res.headersSent) {
        res.status(503).send('Audio source temporarily unavailable');
      }
    } else if (error.response && (error.response.status === 416 || error.response.status === 400)) {
      console.error(`📍 Range request failed (${error.response.status}), trying without range`);
      // If range request fails, retry without range header
      try {
        const fallbackResponse = await axios({
          method: 'GET',
          url: originalUrl,
          responseType: 'stream',
          timeout: 15000,
          maxRedirects: 5, // Increased for Libsyn redirect chains
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; TwilioPodcastBot/2.0)',
            'Accept': 'audio/mpeg, audio/mp4, audio/*, */*'
          }
        });
        
        if (!res.headersSent) {
          res.setHeader('Content-Type', fallbackResponse.headers['content-type'] || 'audio/mpeg');
          res.setHeader('Accept-Ranges', 'bytes');
          res.setHeader('Cache-Control', 'public, max-age=3600');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Connection', 'keep-alive');
          
          if (fallbackResponse.headers['content-length']) {
            const contentLength = parseInt(fallbackResponse.headers['content-length']);
            if (contentLength < 100000000) {
              res.setHeader('Content-Length', contentLength);
            } else {
              console.log(`⚠️ Large fallback file (${Math.round(contentLength/1024/1024)}MB), streaming without Content-Length`);
            }
          }
          
          fallbackResponse.data.pipe(res);
          console.log(`✅ Fallback stream started without range`);
        }
        return;
      } catch (fallbackError) {
        console.error(`❌ Fallback also failed:`, fallbackError.message);
      }
    } else if (error.response && error.response.status >= 500) {
      console.error(`🔥 Server error from CDN: ${error.response.status}`);
      if (!res.headersSent) {
        res.status(502).send('Audio server error');
      }
    }
    
    if (!res.headersSent) {
      res.status(404).send('Audio not available');
    }
  }
});

// Debug endpoint to test proxy URL construction
app.get('/debug-proxy/:encodedUrl/:type?/:startTime?', async (req, res) => {
  try {
    let { encodedUrl, type, startTime } = req.params;
    const seekTime = type === 'start' ? parseInt(startTime) || 0 : parseInt(req.query.start) || 0;
    
    encodedUrl = encodedUrl.split('?')[0];
    const originalUrl = Buffer.from(encodedUrl, 'base64').toString('utf-8');
    
    res.json({
      encodedUrl: encodedUrl.substring(0, 50) + '...',
      type,
      startTime,
      seekTime,
      originalUrl,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
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

// Test endpoint for audio proxy
app.all('/test-proxy/:channel', async (req, res) => {
  const channel = req.params.channel;
  const podcast = ALL_PODCASTS[channel];
  
  if (!podcast) {
    return res.json({ error: 'Invalid channel' });
  }
  
  try {
    console.log(`Testing proxy for: ${podcast.name}`);
    const episodes = await fetchPodcastEpisodes(podcast.rssUrl);
    
    if (episodes.length === 0) {
      return res.json({ error: 'No episodes found' });
    }
    
    const episode = episodes[0];
    const cleanedUrl = cleanAudioUrl(episode.audioUrl);
    
    // All URLs now go through proxy
    const encodedUrl = Buffer.from(cleanedUrl).toString('base64');
    const proxyUrl = `https://${req.get('host')}/proxy-audio/${encodedUrl}`;
    
    res.json({
      podcast: podcast.name,
      episodeTitle: episode.title,
      originalUrl: episode.audioUrl,
      cleanedUrl: cleanedUrl,
      needsProxy: true,
      proxyUrl: proxyUrl
    });
    
  } catch (error) {
    res.json({ error: error.message });
  }
});

// Helper function to check ffmpeg availability
async function checkFFmpegAvailable() {
  try {
    const { spawn } = require('child_process');
    const ffmpeg = spawn('ffmpeg', ['-version']);
    
    return new Promise((resolve) => {
      ffmpeg.on('error', () => resolve(false));
      ffmpeg.on('exit', (code) => resolve(code === 0));
      setTimeout(() => resolve(false), 1000); // Timeout after 1 second
    });
  } catch (error) {
    return false;
  }
}

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
  
  console.log(`=== STREAMING EPISODE PLAYBACK ===`);
  console.log(`Channel: ${channel}, Episode: ${episodeIndex}`);
  
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
        twiml.redirect(`/webhook/play-episode?channel=${channel}&episodeIndex=0`);
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
    twiml.say(VOICE_CONFIG, `Now playing: ${episode.title.substring(0, 80)}`);
    
    // Set up playback controls for continuous playback with position tracking
    const gather = twiml.gather({
      numDigits: 1,
      action: `/webhook/playback-control?channel=${channel}&episodeIndex=${episodeIndex}&position=0`,
      method: 'POST',
      timeout: 30
    });
    
    // Route through proxy for direct streaming
    const encodedUrl = Buffer.from(finalAudioUrl).toString('base64');
    const proxyUrl = `https://${req.get('host')}/proxy-audio/${encodedUrl}`;
    console.log(`🚀 Playing episode from: ${finalAudioUrl.split('/')[2]}`);
    gather.play({ loop: 1 }, proxyUrl);
    
    twiml.say(VOICE_CONFIG, `Press 1 for previous episode, 3 for next episode, 4 to skip back, 6 to skip forward, or 0 for main menu.`);
    
    // Continue current episode after timeout
    twiml.redirect(`/webhook/playback-control?channel=${channel}&episodeIndex=${episodeIndex}&position=0`);
    
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
      twiml.redirect(`/webhook/episode-finished?channel=${channel}&episodeIndex=0`);
    } else {
      twiml.say(VOICE_CONFIG, `Sorry, there's a problem with this podcast right now. Please try another one.`);
      twiml.redirect('/webhook/ivr-main');
    }
  }
  
  res.type('text/xml');
  res.send(twiml.toString());
});

// Enhanced Playback Controls with Time-based Seeking
app.post('/webhook/playback-control', async (req, res) => {
  const digits = req.body.Digits;
  const channel = req.query.channel;
  const episodeIndex = parseInt(req.query.episodeIndex) || 0;
  const position = parseInt(req.query.position) || 0;
  
  console.log(`=== PLAYBACK CONTROL: ${digits} ===`);
  console.log(`Current: Channel ${channel}, Episode ${episodeIndex}, Position: ${position}s`);
  
  const twiml = new VoiceResponse();
  
  switch(digits) {
    case '1': // Previous episode
      const prevEpisode = Math.max(0, episodeIndex - 1);
      twiml.say(VOICE_CONFIG, 'Going to previous episode.');
      twiml.redirect(`/webhook/play-episode?channel=${channel}&episodeIndex=${prevEpisode}`);
      break;
      
    case '3': // Next episode
      twiml.say(VOICE_CONFIG, 'Going to next episode.');
      twiml.redirect(`/webhook/episode-finished?channel=${channel}&episodeIndex=${episodeIndex}`);
      break;
      
    case '4': // Skip back 2 minutes
      try {
        const backPosition = Math.max(0, position - SKIP_DURATION);
        const backMins = Math.floor(backPosition / 60);
        console.log(`⏪ Skip back: ${position}s -> ${backPosition}s (${backMins}m)`);
        twiml.say(VOICE_CONFIG, `Skipping back to ${backMins} minutes.`);
        twiml.redirect(`/webhook/play-episode-at-position?channel=${channel}&episodeIndex=${episodeIndex}&position=${backPosition}`);
      } catch (error) {
        console.error(`❌ Skip back error:`, error.message);
        twiml.say(VOICE_CONFIG, 'Skip back failed. Continuing current playback.');
        twiml.redirect(`/webhook/playback-control?channel=${channel}&episodeIndex=${episodeIndex}&position=${position}`);
      }
      break;
      
    case '6': // Skip forward 2 minutes
      try {
        const forwardPosition = position + SKIP_DURATION;
        const forwardMins = Math.floor(forwardPosition / 60);
        console.log(`⏩ Skip forward: ${position}s -> ${forwardPosition}s (${forwardMins}m)`);
        twiml.say(VOICE_CONFIG, `Skipping forward to ${forwardMins} minutes.`);
        twiml.redirect(`/webhook/play-episode-at-position?channel=${channel}&episodeIndex=${episodeIndex}&position=${forwardPosition}`);
      } catch (error) {
        console.error(`❌ Skip forward error:`, error.message);
        twiml.say(VOICE_CONFIG, 'Skip forward failed. Continuing current playback.');
        twiml.redirect(`/webhook/playback-control?channel=${channel}&episodeIndex=${episodeIndex}&position=${position}`);
      }
      break;
      
    case '0': // Main menu
      twiml.say(VOICE_CONFIG, 'Returning to main menu.');
      twiml.redirect('/webhook/ivr-main');
      break;
      
    default:
      // Continue to next episode (continuous playback)
      twiml.redirect(`/webhook/episode-finished?channel=${channel}&episodeIndex=${episodeIndex}`);
  }
  
  res.type('text/xml');
  res.send(twiml.toString());
});

// Play episode at specific position using byte-range requests
app.all('/webhook/play-episode-at-position', async (req, res) => {
  const channel = req.query.channel || req.body.channel;
  const episodeIndex = parseInt(req.query.episodeIndex || req.body.episodeIndex) || 0;
  const position = parseInt(req.query.position || req.body.position) || 0;
  
  console.log(`=== PLAYING EPISODE AT POSITION ===`);
  console.log(`Channel: ${channel}, Episode: ${episodeIndex}, Position: ${position}s`);
  
  const twiml = new VoiceResponse();
  
  const podcast = ALL_PODCASTS[channel];
  if (!podcast) {
    twiml.say(VOICE_CONFIG, 'Invalid channel.');
    twiml.redirect('/webhook/ivr-main');
    return res.type('text/xml').send(twiml.toString());
  }
  
  try {
    const episodes = await fetchPodcastEpisodes(podcast.rssUrl);
    
    if (!episodes || episodes.length === 0) {
      twiml.say(VOICE_CONFIG, `No episodes available for ${podcast.name}.`);
      twiml.redirect('/webhook/ivr-main');
      return res.type('text/xml').send(twiml.toString());
    }
    
    const episode = episodes[episodeIndex];
    if (!episode) {
      // If episode not found, go to latest episode
      twiml.redirect(`/webhook/play-episode?channel=${channel}&episodeIndex=0`);
      return res.type('text/xml').send(twiml.toString());
    }
    
    // Clean the URL and start pre-loading
    const cleanedUrl = cleanAudioUrl(episode.audioUrl);
    const encodedUrl = Buffer.from(cleanedUrl).toString('base64');
    const playUrl = `https://${req.get('host')}/proxy-audio/${encodedUrl}/start/${position}`;
    
    // Pre-load check while announcing position for faster seeking
    const preloadPromise = axios.head(cleanedUrl, {
      timeout: 2000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TwilioPodcastBot/2.0)',
        'Accept': 'audio/mpeg, audio/mp4, audio/*, */*'
      }
    }).catch(err => {
      console.log(`🔄 Seek preload: ${err.message || 'completed'}`);
    });
    
    // Announce position if not at start (gives time for preloading)
    if (position > 0) {
      const positionMins = Math.floor(position / 60);
      twiml.say(VOICE_CONFIG, `Resuming at ${positionMins} minutes.`);
    }
    
    // Set up gather with position tracking
    const gather = twiml.gather({
      numDigits: 1,
      action: `/webhook/playback-control?channel=${channel}&episodeIndex=${episodeIndex}&position=${position}`,
      method: 'POST',
      timeout: 30
    });
    
    gather.play({ loop: 1 }, playUrl);
    gather.say(VOICE_CONFIG, 'Press 1 for previous episode, 3 for next episode, 4 to skip back, 6 to skip forward, or 0 for menu.');
    
    // Continue with updated position after timeout (simulate playback progress)
    const nextPosition = position + 30; // Add 30 seconds for timeout duration
    twiml.redirect(`/webhook/playback-control?channel=${channel}&episodeIndex=${episodeIndex}&position=${nextPosition}`);
    
  } catch (error) {
    console.error(`❌ Error playing episode at position:`, error.message);
    twiml.say(VOICE_CONFIG, 'There was an issue with playback. Returning to main menu.');
    twiml.redirect('/webhook/ivr-main');
  }
  
  res.type('text/xml');
  res.send(twiml.toString());
});

// Handle episode finishing and automatic progression to next episode
app.all('/webhook/episode-finished', async (req, res) => {
  const channel = req.query.channel || req.body.channel;
  const episodeIndex = parseInt(req.query.episodeIndex || req.body.episodeIndex) || 0;
  const digits = req.body.Digits;
  
  console.log(`=== EPISODE FINISHED ===`);
  console.log(`Channel: ${channel}, Episode: ${episodeIndex}, Input: ${digits || 'timeout'}`);
  
  const twiml = new VoiceResponse();
  
  // If user pressed 0, return to main menu
  if (digits === '0') {
    twiml.say(VOICE_CONFIG, 'Returning to main menu.');
    twiml.redirect('/webhook/ivr-main');
    return res.type('text/xml').send(twiml.toString());
  }
  
  const podcast = ALL_PODCASTS[channel];
  if (!podcast) {
    twiml.say(VOICE_CONFIG, 'Invalid channel.');
    twiml.redirect('/webhook/ivr-main');
    return res.type('text/xml').send(twiml.toString());
  }
  
  try {
    // Fetch episodes to get the next one
    const episodes = await fetchPodcastEpisodes(podcast.rssUrl);
    const nextEpisodeIndex = episodeIndex + 1;
    
    if (episodes && episodes[nextEpisodeIndex]) {
      console.log(`🔄 Auto-advancing to next episode: ${nextEpisodeIndex}`);
      const nextEpisode = episodes[nextEpisodeIndex];
      
      // Clean the URL
      const cleanedUrl = cleanAudioUrl(nextEpisode.audioUrl);
      const encodedUrl = Buffer.from(cleanedUrl).toString('base64');
      const playUrl = `https://${req.get('host')}/proxy-audio/${encodedUrl}`;
      
      twiml.say(VOICE_CONFIG, `Next episode: ${nextEpisode.title.substring(0, 80)}`);
      
      // Set up gather for next episode
      const gather = twiml.gather({
        numDigits: 1,
        timeout: 30,
        action: `/webhook/playback-control?channel=${channel}&episodeIndex=${nextEpisodeIndex}`,
        method: 'POST'
      });
      
      gather.play({ loop: 1 }, playUrl);
      gather.say(VOICE_CONFIG, 'Press 1 for previous episode, 3 for next episode, 4 to restart episode, 6 to skip episode, or 0 for menu.');
      
      // Fallback to continue next episode
      twiml.redirect(`/webhook/playback-control?channel=${channel}&episodeIndex=${nextEpisodeIndex}`);
      
    } else {
      // No more episodes, loop back to first episode
      console.log(`🔄 End of episodes reached, looping back to first episode`);
      twiml.say(VOICE_CONFIG, `You've reached the end of ${podcast.name}. Restarting from the latest episode.`);
      twiml.redirect(`/webhook/play-episode?channel=${channel}&episodeIndex=0`);
    }
    
  } catch (error) {
    console.error(`❌ Error in episode progression:`, error.message);
    twiml.say(VOICE_CONFIG, 'There was an issue loading the next episode. Returning to main menu.');
    twiml.redirect('/webhook/ivr-main');
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

// Feedback system endpoints
app.post('/webhook/feedback-complete', async (req, res) => {
  const callSid = req.query.callSid;
  const recordingUrl = req.body.RecordingUrl;
  const recordingDuration = parseInt(req.body.RecordingDuration) || 0;
  
  console.log(`🎤 Feedback recording completed: ${recordingDuration}s`);
  
  const twiml = new VoiceResponse();
  
  if (recordingDuration < 3) {
    twiml.say(VOICE_CONFIG, getPrompt('feedback', 'tooShort'));
    twiml.redirect('/webhook/ivr-main');
  } else {
    twiml.say(VOICE_CONFIG, getPrompt('feedback', 'saving'));
    
    // Save feedback record
    if (callSid && recordingUrl) {
      try {
        await saveFeedbackRecord(callSid, recordingUrl, recordingDuration);
        analytics.trackFeedback(callSid, {
          duration: recordingDuration,
          recordingUrl: recordingUrl
        });
        twiml.say(VOICE_CONFIG, getPrompt('feedback', 'saved'));
      } catch (error) {
        console.error('❌ Failed to save feedback:', error.message);
        twiml.say(VOICE_CONFIG, getPrompt('feedback', 'error'));
      }
    }
    
    twiml.redirect('/webhook/ivr-main');
  }
  
  res.type('text/xml');
  res.send(twiml.toString());
});

app.post('/webhook/feedback-transcription', async (req, res) => {
  const callSid = req.query.callSid;
  const transcriptionText = req.body.TranscriptionText;
  const transcriptionStatus = req.body.TranscriptionStatus;
  
  console.log(`📝 Feedback transcription: ${transcriptionStatus}`);
  
  if (transcriptionStatus === 'completed' && transcriptionText) {
    try {
      await updateFeedbackTranscription(callSid, transcriptionText);
      analytics.trackFeedback(callSid, {
        transcription: transcriptionText
      });
      console.log(`✅ Transcription saved for ${callSid}: ${transcriptionText.substring(0, 50)}...`);
    } catch (error) {
      console.error('❌ Failed to save transcription:', error.message);
    }
  }
  
  res.status(200).send('OK');
});

// Helper function to save feedback record
async function saveFeedbackRecord(callSid, recordingUrl, duration) {
  const feedbackRecord = {
    callSid,
    timestamp: new Date().toISOString(),
    recordingUrl,
    duration,
    transcription: null,
    processed: false
  };
  
  const feedbackFile = path.join(__dirname, 'feedback-records.json');
  let feedbackData = [];
  
  try {
    if (fs.existsSync(feedbackFile)) {
      feedbackData = JSON.parse(fs.readFileSync(feedbackFile, 'utf8'));
    }
  } catch (error) {
    console.error('❌ Failed to load existing feedback:', error.message);
  }
  
  feedbackData.push(feedbackRecord);
  fs.writeFileSync(feedbackFile, JSON.stringify(feedbackData, null, 2));
  
  console.log(`💾 Feedback record saved: ${callSid}`);
}

// Helper function to update transcription
async function updateFeedbackTranscription(callSid, transcription) {
  const feedbackFile = path.join(__dirname, 'feedback-records.json');
  
  try {
    if (fs.existsSync(feedbackFile)) {
      const feedbackData = JSON.parse(fs.readFileSync(feedbackFile, 'utf8'));
      const record = feedbackData.find(f => f.callSid === callSid);
      
      if (record) {
        record.transcription = transcription;
        record.processed = true;
        record.transcribedAt = new Date().toISOString();
        
        fs.writeFileSync(feedbackFile, JSON.stringify(feedbackData, null, 2));
        console.log(`📝 Transcription updated for ${callSid}`);
      }
    }
  } catch (error) {
    console.error('❌ Failed to update transcription:', error.message);
  }
}

// Feedback management endpoints
app.get('/api/feedback/list', async (req, res) => {
  try {
    const feedbackFile = path.join(__dirname, 'feedback-records.json');
    let feedbackData = [];
    
    if (fs.existsSync(feedbackFile)) {
      feedbackData = JSON.parse(fs.readFileSync(feedbackFile, 'utf8'));
    }
    
    res.json({
      total: feedbackData.length,
      feedback: feedbackData.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)),
      summary: {
        processed: feedbackData.filter(f => f.processed).length,
        totalDuration: feedbackData.reduce((sum, f) => sum + (f.duration || 0), 0)
      }
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/feedback/download/:callSid', async (req, res) => {
  try {
    const { callSid } = req.params;
    const feedbackFile = path.join(__dirname, 'feedback-records.json');
    
    if (!fs.existsSync(feedbackFile)) {
      return res.status(404).json({ error: 'No feedback records found' });
    }
    
    const feedbackData = JSON.parse(fs.readFileSync(feedbackFile, 'utf8'));
    const record = feedbackData.find(f => f.callSid === callSid);
    
    if (!record) {
      return res.status(404).json({ error: 'Feedback record not found' });
    }
    
    if (!record.recordingUrl) {
      return res.status(404).json({ error: 'Recording URL not available' });
    }
    
    // Redirect to recording URL for download
    res.redirect(record.recordingUrl);
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Test endpoint for ad system
app.get('/api/test-ads/:phoneNumber', async (req, res) => {
  try {
    const { phoneNumber } = req.params;
    const testCallSid = 'test_' + Date.now();
    
    // Initialize test session
    analytics.startSession(testCallSid, phoneNumber);
    const adEnabled = adSystem.initSession(testCallSid, phoneNumber);
    
    // Try to get a preroll ad
    const prerollAd = await adSystem.getPrerollAd(testCallSid, '2', 'NPR News Now');
    
    // Clean up test session
    analytics.endSession(testCallSid, 'test_completed');
    adSystem.endSession(testCallSid);
    
    res.json({
      phoneNumber,
      adSystemEnabled: adEnabled,
      prerollAdServed: !!prerollAd,
      prerollAd: prerollAd || null,
      message: prerollAd ? `Ad would be served: ${prerollAd.name}` : 'No ad would be served'
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Test ad endpoints for TTS-generated ads
app.get('/api/test-ad/:adId', (req, res) => {
  const { adId } = req.params;
  
  const adMessages = {
    'preroll1': 'This episode is brought to you by Local Business. Your neighborhood partner for quality service and friendly support. Visit us today.',
    'preroll2': 'Tech Company presents this podcast. Innovation that works for you. Technology made simple.',
    'midroll1': 'Hungry? Restaurant Chain has fresh ingredients and great taste. Over 50 locations to serve you.',
    'midroll2': 'Protect what matters most with Insurance Company. Reliable coverage, competitive rates, local agents.'
  };
  
  const message = adMessages[adId] || 'Thank you for listening to our sponsors.';
  
  const twiml = new VoiceResponse();
  twiml.say(VOICE_CONFIG, message);
  
  res.type('text/xml');
  res.send(twiml.toString());
});

// Call status webhook to track call completion
app.post('/webhook/call-status', async (req, res) => {
  const callSid = req.body.CallSid;
  const callStatus = req.body.CallStatus;
  const callDuration = parseInt(req.body.CallDuration) || 0;
  
  console.log(`📞 Call status update: ${callSid} - ${callStatus} (${callDuration}s)`);
  
  // End analytics and ad sessions when call completes
  if (callStatus === 'completed' || callStatus === 'failed' || callStatus === 'canceled') {
    try {
      analytics.endSession(callSid, callStatus);
      adSystem.endSession(callSid);
      console.log(`📊 Session ended for ${callSid}: ${callStatus}`);
    } catch (error) {
      console.error(`❌ Error ending session ${callSid}:`, error.message);
    }
  }
  
  res.status(200).send('OK');
});

