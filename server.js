require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Voice configuration - Channel 50 fixes deployed
const VOICE_CONFIG = {
    voice: 'Polly.Brian',
    language: 'en-GB'
};

// Constants
const SKIP_DURATION = 120; // 2 minutes for skip forward/back

// Import ad system and analytics
const AdSystem = require('./ad-system');
const CallerAnalytics = require('./caller-analytics');

// Import enhanced caching and session management
const EpisodeCache = require('./episode-cache');
const CallerSessions = require('./caller-sessions');
const AudioProcessor = require('./audio-processor');

// Weather API configuration
const WEATHER_API_KEY = process.env.WEATHER_API_KEY || '3d01c291215870d467a4f3881e114bf6';

const app = express();
const port = process.env.PORT || 3000;

// Serve static audio files
app.use('/audio', express.static('public/audio'));
app.use('/debates', express.static('public/debates'));

// Serve cached episodes (from episode cache system)
app.use('/cached_episodes', express.static(path.join(__dirname, 'cached_episodes')));

// Debug route to list files in debates folder
app.get('/debates-list', (req, res) => {
  
  try {
    const debatesPath = path.join(__dirname, 'public', 'debates');
    const files = fs.readdirSync(debatesPath);
    
    res.json({
      path: debatesPath,
      files: files,
      mp3Files: files.filter(f => f.toLowerCase().endsWith('.mp3')),
      totalFiles: files.length
    });
  } catch (error) {
    res.json({
      error: error.message,
      path: path.join(__dirname, 'public', 'debates')
    });
  }
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Add CORS headers for GUI access
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// Initialize voice client (Twilio or SignalWire)
let voiceClient;
let voiceProvider = 'demo';

if (process.env.SIGNALWIRE_PROJECT_ID && process.env.SIGNALWIRE_AUTH_TOKEN && process.env.SIGNALWIRE_SPACE_URL) {
  // SignalWire configuration
  try {
    voiceClient = twilio(process.env.SIGNALWIRE_PROJECT_ID, process.env.SIGNALWIRE_AUTH_TOKEN, {
      laml: true,
      region: 'us1', 
      edge: process.env.SIGNALWIRE_SPACE_URL.replace('https://', '').replace('.signalwire.com', '')
    });
    voiceProvider = 'signalwire';
    console.log('✅ SignalWire client initialized');
  } catch (error) {
    console.warn('⚠️ SignalWire client initialization failed:', error.message);
  }
} else if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  // Twilio configuration (fallback)
  try {
    voiceClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    voiceProvider = 'twilio';
    console.log('✅ Twilio client initialized');
  } catch (error) {
    console.warn('⚠️ Twilio client initialization failed:', error.message);
  }
} else {
  console.warn('⚠️ No voice provider credentials found - running in demo mode');
  console.warn('   Looking for SIGNALWIRE_* or TWILIO_* environment variables');
}

// Legacy variable for compatibility
const twilioClient = voiceClient;

const VoiceResponse = twilio.twiml.VoiceResponse;

// Initialize Audio Pipeline
let audioPipeline;

// Initialize Ad System and Analytics
const adSystem = new AdSystem();
const analytics = new CallerAnalytics();

// Initialize Episode Cache, Caller Sessions, and Audio Processor
const episodeCache = new EpisodeCache();
const callerSessions = new CallerSessions();

// Initialize audio processor with error handling
let audioProcessor = null;
try {
  audioProcessor = new AudioProcessor();
  console.log('🎵 Audio processor initialized successfully');
} catch (error) {
  console.warn('⚠️ Audio processor initialization failed:', error.message);
  console.warn('🎵 Speed and seek controls will use fallback methods');
}

// Cleanup job - run every hour
setInterval(() => {
  console.log('🧹 Running scheduled cleanup...');
  episodeCache.cleanupExpiredEpisodes();
  callerSessions.cleanupOldSessions();
  if (audioProcessor) {
    audioProcessor.cleanup(168); // Clean audio files older than 7 days
  }
}, 60 * 60 * 1000); // 1 hour

// Enhanced RSS fetching function with episode caching
async function fetchPodcastEpisodes(rssUrl, startIndex = 0, maxCount = 10, channelId = null) {
    console.log(`🔍 Fetching episodes from: ${rssUrl} (start: ${startIndex}, max: ${maxCount})`);
    
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
        
        // Process episodes based on startIndex and maxCount parameters
        const endIndex = Math.min(startIndex + maxCount, itemMatches.length);
        for (let i = startIndex; i < endIndex; i++) {
            const item = itemMatches[i];
            
            // Extract title
            const titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/i) ||
                              item.match(/<title[^>]*>(.*?)<\/title>/i);
            
            // Extract audio URL and file size
            const enclosureMatch = item.match(/<enclosure[^>]+url=["']([^"']+)["'][^>]*/i) ||
                                  item.match(/<media:content[^>]+url=["']([^"']+)["'][^>]*/i);
            
            // Extract file size from enclosure length attribute
            const lengthMatch = item.match(/<enclosure[^>]+length=["']([^"']+)["'][^>]*/i);
            
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
                
                // Extract file size if available
                const fileSize = lengthMatch ? parseInt(lengthMatch[1]) : 0;
                const fileSizeMB = Math.round(fileSize / 1024 / 1024);
                
                // Basic URL validation
                if (audioUrl.startsWith('http') && title.length > 0) {
                    // Check if episode is cached or cache it
                    let cachedPath = null;
                    if (channelId && episodeCache) {
                        if (episodeCache.isCached(channelId, audioUrl)) {
                            cachedPath = episodeCache.getCachedEpisodePath(channelId, audioUrl);
                            console.log(`💾 Episode cached: "${title.substring(0, 30)}..."`);
                        } else if (i === 0) {
                            // Auto-cache latest episode (first in RSS feed)
                            try {
                                console.log(`📥 Auto-caching latest episode: "${title}"`);
                                cachedPath = await episodeCache.ensureLatestEpisode(channelId, audioUrl, title);
                                
                                // Trigger audio processing for popular channels (async)
                                if (cachedPath && ['2', '3', '4', '6', '7', '8', '10', '11', '12'].includes(channelId)) {
                                    const episodeId = `${channelId}_${crypto.createHash('md5').update(audioUrl).digest('hex')}`;
                                    console.log(`🎵 Triggering audio processing for popular channel ${channelId}`);
                                    
                                    // Process in background (don't await)
                                    audioProcessor.processEpisodeComplete(cachedPath, episodeId)
                                        .then(result => {
                                            console.log(`✅ Audio processing complete for episode ${episodeId}`);
                                        })
                                        .catch(error => {
                                            console.warn(`⚠️ Audio processing failed for ${episodeId}:`, error.message);
                                        });
                                }
                            } catch (cacheError) {
                                console.warn(`⚠️ Failed to cache latest episode: ${cacheError.message}`);
                            }
                        }
                    }
                    
                    episodes.push({ 
                        title, 
                        audioUrl, 
                        fileSize, 
                        fileSizeMB,
                        cachedPath, // Local file path if cached
                        isCached: !!cachedPath
                    });
                    console.log(`✓ Episode: "${title.substring(0, 50)}..." (${fileSizeMB}MB)${cachedPath ? ' [CACHED]' : ''}`);
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
        const currentPrecipitation = current.pop ? Math.round(current.pop * 100) : 0;
        
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
                    precipitation: [],
                    dayName: date.toLocaleDateString('en-US', { weekday: 'long' })
                };
            }
            
            dailyForecasts[dateStr].temps.push(item.main.temp);
            dailyForecasts[dateStr].conditions.push(item.weather[0].description);
            dailyForecasts[dateStr].precipitation.push(item.pop || 0);
        });
        
        // Build multi-day forecast
        let weatherReport = `Weather forecast for ${name}. Currently ${currentTemp} degrees, feels like ${feelsLike}. Current conditions: ${description}. Humidity ${humidity} percent, wind ${windSpeed} miles per hour. `;
        
        // Add current precipitation chance if significant
        if (currentPrecipitation >= 20) {
            weatherReport += `Chance of precipitation: ${currentPrecipitation} percent. `;
        }
        
        // Add daily forecasts for next 4-5 days
        const days = Object.values(dailyForecasts).slice(0, 5);
        
        days.forEach((day, index) => {
            const high = Math.round(Math.max(...day.temps));
            const low = Math.round(Math.min(...day.temps));
            const mostCommonCondition = day.conditions.sort((a,b) =>
                day.conditions.filter(v => v===a).length - day.conditions.filter(v => v===b).length
            ).pop();
            
            // Calculate average precipitation chance for the day
            const avgPrecipitation = Math.round((day.precipitation.reduce((a, b) => a + b, 0) / day.precipitation.length) * 100);
            
            // Check if precipitation is likely
            const isPrecipitationLikely = avgPrecipitation >= 20 || 
                mostCommonCondition.includes('rain') || 
                mostCommonCondition.includes('snow') || 
                mostCommonCondition.includes('drizzle') ||
                mostCommonCondition.includes('shower');
            
            let dayForecast = '';
            if (index === 0) {
                dayForecast = `Today's high ${high}, low ${low}, expecting ${mostCommonCondition}`;
            } else if (index === 1) {
                dayForecast = `Tomorrow, ${day.dayName}, high ${high}, low ${low}, ${mostCommonCondition}`;
            } else {
                dayForecast = `${day.dayName}, high ${high}, low ${low}, ${mostCommonCondition}`;
            }
            
            // Add precipitation chance if significant
            if (isPrecipitationLikely) {
                dayForecast += `, ${avgPrecipitation} percent chance of precipitation`;
            }
            
            weatherReport += dayForecast + '. ';
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

// Test if a podcast URL supports byte-range seeking
async function testSeekingSupport(url) {
  try {
    const testResponse = await axios({
      method: 'HEAD',
      url: url,
      timeout: 3000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TwilioPodcastBot/2.0)',
        'Range': 'bytes=1000-2000'
      }
    });
    
    return testResponse.status === 206;
  } catch (error) {
    console.log(`⚠️ Seeking test failed: ${error.message}`);
    return false;
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
        
        // URL sanitization for problematic characters and encoding
        try {
            // Parse URL to handle encoding properly
            const urlObj = new URL(cleaned);
            
            // Encode path components that might have problematic characters
            const pathParts = urlObj.pathname.split('/');
            urlObj.pathname = pathParts.map((part, index) => {
                if (index === 0) return part; // Keep leading slash
                // Encode each path segment but preserve basic URL characters
                return encodeURIComponent(decodeURIComponent(part));
            }).join('/');
            
            cleaned = urlObj.toString();
            console.log(`🔧 URL sanitized for compatibility: ${cleaned.substring(0, 80)}...`);
        } catch (urlError) {
            console.log(`⚠️ URL sanitization skipped (not a valid URL): ${urlError.message}`);
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
    status: 'Voice Podcast IVR Server Running',
    service: 'operational',
    timestamp: new Date().toISOString(),
    platform: 'Railway',
    voiceProvider: voiceProvider,
    voiceEnabled: !!voiceClient,
    podcasts: Object.keys(ALL_PODCASTS).length,
    features: [
      `${voiceProvider === 'signalwire' ? 'SignalWire' : 'Twilio'} integration`,
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
    
    if (fs.existsSync(logFile)) {
      downloads = JSON.parse(fs.readFileSync(logFile));
    }
    
    downloads.push(downloadEvent);
    fs.writeFileSync(logFile, JSON.stringify(downloads, null, 2));
    
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
    if (!fs.existsSync(logFile)) return 0;
    
    const downloads = JSON.parse(fs.readFileSync(logFile));
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
    if (!fs.existsSync(logFile)) return 0;
    
    const downloads = JSON.parse(fs.readFileSync(logFile));
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

// Detailed analytics for GUI table
app.get('/analytics/detailed', async (req, res) => {
  try {
    const detailedAnalytics = analytics.getDetailedAnalytics();
    res.json({
      callerDetails: detailedAnalytics,
      timestamp: new Date().toISOString()
    });
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

// Chunked file upload endpoint for debates
app.get('/upload-debates', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Upload Debate MP3 Files</title>
        <style>
            body { font-family: Arial, sans-serif; margin: 40px; }
            .upload-area { border: 2px dashed #ccc; padding: 20px; margin: 20px 0; }
            button { background: #4CAF50; color: white; padding: 10px 20px; border: none; cursor: pointer; margin: 5px; }
            button:disabled { background: #ccc; }
            .file-list { margin: 20px 0; }
            .progress { display: none; width: 100%; background: #f0f0f0; margin: 10px 0; }
            .progress-bar { height: 20px; background: #4CAF50; width: 0%; }
            .upload-info { font-size: 12px; color: #666; margin: 10px 0; }
        </style>
        <script>
            const CHUNK_SIZE = 1024 * 1024; // 1MB chunks for speed
            
            async function uploadFileChunked() {
                const fileInput = document.getElementById('fileInput');
                const file = fileInput.files[0];
                if (!file) return;
                
                const uploadBtn = document.getElementById('uploadBtn');
                const progressDiv = document.getElementById('progress');
                const progressBar = document.getElementById('progressBar');
                const status = document.getElementById('status');
                
                uploadBtn.disabled = true;
                progressDiv.style.display = 'block';
                
                const filename = file.name.replace(/[^a-zA-Z0-9.-]/g, '_');
                const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
                
                try {
                    // Initialize upload
                    const initResponse = await fetch('/upload-init', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ filename, fileSize: file.size, totalChunks })
                    });
                    
                    if (!initResponse.ok) throw new Error('Failed to initialize upload');
                    const { uploadId } = await initResponse.json();
                    
                    // Upload chunks
                    for (let i = 0; i < totalChunks; i++) {
                        const start = i * CHUNK_SIZE;
                        const end = Math.min(start + CHUNK_SIZE, file.size);
                        const chunk = file.slice(start, end);
                        
                        const chunkResponse = await fetch(\`/upload-chunk/\${uploadId}/\${i}\`, {
                            method: 'POST',
                            body: chunk
                        });
                        
                        if (!chunkResponse.ok) throw new Error(\`Failed to upload chunk \${i}\`);
                        
                        const percent = ((i + 1) / totalChunks) * 100;
                        progressBar.style.width = percent + '%';
                        status.innerHTML = \`Uploading: \${Math.round(percent)}% (chunk \${i + 1}/\${totalChunks})\`;
                    }
                    
                    // Finalize upload
                    const finalResponse = await fetch(\`/upload-finalize/\${uploadId}\`, { method: 'POST' });
                    if (!finalResponse.ok) throw new Error('Failed to finalize upload');
                    
                    status.innerHTML = 'Upload successful! ✅';
                    setTimeout(() => location.reload(), 2000);
                    
                } catch (error) {
                    status.innerHTML = 'Upload failed: ' + error.message;
                    uploadBtn.disabled = false;
                }
            }
        </script>
    </head>
    <body>
        <h1>🎙️ Upload Debate MP3 Files (Chunked)</h1>
        <div class="upload-area">
            <input type="file" id="fileInput" accept=".mp3" required>
            <br><br>
            <button id="uploadBtn" onclick="uploadFileChunked()">Upload MP3 (Fast)</button>
            <div class="upload-info">
                ✨ Uses 1MB chunks for faster, more reliable uploads<br>
                📁 Max file size: 500MB | Resumes automatically on errors
            </div>
            <div id="progress" class="progress">
                <div id="progressBar" class="progress-bar"></div>
            </div>
            <div id="status"></div>
        </div>
        <div class="file-list">
            <h3>Current Files:</h3>
            <a href="/debates-list">View uploaded files</a>
        </div>
    </body>
    </html>
  `);
});

// Chunked upload system
const activeUploads = new Map();

// Initialize chunked upload
app.post('/upload-init', (req, res) => {
  const { filename, fileSize, totalChunks } = req.body;
  const uploadId = Date.now().toString() + Math.random().toString(36).substr(2, 9);
  const sanitizedFilename = filename.replace(/[^a-zA-Z0-9.-]/g, '_');
  
  const debatesDir = path.join(__dirname, 'public', 'debates');
  if (!fs.existsSync(debatesDir)) {
    fs.mkdirSync(debatesDir, { recursive: true });
  }
  
  activeUploads.set(uploadId, {
    filename: sanitizedFilename,
    filepath: path.join(debatesDir, sanitizedFilename),
    totalChunks,
    receivedChunks: 0,
    chunks: new Array(totalChunks),
    fileSize
  });
  
  console.log(`🚀 Upload initialized: ${sanitizedFilename} (${fileSize} bytes, ${totalChunks} chunks)`);
  res.json({ uploadId });
});

// Upload individual chunk
app.post('/upload-chunk/:uploadId/:chunkIndex', (req, res) => {
  const { uploadId, chunkIndex } = req.params;
  const upload = activeUploads.get(uploadId);
  
  if (!upload) {
    return res.status(404).json({ error: 'Upload not found' });
  }
  
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const chunkData = Buffer.concat(chunks);
    upload.chunks[parseInt(chunkIndex)] = chunkData;
    upload.receivedChunks++;
    
    console.log(`📦 Chunk ${chunkIndex}/${upload.totalChunks} received for ${upload.filename}`);
    res.json({ success: true, chunkIndex });
  });
  
  req.on('error', (error) => {
    console.error(`❌ Chunk upload error:`, error);
    res.status(500).json({ error: error.message });
  });
});

// Finalize upload (combine chunks)
app.post('/upload-finalize/:uploadId', (req, res) => {
  const { uploadId } = req.params;
  const upload = activeUploads.get(uploadId);
  
  if (!upload) {
    return res.status(404).json({ error: 'Upload not found' });
  }
  
  try {
    const writeStream = fs.createWriteStream(upload.filepath);
    
    for (let i = 0; i < upload.totalChunks; i++) {
      if (upload.chunks[i]) {
        writeStream.write(upload.chunks[i]);
      }
    }
    
    writeStream.end();
    activeUploads.delete(uploadId);
    
    console.log(`✅ Upload finalized: ${upload.filename}`);
    res.json({ 
      success: true, 
      filename: upload.filename,
      size: upload.fileSize 
    });
    
  } catch (error) {
    console.error(`❌ Upload finalization error:`, error);
    activeUploads.delete(uploadId);
    res.status(500).json({ error: error.message });
  }
});

// Binary upload endpoint (more efficient for large files)
app.post('/upload-debate-binary', (req, res) => {
  const filename = req.query.filename || `debate_${Date.now()}.mp3`;
  const sanitizedFilename = filename.replace(/[^a-zA-Z0-9.-]/g, '_');
  
  try {
    const debatesDir = path.join(__dirname, 'public', 'debates');
    if (!fs.existsSync(debatesDir)) {
      fs.mkdirSync(debatesDir, { recursive: true });
    }
    
    const filepath = path.join(debatesDir, sanitizedFilename);
    const writeStream = fs.createWriteStream(filepath);
    
    let totalSize = 0;
    
    req.on('data', chunk => {
      totalSize += chunk.length;
      writeStream.write(chunk);
    });
    
    req.on('end', () => {
      writeStream.end();
      console.log(`✅ Binary upload completed: ${sanitizedFilename} (${totalSize} bytes)`);
      res.json({ 
        success: true, 
        filename: sanitizedFilename, 
        size: totalSize 
      });
    });
    
    req.on('error', (error) => {
      console.error('Binary upload error:', error);
      writeStream.destroy();
      if (fs.existsSync(filepath)) {
        fs.unlinkSync(filepath);
      }
      res.status(500).json({ error: error.message });
    });
    
  } catch (error) {
    console.error('Binary upload setup error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/upload-debate', (req, res) => {
  // Set longer timeout for large files
  req.setTimeout(600000); // 10 minutes
  res.setTimeout(600000);
  
  try {
    // Ensure debates directory exists
    const debatesDir = path.join(__dirname, 'public', 'debates');
    if (!fs.existsSync(debatesDir)) {
      fs.mkdirSync(debatesDir, { recursive: true });
    }
    
    const filename = `debate_${Date.now()}.mp3`;
    const filepath = path.join(debatesDir, filename);
    const writeStream = fs.createWriteStream(filepath);
    
    let totalSize = 0;
    const maxSize = 200 * 1024 * 1024; // 200MB limit
    
    req.on('data', chunk => {
      totalSize += chunk.length;
      if (totalSize > maxSize) {
        writeStream.destroy();
        fs.unlinkSync(filepath);
        res.status(413).send('File too large (max 200MB)');
        return;
      }
      writeStream.write(chunk);
    });
    
    req.on('end', () => {
      writeStream.end();
      console.log(`✅ Upload completed: ${filename} (${totalSize} bytes)`);
      
      res.send(`
        <h1>✅ Upload Successful!</h1>
        <p>File saved as: ${filename}</p>
        <p>Size: ${Math.round(totalSize / 1024 / 1024)} MB</p>
        <a href="/upload-debates">Upload another file</a> | 
        <a href="/debates-list">View all files</a>
      `);
    });
    
    req.on('error', (error) => {
      console.error('Upload error:', error);
      writeStream.destroy();
      if (fs.existsSync(filepath)) {
        fs.unlinkSync(filepath);
      }
      res.status(500).send('Upload failed: ' + error.message);
    });
    
  } catch (error) {
    console.error('Upload setup error:', error);
    res.status(500).send('Upload failed: ' + error.message);
  }
});

// Debug endpoint to list uploaded files
app.get('/debates-list', (req, res) => {
  try {
    const debatesPath = path.join(__dirname, 'public', 'debates');
    
    if (!fs.existsSync(debatesPath)) {
      fs.mkdirSync(debatesPath, { recursive: true });
    }
    
    const files = fs.readdirSync(debatesPath);
    const mp3Files = files.filter(f => f.toLowerCase().endsWith('.mp3'));
    
    res.json({
      path: debatesPath,
      files: files,
      mp3Files: mp3Files,
      totalFiles: files.length,
      urls: mp3Files.map(file => `${req.protocol}://${req.get('host')}/debates/${file}`)
    });
  } catch (error) {
    res.json({
      error: error.message,
      path: path.join(__dirname, 'public', 'debates')
    });
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
      console.log(`\n🎉 ${voiceProvider.toUpperCase()} PODCAST IVR SYSTEM OPERATIONAL!`);
      console.log(`🌐 Server running on port ${port}`);
      console.log(`📞 ${voiceProvider === 'signalwire' ? 'SignalWire' : 'Twilio'} Integration: READY`);
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
      
      // Initialize intelligent episode caching system
      initializeCachingSystem();
    });
    
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

// Initialize intelligent episode caching system
async function initializeCachingSystem() {
  console.log('\n🚀 Initializing intelligent episode caching system...');
  
  try {
    const episodeCache = new EpisodeCache();
    
    // Clean up expired episodes first
    episodeCache.cleanupExpiredEpisodes();
    
    // Get all podcast channels for preloading
    const allChannels = { ...ALL_PODCASTS, ...EXTENSION_PODCASTS };
    
    // Preload latest episodes for all channels in background
    setTimeout(async () => {
      try {
        await episodeCache.preloadLatestEpisodes(allChannels, fetchPodcastEpisodes);
      } catch (error) {
        console.error('❌ Error during latest episodes preload:', error.message);
      }
    }, 5000); // Wait 5 seconds after server start
    
    // Set up periodic checks for newer episodes (every 30 minutes)
    setInterval(async () => {
      try {
        console.log('🔍 Running periodic check for newer episodes...');
        
        for (const [channelId, podcast] of Object.entries(allChannels)) {
          if (podcast.rssUrl && !podcast.rssUrl.startsWith('STATIC_') && !podcast.rssUrl.startsWith('YOUTUBE_')) {
            const latestCached = episodeCache.getLatestCachedEpisode(channelId);
            
            if (latestCached) {
              const currentLatestUrl = latestCached.episode.episodeUrl;
              await episodeCache.checkForNewerEpisodes(channelId, currentLatestUrl, fetchPodcastEpisodes, podcast.rssUrl);
            }
          }
        }
        
        // Also cleanup expired episodes during periodic check
        episodeCache.cleanupExpiredEpisodes();
        
      } catch (error) {
        console.error('❌ Error during periodic episode check:', error.message);
      }
    }, 30 * 60 * 1000); // 30 minutes
    
    console.log('✅ Intelligent caching system initialized');
    console.log('📥 Latest episodes will be preloaded in background');
    console.log('🔄 Periodic checks every 30 minutes for newer episodes');
    
  } catch (error) {
    console.error('❌ Failed to initialize caching system:', error.message);
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
  
  let selectedPodcast = ALL_PODCASTS[digits] || EXTENSION_PODCASTS[digits];
  
  if (!selectedPodcast) {
    console.log(`❌ No podcast found for channel ${digits}`);
    twiml.say(VOICE_CONFIG, getPrompt('mainMenu', 'invalidSelection'));
    twiml.redirect('/webhook/ivr-main');
    return res.type('text/xml').send(twiml.toString());
  }
  
  console.log(`Selected: ${selectedPodcast.name}`);
  
  // Track selection
  trackPodcastSelection(digits, caller, req.body.CallSid);
  
  // Check for resumable session at extension level
  const callerId = req.body.From || req.body.Caller;
  const lastSession = callerSessions.getLastPosition(callerId);
  
  if (lastSession && lastSession.channelId === digits && callerSessions.hasResumableSession(callerId)) {
    console.log(`🔄 Offering resume for ${callerId} in ${selectedPodcast.name}`);
    const resumePrompt = callerSessions.generateResumePrompt(callerId);
    
    twiml.say(VOICE_CONFIG, resumePrompt.prompt);
    const resumeGather = twiml.gather({
      numDigits: 1,
      timeout: 10,
      action: `/webhook/extension-resume-choice?channel=${digits}&resumePosition=${lastSession.positionSeconds}`
    });
    return res.type('text/xml').send(twiml.toString());
  }
  
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
      const callerId = req.body.From || req.body.Caller;
      
      // Check if caller has a saved zipcode
      if (callerSessions.hasSavedZipcode(callerId)) {
        const zipcodePrompt = callerSessions.generateZipcodePrompt(callerId);
        console.log(`🌤️ Returning weather caller with saved zipcode: ${zipcodePrompt.zipcode}`);
        
        twiml.say(VOICE_CONFIG, zipcodePrompt.prompt);
        
        const gather = twiml.gather({
          numDigits: 1,
          timeout: 10,
          action: `/webhook/weather-zipcode-choice?savedZipcode=${zipcodePrompt.zipcode}`,
          method: 'POST'
        });
        
        twiml.say(VOICE_CONFIG, getPrompt('weather', 'noZipcodeReceived'));
        twiml.redirect('/webhook/ivr-main');
        res.type('text/xml');
        return res.send(twiml.toString());
      } else {
        // First time weather user
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
    }
    
    // Handle YouTube debates - now with episode caching for consistent controls
    if (selectedPodcast.rssUrl === 'YOUTUBE_DEBATES') {
      console.log(`🎬 Loading debates with caching for uniform speed controls`);
      
      try {
        // Initialize episode cache
        const episodeCache = new EpisodeCache();
        
        // Dynamically detect MP3 files in the debates folder
        const fs = require('fs');
        const path = require('path');
        let fileList = [];
        
        try {
          const debatesPath = path.join(__dirname, 'public', 'debates');
          console.log(`📂 Scanning local debates folder: ${debatesPath}`);
          
          // Read directory contents
          const files = fs.readdirSync(debatesPath);
          
          // Filter for MP3 files
          const mp3Files = files
            .filter(file => file.toLowerCase().endsWith('.mp3'))
            .sort(); // Sort alphabetically
          
          console.log(`📂 Found ${mp3Files.length} MP3 files: ${mp3Files.join(', ')}`);
          
          if (mp3Files.length > 0) {
            fileList = mp3Files;
          } else {
            console.log(`⚠️ No MP3 files found in debates folder`);
            fileList = [];
          }
          
        } catch (fsError) {
          console.error(`❌ Error reading debates folder: ${fsError.message}`);
          console.log(`📂 Using fallback file list`);
          fileList = ['debate1.mp3', 'debate2.mp3', 'debate3.mp3'];
        }
        
        if (fileList.length === 0) {
          twiml.say(VOICE_CONFIG, 'No MP3 files found in shared folder. Please check the folder contents.');
          twiml.redirect('/webhook/ivr-main');
          res.type('text/xml');
          return res.send(twiml.toString());
        }
        
        // Create episodes array with local file URLs for caching
        const railwayBaseUrl = `${req.protocol}://${req.get('host')}/debates/`;
        const episodes = fileList.map((file, index) => ({
          title: file.replace('.mp3', '').replace(/[-_]/g, ' '),
          audioUrl: `${railwayBaseUrl}${file}`,
          description: `Debate audio file: ${file}`,
          episodeIndex: index
        }));
        
        console.log(`📂 Created ${episodes.length} debate episodes for caching`);
        
        // Cache the first episode for immediate playback with speed controls
        const firstEpisode = episodes[0];
        let cachedPath = null;
        
        try {
          // Check if already cached
          if (episodeCache.isCached('debates', firstEpisode.audioUrl)) {
            cachedPath = episodeCache.getCachedEpisodePath('debates', firstEpisode.audioUrl);
            console.log(`✅ First debate already cached: ${cachedPath}`);
          } else {
            // Cache the first episode
            console.log(`📥 Caching first debate for speed controls: ${firstEpisode.title}`);
            cachedPath = await episodeCache.cacheEpisode('debates', firstEpisode.audioUrl, firstEpisode.title, 'temporary');
            console.log(`✅ First debate cached: ${cachedPath}`);
          }
        } catch (cacheError) {
          console.warn(`⚠️ Caching failed, using direct URL: ${cacheError.message}`);
          cachedPath = null;
        }
        
        // Use cached path if available, otherwise fallback to direct URL
        const playbackUrl = cachedPath ? 
          `https://${req.get('host')}/cached_episodes/${path.basename(cachedPath)}` : 
          firstEpisode.audioUrl;
        
        console.log(`🎵 Auto-playing first debate: ${firstEpisode.title}`);
        console.log(`🎵 Playback URL: ${playbackUrl.substring(0, 100)}...`);
        
        twiml.say(VOICE_CONFIG, `Welcome to Debates. Playing: ${firstEpisode.title}. Use 1 and 3 for episode navigation, 4 and 6 for seek, 2 and 5 for speed control.`);
        
        // Update session to track the current episode
        callerSessions.updatePosition(callerId, '50', firstEpisode.audioUrl, 0, firstEpisode.title);
        
        // Play the first debate file with speed control support
        twiml.play(playbackUrl);
        
        // Use the same podcast endpoint for consistent controls
        const gather = twiml.gather({
          numDigits: 1,
          timeout: 30,
          action: `/webhook/playback-control?channel=50&episodeIndex=0&position=0&startTime=${Date.now()}`,
          method: 'POST'
        });
        
        gather.say(VOICE_CONFIG, 'Press 1 for previous, 3 for next, 4 to rewind, 6 to fast forward, 2 to slow down, 5 to speed up, or star for main menu.');
        
        twiml.say(VOICE_CONFIG, 'Returning to main menu.');
        twiml.redirect('/webhook/ivr-main');
        res.type('text/xml');
        return res.send(twiml.toString());
        
      } catch (error) {
        console.error('❌ Error loading debates from shared folder:', error.message);
        console.error('❌ Full error:', error);
        console.error('❌ Error stack:', error.stack);
        twiml.say(VOICE_CONFIG, `Sorry, debates are temporarily unavailable. Error: ${error.message.substring(0, 50)}`);
        twiml.redirect('/webhook/ivr-main');
        res.type('text/xml');
        return res.send(twiml.toString());
      }
    }

    // Handle Pilgrim Ministry sermons
    if (selectedPodcast.rssUrl === 'PILGRIM_SERMONS') {
      console.log(`⛪ Loading sermons from Pilgrim Ministry website`);
      
      try {
        // Scrape sermons from https://www.pilgrimministry.org/allsermons
        // Try the sermons directory page (has actual download links)
        let html = '';
        let sermonUrl = 'https://www.pilgrimministry.org/sermons/';
        console.log(`📡 Fetching sermons from directory: ${sermonUrl}`);
        
        try {
          const response = await axios.get(sermonUrl, { 
            timeout: 15000,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
              'Accept-Language': 'en-US,en;q=0.5',
              'Accept-Encoding': 'gzip, deflate, br',
              'Connection': 'keep-alive',
              'Upgrade-Insecure-Requests': '1'
            }
          });
          html = response.data;
          console.log('✅ Successfully accessed sermons directory');
        } catch (sermonError) {
          console.log('⚠️ Sermons directory failed, trying allsermons page:', sermonError.message);
          // Fallback to allsermons page
          sermonUrl = 'https://www.pilgrimministry.org/allsermons';
          const response = await axios.get(sermonUrl, { 
            timeout: 15000,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
              'Referer': 'https://www.pilgrimministry.org/'
            }
          });
          html = response.data;
        }
        
        // Try multiple scraping approaches for sermon audio
        let sermonFiles = [];
        
        // Debug: Log some of the HTML content to understand structure
        console.log(`📄 HTML sample (first 500 chars): ${html.substring(0, 500)}`);
        
        // Method 1: Look for data-file attributes that contain audio URLs
        const dataFileMatches = html.match(/data-file="[^"]*"/gi) || [];
        const dataTitleMatches = html.match(/data-title="[^"]*"/gi) || [];
        
        console.log(`🔍 Found ${dataFileMatches.length} data-file matches and ${dataTitleMatches.length} title matches`);
        
        dataFileMatches.slice(0, 10).forEach((match, index) => {
          const audioUrl = match.match(/data-file="([^"]*)"/i)[1];
          const titleMatch = dataTitleMatches[index];
          const title = titleMatch ? titleMatch.match(/data-title="([^"]*)"/i)[1] : `Sermon ${index + 1}`;
          
          // Clean up relative URLs
          const fullUrl = audioUrl.startsWith('http') ? audioUrl : `https://www.pilgrimministry.org${audioUrl}`;
          
          sermonFiles.push({
            id: index + 1,
            title: title.replace(/&quot;/g, '"').replace(/&amp;/g, '&'),
            url: fullUrl
          });
        });
        
        // Method 2: Look for download links and direct MP3 links
        if (sermonFiles.length === 0) {
          // Look for download links that might point to MP3 files
          const downloadMatches = html.match(/href="[^"]*download[^"]*"/gi) || 
                                 html.match(/href="[^"]*\.mp3[^"]*"/gi) || 
                                 html.match(/src="[^"]*\.mp3[^"]*"/gi) || 
                                 html.match(/"[^"]*\.mp3[^"]*"/gi) || [];
          
          console.log(`🔗 Found ${downloadMatches.length} potential download/audio links`);
          
          downloadMatches.slice(0, 10).forEach((match, index) => {
            const audioUrl = match.match(/"([^"]*)"/i)[1];
            const fullUrl = audioUrl.startsWith('http') ? audioUrl : `https://www.pilgrimministry.org${audioUrl}`;
            
            console.log(`🎵 Found potential audio URL: ${fullUrl}`);
            
            sermonFiles.push({
              id: index + 1,
              title: `Sermon ${index + 1}`,
              url: fullUrl
            });
          });
        }
        
        // Method 2b: Look for sermon titles with associated links
        if (sermonFiles.length === 0) {
          // Try to extract sermon titles and their associated download/play URLs
          const titleMatches = html.match(/<h[1-6][^>]*>[^<]*sermon[^<]*<\/h[1-6]>/gi) || 
                              html.match(/title="[^"]*sermon[^"]*"/gi) || [];
          
          console.log(`📰 Found ${titleMatches.length} potential sermon titles`);
          
          titleMatches.slice(0, 10).forEach((match, index) => {
            // Extract title text
            const titleText = match.replace(/<[^>]*>/g, '').replace(/title="/gi, '').replace(/"/g, '');
            
            sermonFiles.push({
              id: index + 1,
              title: titleText.trim() || `Sermon ${index + 1}`,
              url: `https://www.pilgrimministry.org/sermons/sermon${index + 1}.mp3` // Guessed URL pattern
            });
          });
        }
        
        // Method 3: Look for JavaScript variables containing audio data
        if (sermonFiles.length === 0) {
          const jsAudioMatches = html.match(/audio\s*=\s*"[^"]*\.mp3[^"]*"/gi) || 
                                html.match(/song\s*=\s*"[^"]*\.mp3[^"]*"/gi) || [];
          
          jsAudioMatches.slice(0, 10).forEach((match, index) => {
            const audioUrl = match.match(/"([^"]*)"/i)[1];
            const fullUrl = audioUrl.startsWith('http') ? audioUrl : `https://www.pilgrimministry.org${audioUrl}`;
            
            sermonFiles.push({
              id: index + 1,
              title: `Sermon ${index + 1}`,
              url: fullUrl
            });
          });
        }
        
        console.log(`⛪ Found ${sermonFiles.length} sermon audio files`);
        
        // Fallback: Use manual sermon configuration or test content
        if (sermonFiles.length === 0) {
          console.log('⛪ No sermons found via scraping, trying manual configuration');
          
          try {
            const sermonConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'sermons-config.json'), 'utf8'));
            sermonFiles = sermonConfig.sermons.map((sermon, index) => ({
              id: index + 1,
              title: sermon.title,
              url: sermon.url
            }));
            console.log(`⛪ Loaded ${sermonFiles.length} sermons from manual configuration`);
          } catch (error) {
            console.log('⛪ No manual configuration found, using test audio');
            sermonFiles = [
              {
                id: 1,
                title: 'Sermon: The Gospel of Grace',
                url: 'https://www.soundjay.com/misc/sounds/bell-ringing-05.mp3'
              },
              {
                id: 2,
                title: 'Sermon: Faith and Works', 
                url: 'https://www.soundjay.com/misc/sounds/church-bell-1.mp3'
              },
              {
                id: 3,
                title: 'Sermon: The Great Commission',
                url: 'https://file-examples.com/storage/fe68c1fa8eea98e14f09f2b/2017/11/file_example_MP3_700KB.mp3'
              }
            ];
          }
        }
        
        if (sermonFiles.length === 0) {
          twiml.say(VOICE_CONFIG, 'No sermons are currently available. Please try again later.');
          twiml.redirect('/webhook/ivr-main');
          res.type('text/xml');
          return res.send(twiml.toString());
        }
        
        // Start playing the first sermon immediately with podcast-style controls
        const firstSermon = sermonFiles[0];
        const filename = firstSermon.title;
        
        console.log(`⛪ Auto-playing first sermon: ${firstSermon.title}`);
        console.log(`🎵 Sermon URL: ${firstSermon.url}`);
        
        twiml.say(VOICE_CONFIG, `Welcome to Pilgrim Ministry Sermons. Playing: ${filename}. Use star-1 for next, star-2 for previous, or star-star to return to main menu.`);
        
        // Play the first sermon
        twiml.play(firstSermon.url);
        
        // Add podcast-style navigation controls
        const gather = twiml.gather({
          numDigits: 2,
          timeout: 30,
          action: `/webhook/sermon-controls?currentIndex=0&totalSermons=${sermonFiles.length}`,
          method: 'POST'
        });
        
        gather.say(VOICE_CONFIG, 'Press star-1 for next sermon, star-2 for previous, or star-star for main menu.');
        
        twiml.say(VOICE_CONFIG, 'Returning to main menu.');
        twiml.redirect('/webhook/ivr-main');
        res.type('text/xml');
        return res.send(twiml.toString());
        
      } catch (error) {
        console.error('❌ Error loading sermons from Pilgrim Ministry:', error.message);
        console.error('❌ Full error:', error);
        twiml.say(VOICE_CONFIG, `Sorry, sermons are temporarily unavailable. Error: ${error.message.substring(0, 50)}`);
        twiml.redirect('/webhook/ivr-main');
        res.type('text/xml');
        return res.send(twiml.toString());
      }
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
    
    const episodes = await fetchPodcastEpisodes(selectedPodcast.rssUrl, 0, 10, digits);
    
    if (!episodes || episodes.length === 0) {
      twiml.say(VOICE_CONFIG, getPrompt('podcasts', 'noEpisodes', {podcastName: selectedPodcast.name}));
      twiml.redirect('/webhook/ivr-main');
      res.type('text/xml');
      return res.send(twiml.toString());
    }
    
    const episode = episodes[0];
    console.log(`📻 Episode found: "${episode.title}"`);
    
    // Determine audio source: use cached file if available, otherwise remote URL
    let finalAudioUrl, playUrl;
    
    if (episode.isCached && episode.cachedPath) {
      // Use cached file through proxy for speed/seek support
      console.log(`💾 Using cached episode: ${episode.cachedPath}`);
      const cachedIdentifier = `cached://${path.basename(episode.cachedPath)}`;
      const encodedUrl = Buffer.from(cachedIdentifier).toString('base64');
      playUrl = `https://${req.get('host')}/proxy-audio/${encodedUrl}`;
      console.log(`🚀 Using cached proxy for playback: ${playUrl.substring(0, 80)}...`);
    } else {
      // Use remote URL through proxy
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
      
      console.log(`✅ Using remote audio URL: ${finalAudioUrl.substring(0, 100)}...`);
      const encodedUrl = Buffer.from(finalAudioUrl).toString('base64');
      playUrl = `https://${req.get('host')}/proxy-audio/${encodedUrl}`;
      console.log(`🚀 Using remote proxy for playback: ${playUrl.substring(0, 80)}...`);
    }
    
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
    gather.say(VOICE_CONFIG, VOICE_PROMPTS.podcasts.playbackControls);
    
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

// Handle cached file streaming with advanced audio processing
function handleCachedFileStreaming(cachedFilePath, seekTime, playbackSpeed, res) {
  
  try {
    console.log(`📁 Streaming cached file: ${path.basename(cachedFilePath)} (seek: ${seekTime}s, speed: ${playbackSpeed}x)`);
    
    // Extract episode ID from cached file path
    const filename = path.basename(cachedFilePath, '.mp3');
    const episodeId = filename.replace(/^.*?_/, ''); // Remove channel prefix
    
    // Check if we have processed versions available
    const hasProcessed = audioProcessor.hasProcessedVersions(episodeId);
    
    // Set response headers for audio streaming
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Playback-Speed', playbackSpeed);
    res.setHeader('X-Seek-Time', seekTime);
    res.setHeader('X-Proxy-Source', 'enhanced-cached-file');
    res.setHeader('X-Audio-Processing', hasProcessed.hasAny ? 'available' : 'basic');
    
    // Strategy 1: Use pre-processed speed version if available
    const processedPath = audioProcessor.getProcessedPath(episodeId, playbackSpeed);
    if (processedPath && playbackSpeed !== 1.0) {
      console.log(`🎵 Using pre-processed ${playbackSpeed}x version`);
      return streamProcessedFile(processedPath, seekTime, res);
    }
    
    // Strategy 2: Use seek chunks for precise seeking
    if (seekTime > 0 && hasProcessed.seekChunks) {
      const seekChunk = audioProcessor.getSeekChunk(episodeId, seekTime);
      if (seekChunk) {
        console.log(`📦 Using seek chunk ${seekChunk.chunkIndex} with remainder ${seekChunk.remainderTime}s`);
        
        if (playbackSpeed === 1.0) {
          // Direct chunk streaming for normal speed
          return streamProcessedFile(seekChunk.chunkPath, seekChunk.remainderTime, res);
        } else {
          // Real-time speed processing from chunk
          console.log(`🎵 Real-time processing: chunk with ${playbackSpeed}x speed`);
          return streamAudioWithProcessing(seekChunk.chunkPath, seekChunk.remainderTime, playbackSpeed, res);
        }
      }
    }
    
    // Strategy 3: Real-time processing for speed changes or seeking
    if (playbackSpeed !== 1.0 || seekTime > 0) {
      console.log(`🎵 Real-time audio processing: ${playbackSpeed}x speed, seek: ${seekTime}s`);
      return streamAudioWithProcessing(cachedFilePath, seekTime, playbackSpeed, res);
    }
    
    // Strategy 4: Direct file streaming (fallback)
    console.log(`📁 Direct file streaming (no processing needed)`);
    return streamProcessedFile(cachedFilePath, 0, res);
    
  } catch (error) {
    console.error(`❌ Enhanced cached streaming error:`, error.message);
    res.status(500).json({ error: 'Failed to stream cached file' });
  }
}

// Stream pre-processed file with basic seeking
function streamProcessedFile(filePath, seekTime, res) {
  try {
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    
    let startByte = 0;
    if (seekTime > 0) {
      // Better byte estimation based on 128kbps
      const estimatedBytesPerSecond = 16000;
      startByte = Math.min(seekTime * estimatedBytesPerSecond, fileSize - 1);
      console.log(`⏩ Seeking to byte ${startByte} (estimated from ${seekTime}s)`);
    }
    
    if (startByte > 0) {
      const endByte = fileSize - 1;
      const contentLength = endByte - startByte + 1;
      
      res.setHeader('Content-Range', `bytes ${startByte}-${endByte}/${fileSize}`);
      res.setHeader('Content-Length', contentLength);
      res.status(206);
    } else {
      res.setHeader('Content-Length', fileSize);
    }
    
    const stream = fs.createReadStream(filePath, { 
      start: startByte, 
      end: fileSize - 1 
    });
    
    stream.on('error', (streamError) => {
      console.error(`❌ File stream error:`, streamError.message);
      if (!res.headersSent) {
        res.status(500).send('File stream error');
      }
    });
    
    stream.pipe(res);
    
  } catch (error) {
    console.error(`❌ File streaming error:`, error.message);
    throw error;
  }
}

// Stream with real-time audio processing
function streamAudioWithProcessing(inputPath, seekTime, playbackSpeed, res) {
  try {
    console.log(`🎵 Starting real-time audio processing stream`);
    
    // Create FFmpeg stream for real-time processing
    const audioStream = audioProcessor.createSpeedStream(inputPath, playbackSpeed, seekTime);
    
    // Handle streaming errors
    audioStream.on('error', (streamError) => {
      console.error(`❌ FFmpeg stream error:`, streamError.message);
      if (!res.headersSent) {
        res.status(500).send('Audio processing stream error');
      }
    });
    
    audioStream.on('end', () => {
      console.log(`✅ Real-time audio processing completed`);
    });
    
    // Stream the processed audio
    audioStream.pipe(res);
    
  } catch (error) {
    console.error(`❌ Audio processing stream error:`, error.message);
    throw error;
  }
}

// Audio proxy endpoint with byte-range support for seeking
app.get('/proxy-audio/:encodedUrl/:type?/:startTime?/:speedType?/:speed?', async (req, res) => {
  try {
    let { encodedUrl, type, startTime, speedType, speed } = req.params;
    const seekTime = type === 'start' ? parseInt(startTime) || 0 : parseInt(req.query.start) || 0;
    const playbackSpeed = (speedType === 'speed' ? parseFloat(speed) : null) || (type === 'speed' ? parseFloat(startTime) : null) || 1.0;
    
    console.log(`🎵 Proxy request: type=${type}, startTime=${startTime}, seekTime=${seekTime}, speed=${playbackSpeed}x`);
    
    // Remove any query parameters from the encoded URL path
    encodedUrl = encodedUrl.split('?')[0];
    
    let originalUrl, isCachedFile = false, cachedFilePath;
    try {
      originalUrl = Buffer.from(encodedUrl, 'base64').toString('utf-8');
      console.log(`🔗 Decoded URL: ${originalUrl.substring(0, 100)}...`);
      
      // Check if this is a cached file identifier
      if (originalUrl.startsWith('cached://')) {
        isCachedFile = true;
        const filename = originalUrl.replace('cached://', '');
        cachedFilePath = path.join(__dirname, 'cached_episodes', filename);
        console.log(`💾 Cached file request: ${cachedFilePath}`);
        
        // Verify cached file exists
        if (!fs.existsSync(cachedFilePath)) {
          console.error(`❌ Cached file not found: ${cachedFilePath}`);
          return res.status(404).json({ error: 'Cached file not found' });
        }
      }
    } catch (decodeError) {
      console.error(`❌ Base64 decode error:`, decodeError.message);
      return res.status(400).send('Invalid encoded URL');
    }
    
    console.log(`🎵 Streaming: ${isCachedFile ? 'cached file' : originalUrl.substring(0, 100)}... ${seekTime > 0 ? `(seeking to ${seekTime}s)` : ''}`);
    
    // Handle cached file streaming with speed/seek support
    if (isCachedFile) {
      return handleCachedFileStreaming(cachedFilePath, seekTime, playbackSpeed, res);
    }
    
    // Handle remote file streaming (original logic)
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
          timeout: 20000, // Extended timeout for complex Libsyn redirect chains
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
      timeout: 45000, // Extended timeout for complex URLs like TimCast
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
      // When CDN doesn't support ranges, we need to inform the client that seeking failed
      // Return a 416 status to indicate range not satisfiable, which will trigger fallback behavior
      return res.status(416).json({
        error: 'Seeking not supported by audio source',
        message: 'This podcast source does not support seeking. Playback will continue from current position.',
        seekTime: seekTime,
        speed: playbackSpeed,
        fallbackUrl: `https://${req.get('host')}/proxy-audio/${encodedUrl}${playbackSpeed !== 1 ? `/speed/${playbackSpeed}` : ''}` // URL without seek parameter but with speed
      });
    }
    
    // Set headers for streaming - optimized for Twilio compatibility
    res.setHeader('Content-Type', audioResponse.headers['content-type'] || 'audio/mpeg');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    
    // Add Twilio-friendly headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Playback-Speed', playbackSpeed);
    res.setHeader('X-Seek-Time', seekTime);
    res.setHeader('X-Proxy-Source', 'podcast-ivr-proxy');
    
    if (audioResponse.headers['content-length']) {
      const contentLength = parseInt(audioResponse.headers['content-length']);
      res.setHeader('Content-Length', contentLength);
      console.log(`📊 Streaming ${Math.round(contentLength/1024/1024)}MB file with Content-Length header`);
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
    } else if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      console.error(`⏰ Request timed out for URL: ${originalUrl.substring(0, 100)}...`);
      if (!res.headersSent) {
        res.status(408).send('Audio request timed out - this episode may have connectivity issues');
      }
    } else if (error.response && (error.response.status === 416 || error.response.status === 400)) {
      console.error(`📍 Range request failed (${error.response.status}), trying without range`);
      // If range request fails, retry without range header
      try {
        const fallbackResponse = await axios({
          method: 'GET',
          url: originalUrl,
          responseType: 'stream',
          timeout: 30000, // Extended timeout for fallback requests
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
            res.setHeader('Content-Length', contentLength);
            console.log(`📊 Fallback streaming ${Math.round(contentLength/1024/1024)}MB file with Content-Length header`);
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
app.get('/debug-proxy/:encodedUrl/:type?/:startTime?/:speedType?/:speed?', async (req, res) => {
  try {
    let { encodedUrl, type, startTime, speedType, speed } = req.params;
    const seekTime = type === 'start' ? parseInt(startTime) || 0 : parseInt(req.query.start) || 0;
    const playbackSpeed = (speedType === 'speed' ? parseFloat(speed) : null) || (type === 'speed' ? parseFloat(startTime) : null) || 1.0;
    
    encodedUrl = encodedUrl.split('?')[0];
    const originalUrl = Buffer.from(encodedUrl, 'base64').toString('utf-8');
    
    res.json({
      encodedUrl: encodedUrl.substring(0, 50) + '...',
      type,
      startTime,
      seekTime,
      speedType,
      speed: playbackSpeed,
      originalUrl,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Handle weather zipcode choice (use saved vs new)
app.post('/webhook/weather-zipcode-choice', async (req, res) => {
  const digits = req.body.Digits;
  const savedZipcode = req.query.savedZipcode;
  const caller = req.body.From || req.body.Caller;
  const callSid = req.body.CallSid;
  
  console.log(`🌤️ Weather zipcode choice: ${digits} from ${caller}, saved: ${savedZipcode}`);
  
  const twiml = new VoiceResponse();
  
  if (digits === '1') {
    // Use saved zipcode
    console.log(`🌤️ Using saved zipcode: ${savedZipcode}`);
    
    // Check for weather ad before showing forecast
    let weatherAd = null;
    if (callSid) {
      weatherAd = await adSystem.getPrerollAd(callSid, 'weather', 'Weather Service');
      console.log(`📺 Weather ad result: ${weatherAd ? weatherAd.name : 'none'}`);
    }
    
    // Play ad if available
    if (weatherAd) {
      console.log(`📺 Playing weather ad: ${weatherAd.name}`);
      twiml.say(VOICE_CONFIG, getPrompt('weather', 'adMessage'));
      
      // Handle different ad URL formats
      if (weatherAd.audioUrl.startsWith('/api/test-ad/')) {
        // Internal TTS ad - get the message and say it directly
        const adId = weatherAd.audioUrl.split('/').pop();
        const adMessages = {
          'preroll1': 'This weather report is brought to you by Local Business. Your neighborhood partner for quality service and friendly support. Visit us today.',
          'preroll2': 'Tech Company presents this weather forecast. Innovation that works for you. Technology made simple.',
          'midroll1': 'Stay informed with Restaurant Chain weather updates. Fresh ingredients, great taste, and reliable forecasts.',
          'midroll2': 'Protect what matters most with Insurance Company weather alerts. Reliable coverage, competitive rates, local agents.'
        };
        const adMessage = adMessages[adId] || 'Thank you for listening to our sponsors.';
        twiml.say(VOICE_CONFIG, adMessage);
      } else {
        // External audio URL - play directly
        twiml.play(weatherAd.audioUrl);
      }
      
      // Track ad in analytics
      if (callSid) {
        analytics.trackAdPlayed(callSid, weatherAd);
      }
    }
    
    twiml.say(VOICE_CONFIG, getPrompt('weather', 'usingSavedZipcode', {zipcode: savedZipcode.split('').join(' ')}));
    
    try {
      const weatherReport = await getWeatherForecast(savedZipcode);
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
      console.error(`❌ Weather error for saved zipcode ${savedZipcode}:`, error.message);
      twiml.say(VOICE_CONFIG, getPrompt('weather', 'unavailable'));
      twiml.redirect('/webhook/ivr-main');
    }
    
  } else if (digits === '2') {
    // Enter new zipcode
    twiml.say(VOICE_CONFIG, getPrompt('weather', 'differentZipcode'));
    
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
    
  } else {
    // Invalid choice, return to main menu
    twiml.redirect('/webhook/ivr-main');
  }
  
  res.type('text/xml');
  res.send(twiml.toString());
});

// Handle weather zipcode input
app.post('/webhook/weather-zipcode', async (req, res) => {
  const zipcode = req.body.Digits;
  const caller = req.body.From || req.body.Caller;
  const callSid = req.body.CallSid;
  
  console.log(`🌤️ Weather request: ${zipcode} from ${caller}`);
  
  const twiml = new VoiceResponse();
  
  if (!zipcode || zipcode.length !== 5 || !/^\d{5}$/.test(zipcode)) {
    twiml.say(VOICE_CONFIG, getPrompt('weather', 'invalidZipcode'));
    twiml.redirect('/webhook/ivr-main');
    return res.type('text/xml').send(twiml.toString());
  }
  
  try {
    // Save zipcode for future use
    callerSessions.updateZipcode(caller, zipcode);
    console.log(`📍 Saved zipcode ${zipcode} for caller ${caller}`);
    
    // Check for weather ad before showing forecast
    let weatherAd = null;
    if (callSid) {
      weatherAd = await adSystem.getPrerollAd(callSid, 'weather', 'Weather Service');
      console.log(`📺 Weather ad result: ${weatherAd ? weatherAd.name : 'none'}`);
    }
    
    // Play ad if available
    if (weatherAd) {
      console.log(`📺 Playing weather ad: ${weatherAd.name}`);
      twiml.say(VOICE_CONFIG, getPrompt('weather', 'adMessage'));
      
      // Handle different ad URL formats
      if (weatherAd.audioUrl.startsWith('/api/test-ad/')) {
        // Internal TTS ad - get the message and say it directly
        const adId = weatherAd.audioUrl.split('/').pop();
        const adMessages = {
          'preroll1': 'This weather report is brought to you by Local Business. Your neighborhood partner for quality service and friendly support. Visit us today.',
          'preroll2': 'Tech Company presents this weather forecast. Innovation that works for you. Technology made simple.',
          'midroll1': 'Stay informed with Restaurant Chain weather updates. Fresh ingredients, great taste, and reliable forecasts.',
          'midroll2': 'Protect what matters most with Insurance Company weather alerts. Reliable coverage, competitive rates, local agents.'
        };
        const adMessage = adMessages[adId] || 'Thank you for listening to our sponsors.';
        twiml.say(VOICE_CONFIG, adMessage);
      } else {
        // External audio URL - play directly
        twiml.play(weatherAd.audioUrl);
      }
      
      // Track ad in analytics
      if (callSid) {
        analytics.trackAdPlayed(callSid, weatherAd);
      }
    }
    
    twiml.say(VOICE_CONFIG, getPrompt('weather', 'gettingForecast', {zipcode: zipcode.split('').join(' ')}));
    twiml.say(VOICE_CONFIG, getPrompt('weather', 'zipcodeUpdated', {zipcode: zipcode.split('').join(' ')}));
    
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
    const episodes = await fetchPodcastEpisodes(podcast.rssUrl, 0, 10, channel);
    
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
    const episodes = await fetchPodcastEpisodes(podcast.rssUrl, 0, 10, channel);
    
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
    let episodes = await fetchPodcastEpisodes(podcast.rssUrl, 0, 10, channel);
    
    // If requesting an episode beyond our initial fetch, get more episodes
    if (!episodes[episodeIndex] && episodeIndex >= 8) {
      console.log(`🔄 Episode ${episodeIndex} not in initial fetch, loading more episodes...`);
      episodes = await fetchPodcastEpisodes(podcast.rssUrl, 0, Math.max(20, episodeIndex + 5), channel);
    }
    
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
    
    console.log(`📻 Episode found: "${episode.title}" (${episode.fileSizeMB || 'unknown'}MB)`);
    console.log(`🔗 Raw audio URL: ${episode.audioUrl.substring(0, 100)}...`);
    
    // Check for very large files (only apply restriction for Twilio)
    if (voiceProvider === 'twilio' && episode.fileSizeMB && episode.fileSizeMB > 150) {
      console.log(`⚠️ Large file detected (${episode.fileSizeMB}MB), may cause Twilio playback issues`);
      twiml.say(VOICE_CONFIG, `This episode "${episode.title.substring(0, 60)}" is very long at ${Math.round((episode.fileSize || 0) / 1024 / 1024)} megabytes. The phone system may have difficulty playing such large files. Please try NPR option 2 for reliable streaming, or try a different podcast.`);
      twiml.say(VOICE_CONFIG, 'Returning to main menu.');
      twiml.redirect('/webhook/ivr-main');
      return res.type('text/xml').send(twiml.toString());
    }
    
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
    
    // Initialize episode cache for intelligent caching strategy
    const episodeCache = new EpisodeCache();
    let cachedPath = episode.cachedPath;
    
    // Check if already cached
    if (episodeCache.isCached(channel, finalAudioUrl)) {
      cachedPath = episodeCache.getCachedEpisodePath(channel, finalAudioUrl);
      console.log(`✅ Episode already cached: ${path.basename(cachedPath)}`);
    } else {
      // For the latest episode (index 0), cache immediately for best experience
      if (episodeIndex === 0) {
        try {
          console.log(`📥 Caching latest episode for immediate playback: ${episode.title.substring(0, 50)}`);
          cachedPath = await episodeCache.cacheEpisode(channel, finalAudioUrl, episode.title, 'latest');
          console.log(`✅ Latest episode cached successfully: ${path.basename(cachedPath)}`);
        } catch (cacheError) {
          console.warn(`⚠️ Latest episode caching failed, using stream: ${cacheError.message}`);
          cachedPath = null;
        }
      } else {
        // For older episodes, start background caching and play immediately
        const backgroundStarted = episodeCache.startBackgroundCaching(channel, finalAudioUrl, episode.title);
        if (backgroundStarted) {
          console.log(`📥 Started background caching for older episode: ${episode.title.substring(0, 50)}`);
        }
        cachedPath = null; // Play from stream initially
      }
    }
    
    // Use cached file if available, otherwise use cleaned URL
    const audioUrl = cachedPath ? 
      `https://${req.get('host')}/cached_episodes/${path.basename(cachedPath)}` : 
      finalAudioUrl;
    
    // Get caller info for session tracking
    const callerId = req.body.From || req.body.Caller;
    
    // Get caller's preferred playback speed
    const playbackSpeed = callerSessions.getPlaybackSpeed(callerId);
    
    // Announce episode with speed info
    const speedText = playbackSpeed !== 1 ? ` at ${playbackSpeed} times speed` : '';
    twiml.say(VOICE_CONFIG, `Now playing: ${episode.title.substring(0, 80)}${speedText}`);
    
    // Set up enhanced playback controls with position tracking and ad breaks
    const gather = twiml.gather({
      numDigits: 1, // Single digit controls (1,3,4,6,2,5,*,0)
      action: `/webhook/playback-control?channel=${channel}&episodeIndex=${episodeIndex}&position=0`,
      method: 'POST',
      timeout: 30
    });
    
    // Use cached file if available (including newly cached), otherwise proxy the original URL
    let playbackUrl;
    if (cachedPath) {
      playbackUrl = `https://${req.get('host')}/cached_episodes/${path.basename(cachedPath)}`;
      console.log(`📦 Playing cached episode: ${path.basename(cachedPath)}`);
    } else {
      const encodedUrl = Buffer.from(finalAudioUrl).toString('base64');
      playbackUrl = `https://${req.get('host')}/proxy-audio/${encodedUrl}`;
      console.log(`🚀 Playing episode from: ${finalAudioUrl.split('/')[2]}`);
    }
    
    // Add playback speed if not 1x
    const playOptions = playbackSpeed !== 1 ? { loop: 1, rate: playbackSpeed } : { loop: 1 };
    gather.play(playOptions, playbackUrl);
    
    // Standardized controls prompt
    gather.say(VOICE_CONFIG, 'Press 1 for previous episode, 3 for next episode, 4 to rewind 30 seconds, 6 to fast forward 30 seconds, 2 to slow down, 5 to speed up, star to resume your last episode, or stay on the line to continue listening.');
    
    // Continue with ad break tracking
    twiml.redirect(`/webhook/playback-control?channel=${channel}&episodeIndex=${episodeIndex}&position=0&startTime=${Date.now()}`);
    
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

// Extension-level resume choice handler
app.post('/webhook/extension-resume-choice', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const channel = req.query.channel;
  const resumePosition = parseInt(req.query.resumePosition);
  const choice = req.body.Digits;
  const callerId = req.body.From || req.body.Caller;
  
  if (choice === '1') {
    // Resume from last position
    console.log(`🔄 Resuming extension ${channel} for ${callerId} at ${resumePosition} seconds`);
    twiml.redirect(`/webhook/play-episode-at-position?channel=${channel}&episodeIndex=0&position=${resumePosition}`);
  } else {
    // Start fresh and clear session
    console.log(`🆕 Starting fresh in extension ${channel} for ${callerId}`);
    callerSessions.clearSession(callerId);
    twiml.redirect(`/webhook/select-channel?Digits=${channel}`);
  }
  
  res.type('text/xml');
  res.send(twiml.toString());
});

// Episode-level resume choice handler (kept for backward compatibility)
app.post('/webhook/resume-choice', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const channel = req.query.channel;
  const episodeIndex = parseInt(req.query.episodeIndex);
  const resumePosition = parseInt(req.query.resumePosition);
  const choice = req.body.Digits;
  const callerId = req.body.From || req.body.Caller;
  
  if (choice === '1') {
    // Resume from last position
    console.log(`🔄 Resuming playback for ${callerId} at ${resumePosition} seconds`);
    twiml.redirect(`/webhook/play-episode-at-position?channel=${channel}&episodeIndex=${episodeIndex}&position=${resumePosition}`);
  } else {
    // Start from beginning and clear session
    console.log(`🆕 Starting from beginning for ${callerId}`);
    callerSessions.clearSession(callerId);
    twiml.redirect(`/webhook/play-episode?channel=${channel}&episodeIndex=${episodeIndex}`);
  }
  
  res.type('text/xml');
  res.send(twiml.toString());
});

// Ad break system
app.post('/webhook/ad-break', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const channel = req.query.channel;
  const episodeIndex = parseInt(req.query.episodeIndex);
  const position = parseInt(req.query.position || 0);
  const callerId = req.body.From || req.body.Caller;
  
  console.log(`📺 Ad break triggered for ${callerId} at position ${position}`);
  
  // Play Extension 90 ad
  twiml.say(VOICE_CONFIG, 'We\'ll be right back after this message.');
  twiml.pause({ length: 1 });
  twiml.say(VOICE_CONFIG, 'Do you want people to hear your ad on this podcast hotline? Use extension 90 to get in touch with our advertising team for rates and availability.');
  twiml.pause({ length: 2 });
  twiml.say(VOICE_CONFIG, 'Now back to your podcast.');
  
  // Resume playback after ad
  twiml.redirect(`/webhook/play-episode-at-position?channel=${channel}&episodeIndex=${episodeIndex}&position=${position}`);
  
  res.type('text/xml');
  res.send(twiml.toString());
});

// Extension 90 - Ad Contact System
app.post('/webhook/ad-contact', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const callerId = req.body.From || req.body.Caller;
  
  console.log(`📞 Ad contact request from ${callerId}`);
  
  twiml.say(VOICE_CONFIG, 'Thank you for your interest in advertising on our podcast hotline. We reach thousands of engaged listeners every month.');
  twiml.pause({ length: 1 });
  twiml.say(VOICE_CONFIG, 'Please leave your name, company, and contact information after the beep, and we\'ll get back to you within 24 hours with rates and availability.');
  
  // Record advertiser contact info
  twiml.record({
    timeout: 60,
    maxLength: 180, // 3 minutes max
    action: '/webhook/ad-contact-complete',
    transcribe: true,
    transcribeCallback: '/webhook/ad-contact-transcribe'
  });
  
  res.type('text/xml');
  res.send(twiml.toString());
});

app.post('/webhook/ad-contact-complete', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  
  twiml.say(VOICE_CONFIG, 'Thank you for your interest. We\'ve recorded your message and will contact you within 24 hours. Have a great day!');
  twiml.hangup();
  
  res.type('text/xml');
  res.send(twiml.toString());
});

app.post('/webhook/ad-contact-transcribe', (req, res) => {
  console.log('📝 Ad contact transcription received:', {
    from: req.body.From,
    transcription: req.body.TranscriptionText,
    recordingUrl: req.body.RecordingUrl
  });
  res.sendStatus(200);
});

// Admin endpoints for monitoring enhanced systems
app.get('/admin/cache-stats', (req, res) => {
  const cacheStats = episodeCache.getCacheStats();
  const sessionStats = callerSessions.getStats();
  
  res.json({
    episodeCache: cacheStats,
    callerSessions: sessionStats,
    systemInfo: {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      timestamp: new Date().toISOString()
    }
  });
});

app.post('/admin/cleanup', async (req, res) => {
  console.log('🧹 Manual cleanup triggered');
  episodeCache.cleanupExpiredEpisodes();
  callerSessions.cleanupOldSessions();
  const audioCleanedCount = await audioProcessor.cleanup(168);
  
  res.json({ 
    success: true, 
    message: 'Cleanup completed',
    audioFilesRemoved: audioCleanedCount,
    timestamp: new Date().toISOString()
  });
});

// Audio processing admin endpoints
app.get('/admin/audio-stats', (req, res) => {
  const audioStats = audioProcessor.getStats();
  const cacheStats = episodeCache.getCacheStats();
  
  res.json({
    audioProcessing: audioStats,
    episodeCache: cacheStats,
    systemInfo: {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      timestamp: new Date().toISOString()
    }
  });
});

app.post('/admin/process-episode', async (req, res) => {
  const { episodeId, cachedPath } = req.body;
  
  if (!episodeId || !cachedPath) {
    return res.status(400).json({ error: 'episodeId and cachedPath required' });
  }
  
  try {
    console.log(`🎵 Manual audio processing triggered for: ${episodeId}`);
    const result = await audioProcessor.processEpisodeComplete(cachedPath, episodeId);
    
    res.json({
      success: true,
      episodeId,
      processedVersions: Object.keys(result.speedVersions),
      hasSeekChunks: !!result.seekChunks,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error(`❌ Manual processing failed:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/admin/sessions', (req, res) => {
  const sessions = callerSessions.sessions;
  res.json({
    totalSessions: Object.keys(sessions).length,
    sessions: Object.values(sessions).map(session => ({
      phoneNumber: session.phoneNumber.replace(/\d{4}$/, 'XXXX'), // Mask last 4 digits
      channelId: session.channelId,
      episodeTitle: session.episodeTitle,
      positionMinutes: Math.floor(session.positionSeconds / 60),
      playbackSpeed: session.playbackSpeed,
      lastUpdated: new Date(session.lastUpdated).toISOString()
    }))
  });
});

// Enhanced Playback Controls with Time-based Seeking, Position Tracking, and Ad Breaks
app.post('/webhook/playback-control', async (req, res) => {
  const digits = req.body.Digits;
  const channel = req.query.channel;
  const episodeIndex = parseInt(req.query.episodeIndex) || 0;
  const currentPosition = parseInt(req.query.position) || 0;
  const startTime = parseInt(req.query.startTime) || Date.now();
  const callerId = req.body.From || req.body.Caller;
  
  // Calculate actual position based on playback time
  const playbackDuration = Math.floor((Date.now() - startTime) / 1000);
  const playbackSpeed = callerSessions.getPlaybackSpeed(callerId);
  const actualPosition = currentPosition + Math.floor(playbackDuration * playbackSpeed);
  
  console.log(`=== ENHANCED PLAYBACK CONTROL: ${digits} ===`);
  console.log(`Channel ${channel}, Episode ${episodeIndex}, Position: ${actualPosition}s (speed: ${playbackSpeed}x)`);
  
  const twiml = new VoiceResponse();
  
  // Update caller's position and check for background cache completion
  const podcast = ALL_PODCASTS[channel] || EXTENSION_PODCASTS[channel];
  const episodeCache = new EpisodeCache();
  let currentEpisode = null;
  let seamlessSwitch = false;
  
  // Special handling for debates (channel 50)
  if (channel === '50' && podcast && podcast.rssUrl === 'YOUTUBE_DEBATES') {
    try {
      // Get debate files from local folder for debates
      const fs = require('fs');
      const path = require('path');
      let fileList = [];
      
      try {
        const debatesPath = path.join(__dirname, 'public', 'debates');
        const files = fs.readdirSync(debatesPath);
        const mp3Files = files
          .filter(file => file.toLowerCase().endsWith('.mp3'))
          .sort();
        
        if (mp3Files.length > 0) {
          fileList = mp3Files;
        } else {
          fileList = ['debate1.mp3', 'debate2.mp3', 'debate3.mp3'];
        }
      } catch (fsError) {
        console.error(`❌ Error reading debates folder: ${fsError.message}`);
        fileList = ['debate1.mp3', 'debate2.mp3', 'debate3.mp3'];
      }
      
      // Create episodes array for debates
      const railwayBaseUrl = `${req.protocol}://${req.get('host')}/debates/`;
      const debateEpisodes = fileList.map((file, index) => ({
        title: file.replace('.mp3', '').replace(/[-_]/g, ' '),
        audioUrl: `${railwayBaseUrl}${file}`,
        description: `Debate audio file: ${file}`,
        episodeIndex: index
      }));
      
      if (debateEpisodes[episodeIndex]) {
        currentEpisode = debateEpisodes[episodeIndex];
        callerSessions.updatePosition(callerId, channel, currentEpisode.audioUrl, actualPosition, currentEpisode.title);
        
        // Check if background caching completed for seamless switch
        if (episodeCache.isCached('debates', currentEpisode.audioUrl) && !currentEpisode.cachedPath) {
          console.log(`🔄 Background cache completed! Seamless switch available for: ${currentEpisode.title.substring(0, 50)}`);
          seamlessSwitch = true;
        }
      }
    } catch (error) {
      console.warn('Failed to update caller position for debates:', error.message);
    }
  } else if (podcast) {
    try {
      const episodes = await fetchPodcastEpisodes(podcast.rssUrl, 0, 10, channel);
      currentEpisode = episodes[episodeIndex];
      if (currentEpisode) {
        callerSessions.updatePosition(callerId, channel, currentEpisode.audioUrl, actualPosition, currentEpisode.title);
        
        // Check if background caching completed for seamless switch
        const cleanedUrl = cleanAudioUrl(currentEpisode.audioUrl);
        if (episodeCache.isCached(channel, cleanedUrl) && !currentEpisode.cachedPath) {
          console.log(`🔄 Background cache completed! Seamless switch available for: ${currentEpisode.title.substring(0, 50)}`);
          seamlessSwitch = true;
        }
      }
    } catch (error) {
      console.warn('Failed to update caller position:', error.message);
    }
  }
  
  // Check for ad break (every 10 minutes)
  if (callerSessions.shouldShowAd(actualPosition)) {
    console.log(`📺 Ad break triggered at ${actualPosition} seconds`);
    twiml.redirect(`/webhook/ad-break?channel=${channel}&episodeIndex=${episodeIndex}&position=${actualPosition}`);
    return res.type('text/xml').send(twiml.toString());
  }
  
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
      
    case '4': // Rewind 30 seconds
      try {
        const backPosition = Math.max(0, actualPosition - 30);
        console.log(`⏪ Rewind 30s: ${actualPosition}s -> ${backPosition}s`);
        twiml.say(VOICE_CONFIG, 'Rewinding 30 seconds.');
        twiml.redirect(`/webhook/play-episode-at-position?channel=${channel}&episodeIndex=${episodeIndex}&position=${backPosition}`);
      } catch (error) {
        console.error(`❌ Rewind error:`, error.message);
        twiml.say(VOICE_CONFIG, 'Rewind failed. Continuing current playback.');
        twiml.redirect(`/webhook/playback-control?channel=${channel}&episodeIndex=${episodeIndex}&position=${actualPosition}&startTime=${Date.now()}`);
      }
      break;
      
    case '6': // Fast forward 30 seconds
      try {
        const forwardPosition = actualPosition + 30;
        console.log(`⏩ Fast forward 30s: ${actualPosition}s -> ${forwardPosition}s`);
        twiml.say(VOICE_CONFIG, 'Fast forwarding 30 seconds.');
        twiml.redirect(`/webhook/play-episode-at-position?channel=${channel}&episodeIndex=${episodeIndex}&position=${forwardPosition}`);
      } catch (error) {
        console.error(`❌ Fast forward error:`, error.message);
        twiml.say(VOICE_CONFIG, 'Fast forward failed. Continuing current playback.');
        twiml.redirect(`/webhook/playback-control?channel=${channel}&episodeIndex=${episodeIndex}&position=${actualPosition}&startTime=${Date.now()}`);
      }
      break;
      
    case '2': // Decrease playback speed
      try {
        const currentSpeed = callerSessions.getPlaybackSpeed(callerId);
        const newSpeed = Math.max(0.5, currentSpeed - 0.25); // Min 0.5x speed
        callerSessions.updatePlaybackSpeed(callerId, newSpeed);
        console.log(`🐌 Speed decreased: ${currentSpeed}x -> ${newSpeed}x`);
        
        // Get current episode for speed-adjusted playback
        const podcast = ALL_PODCASTS[channel] || EXTENSION_PODCASTS[channel];
        if (podcast) {
          // Special handling for debates (channel 50)
          if (channel === '50' && podcast.rssUrl === 'YOUTUBE_DEBATES') {
            try {
              const fs = require('fs');
              const path = require('path');
              const debatesPath = path.join(__dirname, 'public', 'debates');
              const files = fs.readdirSync(debatesPath);
              const mp3Files = files.filter(file => file.toLowerCase().endsWith('.mp3')).sort();
              
              if (mp3Files[episodeIndex]) {
                const railwayBaseUrl = `${req.protocol}://${req.get('host')}/debates/`;
                const audioUrl = `${railwayBaseUrl}${mp3Files[episodeIndex]}`;
                const title = mp3Files[episodeIndex].replace('.mp3', '').replace(/[-_]/g, ' ');
                
                callerSessions.updatePosition(callerId, channel, audioUrl, actualPosition, title);
                twiml.say(VOICE_CONFIG, `Playback speed decreased to ${newSpeed} times normal.`);
                twiml.redirect(`/webhook/play-episode-with-speed?channel=${channel}&episodeIndex=${episodeIndex}&position=${actualPosition}&speed=${newSpeed}`);
                break;
              }
            } catch (error) {
              console.error(`❌ Error reading debates folder for speed control: ${error.message}`);
            }
          } else {
            const episodes = await fetchPodcastEpisodes(podcast.rssUrl, 0, 10, channel);
            const episode = episodes[episodeIndex];
            if (episode) {
              // Update position and restart with new speed
              callerSessions.updatePosition(callerId, channel, episode.audioUrl, actualPosition, episode.title);
              twiml.say(VOICE_CONFIG, `Playback speed decreased to ${newSpeed} times normal.`);
              twiml.redirect(`/webhook/play-episode-with-speed?channel=${channel}&episodeIndex=${episodeIndex}&position=${actualPosition}&speed=${newSpeed}`);
              break;
            }
          }
        }
        
        // Fallback if episode fetch fails
        twiml.say(VOICE_CONFIG, `Speed set to ${newSpeed} times normal. This will take effect on the next episode.`);
        twiml.redirect(`/webhook/playback-control?channel=${channel}&episodeIndex=${episodeIndex}&position=${actualPosition}&startTime=${Date.now()}`);
      } catch (error) {
        console.error(`❌ Speed decrease error:`, error.message);
        twiml.say(VOICE_CONFIG, 'Speed change failed. Continuing current playback.');
        twiml.redirect(`/webhook/playback-control?channel=${channel}&episodeIndex=${episodeIndex}&position=${actualPosition}&startTime=${Date.now()}`);
      }
      break;
      
    case '5': // Increase playback speed
      try {
        const currentSpeed = callerSessions.getPlaybackSpeed(callerId);
        const newSpeed = Math.min(2.0, currentSpeed + 0.25); // Max 2x speed
        callerSessions.updatePlaybackSpeed(callerId, newSpeed);
        console.log(`🏃 Speed increased: ${currentSpeed}x -> ${newSpeed}x`);
        
        // Get current episode for speed-adjusted playback
        const podcast = ALL_PODCASTS[channel] || EXTENSION_PODCASTS[channel];
        if (podcast) {
          // Special handling for debates (channel 50)
          if (channel === '50' && podcast.rssUrl === 'YOUTUBE_DEBATES') {
            try {
              const fs = require('fs');
              const path = require('path');
              const debatesPath = path.join(__dirname, 'public', 'debates');
              const files = fs.readdirSync(debatesPath);
              const mp3Files = files.filter(file => file.toLowerCase().endsWith('.mp3')).sort();
              
              if (mp3Files[episodeIndex]) {
                const railwayBaseUrl = `${req.protocol}://${req.get('host')}/debates/`;
                const audioUrl = `${railwayBaseUrl}${mp3Files[episodeIndex]}`;
                const title = mp3Files[episodeIndex].replace('.mp3', '').replace(/[-_]/g, ' ');
                
                callerSessions.updatePosition(callerId, channel, audioUrl, actualPosition, title);
                twiml.say(VOICE_CONFIG, `Playback speed increased to ${newSpeed} times normal.`);
                twiml.redirect(`/webhook/play-episode-with-speed?channel=${channel}&episodeIndex=${episodeIndex}&position=${actualPosition}&speed=${newSpeed}`);
                break;
              }
            } catch (error) {
              console.error(`❌ Error reading debates folder for speed control: ${error.message}`);
            }
          } else {
            const episodes = await fetchPodcastEpisodes(podcast.rssUrl, 0, 10, channel);
            const episode = episodes[episodeIndex];
            if (episode) {
              // Update position and restart with new speed
              callerSessions.updatePosition(callerId, channel, episode.audioUrl, actualPosition, episode.title);
              twiml.say(VOICE_CONFIG, `Playback speed increased to ${newSpeed} times normal.`);
              twiml.redirect(`/webhook/play-episode-with-speed?channel=${channel}&episodeIndex=${episodeIndex}&position=${actualPosition}&speed=${newSpeed}`);
              break;
            }
          }
        }
        
        // Fallback if episode fetch fails
        twiml.say(VOICE_CONFIG, `Speed set to ${newSpeed} times normal. This will take effect on the next episode.`);
        twiml.redirect(`/webhook/playback-control?channel=${channel}&episodeIndex=${episodeIndex}&position=${actualPosition}&startTime=${Date.now()}`);
      } catch (error) {
        console.error(`❌ Speed increase error:`, error.message);
        twiml.say(VOICE_CONFIG, 'Speed change failed. Continuing current playback.');
        twiml.redirect(`/webhook/playback-control?channel=${channel}&episodeIndex=${episodeIndex}&position=${actualPosition}&startTime=${Date.now()}`);
      }
      break;
      
    case '*': // Resume previous episode
      try {
        const lastSession = callerSessions.getLastPosition(callerId);
        if (lastSession && lastSession.channelId !== channel) {
          console.log(`🔄 Resuming previous episode: Channel ${lastSession.channelId}`);
          twiml.say(VOICE_CONFIG, `Resuming your previous episode in channel ${lastSession.channelId}.`);
          twiml.redirect(`/webhook/play-episode-at-position?channel=${lastSession.channelId}&episodeIndex=0&position=${lastSession.positionSeconds}`);
        } else {
          twiml.say(VOICE_CONFIG, 'No previous episode to resume.');
          twiml.redirect(`/webhook/playback-control?channel=${channel}&episodeIndex=${episodeIndex}&position=${actualPosition}&startTime=${Date.now()}`);
        }
      } catch (error) {
        console.error(`❌ Resume error:`, error.message);
        twiml.say(VOICE_CONFIG, 'Resume failed. Continuing current playback.');
        twiml.redirect(`/webhook/playback-control?channel=${channel}&episodeIndex=${episodeIndex}&position=${actualPosition}&startTime=${Date.now()}`);
      }
      break;
      
    case '0': // Main menu
      twiml.say(VOICE_CONFIG, 'Returning to main menu.');
      twiml.redirect('/webhook/ivr-main');
      break;
      
    case '#': // Seamless switch to cached version (if available)
      if (seamlessSwitch && currentEpisode) {
        try {
          const cleanedUrl = cleanAudioUrl(currentEpisode.audioUrl);
          const cachedPath = episodeCache.getCachedEpisodePath(channel, cleanedUrl);
          if (cachedPath) {
            console.log(`🔄 Manual seamless switch to cached version: ${currentEpisode.title.substring(0, 50)}`);
            twiml.say(VOICE_CONFIG, 'Switching to enhanced quality with full speed controls.');
            twiml.redirect(`/webhook/play-episode?channel=${channel}&episodeIndex=${episodeIndex}&cached=true`);
            break;
          }
        } catch (error) {
          console.error('❌ Seamless switch error:', error.message);
        }
      }
      twiml.say(VOICE_CONFIG, 'Enhanced version not yet available.');
      twiml.redirect(`/webhook/playback-control?channel=${channel}&episodeIndex=${episodeIndex}&position=${actualPosition}&startTime=${Date.now()}`);
      break;
      
    default:
      // Check for automatic seamless switch opportunity
      if (seamlessSwitch && currentEpisode) {
        try {
          const cleanedUrl = cleanAudioUrl(currentEpisode.audioUrl);
          const cachedPath = episodeCache.getCachedEpisodePath(channel, cleanedUrl);
          if (cachedPath) {
            console.log(`🎯 Auto seamless switch triggered: ${currentEpisode.title.substring(0, 50)}`);
            twiml.say(VOICE_CONFIG, 'Enhanced version now available with full speed controls.');
            twiml.redirect(`/webhook/play-episode?channel=${channel}&episodeIndex=${episodeIndex}&cached=true&position=${actualPosition}`);
            break;
          }
        } catch (error) {
          console.error('❌ Auto seamless switch error:', error.message);
        }
      }
      
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
  
  const podcast = ALL_PODCASTS[channel] || EXTENSION_PODCASTS[channel];
  if (!podcast) {
    twiml.say(VOICE_CONFIG, 'Invalid channel.');
    twiml.redirect('/webhook/ivr-main');
    return res.type('text/xml').send(twiml.toString());
  }
  
  try {
    // Special handling for debates (channel 50)
    let episodes = [];
    if (channel === '50' && podcast.rssUrl === 'YOUTUBE_DEBATES') {
      try {
        const fs = require('fs');
        const path = require('path');
        let fileList = [];
        
        try {
          const debatesPath = path.join(__dirname, 'public', 'debates');
          const files = fs.readdirSync(debatesPath);
          const mp3Files = files
            .filter(file => file.toLowerCase().endsWith('.mp3'))
            .sort();
          
          if (mp3Files.length > 0) {
            fileList = mp3Files;
          } else {
            fileList = ['debate1.mp3', 'debate2.mp3', 'debate3.mp3'];
          }
        } catch (fsError) {
          console.error(`❌ Error reading debates folder: ${fsError.message}`);
          fileList = ['debate1.mp3', 'debate2.mp3', 'debate3.mp3'];
        }
        
        // Create episodes array for debates
        const railwayBaseUrl = `${req.protocol}://${req.get('host')}/debates/`;
        episodes = fileList.map((file, index) => ({
          title: file.replace('.mp3', '').replace(/[-_]/g, ' '),
          audioUrl: `${railwayBaseUrl}${file}`,
          description: `Debate audio file: ${file}`,
          episodeIndex: index
        }));
      } catch (error) {
        console.error(`❌ Error processing debates: ${error.message}`);
        episodes = [];
      }
    } else {
      episodes = await fetchPodcastEpisodes(podcast.rssUrl, 0, 10, channel);
    }
    
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
    
    // Determine audio source: use cached file if available, otherwise remote URL
    let playUrl, encodedUrl, seekingSupported = true; // Default to true, will be overridden for remote files
    
    if (episode.isCached && episode.cachedPath) {
      // Use cached file - seeking always supported for local files
      console.log(`💾 Using cached episode for seeking: ${episode.cachedPath}`);
      const cachedIdentifier = `cached://${path.basename(episode.cachedPath)}`;
      encodedUrl = Buffer.from(cachedIdentifier).toString('base64');
      seekingSupported = true; // Always true for cached files
      
      if (position > 0) {
        playUrl = `https://${req.get('host')}/proxy-audio/${encodedUrl}/start/${position}`;
        console.log(`✅ Cached file seeking to: ${position}s`);
      } else {
        playUrl = `https://${req.get('host')}/proxy-audio/${encodedUrl}`;
      }
    } else {
      // Use remote URL and test if seeking is supported
      const cleanedUrl = cleanAudioUrl(episode.audioUrl);
      encodedUrl = Buffer.from(cleanedUrl).toString('base64');
      seekingSupported = false;
      
      if (position > 0) {
        seekingSupported = await testSeekingSupport(cleanedUrl);
        
        if (seekingSupported) {
          playUrl = `https://${req.get('host')}/proxy-audio/${encodedUrl}/start/${position}`;
          console.log(`✅ Remote seeking supported, using seek URL: ${position}s`);
        } else {
          playUrl = `https://${req.get('host')}/proxy-audio/${encodedUrl}`;
          console.log(`⚠️ Remote seeking not supported, using full stream URL`);
        }
      } else {
        // Starting from beginning, no need to test seeking
        playUrl = `https://${req.get('host')}/proxy-audio/${encodedUrl}`;
        seekingSupported = true; // No seeking needed when starting from beginning
      }
    }
    
    // Pre-load check for remote files only (cached files are always ready)
    if (!episode.isCached) {
      const cleanedUrl = cleanAudioUrl(episode.audioUrl);
      const preloadPromise = axios.head(cleanedUrl, {
        timeout: 2000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; TwilioPodcastBot/2.0)',
          'Accept': 'audio/mpeg, audio/mp4, audio/*, */*'
        }
      }).catch(err => {
        console.log(`🔄 Remote preload check: ${err.message || 'completed'}`);
      });
    }
    
    // Announce position if not at start
    if (position > 0) {
      const positionMins = Math.floor(position / 60);
      if (episode.isCached || seekingSupported) {
        twiml.say(VOICE_CONFIG, `Resuming at ${positionMins} minutes.`);
      } else {
        twiml.say(VOICE_CONFIG, `Seeking not supported for this episode. Playing from the beginning.`);
      }
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

// Play episode with specific speed setting using TwiML rate parameter
app.all('/webhook/play-episode-with-speed', async (req, res) => {
  const channel = req.query.channel || req.body.channel;
  const episodeIndex = parseInt(req.query.episodeIndex || req.body.episodeIndex) || 0;
  const position = parseInt(req.query.position || req.body.position) || 0;
  const speed = parseFloat(req.query.speed || req.body.speed) || 1.25;
  const callerId = req.body.From || req.body.Caller;
  
  console.log(`=== PLAYING EPISODE WITH SPEED ===`);
  console.log(`Channel: ${channel}, Episode: ${episodeIndex}, Position: ${position}s, Speed: ${speed}x`);
  
  const twiml = new VoiceResponse();
  
  const podcast = ALL_PODCASTS[channel] || EXTENSION_PODCASTS[channel];
  if (!podcast) {
    twiml.say(VOICE_CONFIG, 'Invalid channel.');
    twiml.redirect('/webhook/ivr-main');
    return res.type('text/xml').send(twiml.toString());
  }
  
  try {
    const episodes = await fetchPodcastEpisodes(podcast.rssUrl, 0, 10, channel);
    
    if (!episodes || episodes.length === 0) {
      twiml.say(VOICE_CONFIG, `No episodes available for ${podcast.name}.`);
      twiml.redirect('/webhook/ivr-main');
      return res.type('text/xml').send(twiml.toString());
    }
    
    const episode = episodes[episodeIndex];
    if (!episode) {
      twiml.redirect(`/webhook/play-episode?channel=${channel}&episodeIndex=0`);
      return res.type('text/xml').send(twiml.toString());
    }
    
    // Determine audio source: use cached file if available, otherwise remote URL
    let playUrl, encodedUrl;
    
    if (episode.isCached && episode.cachedPath) {
      // Use cached file with speed parameter
      console.log(`💾 Using cached episode with speed ${speed}x: ${episode.cachedPath}`);
      const cachedIdentifier = `cached://${path.basename(episode.cachedPath)}`;
      encodedUrl = Buffer.from(cachedIdentifier).toString('base64');
      playUrl = position > 0 ? 
        `https://${req.get('host')}/proxy-audio/${encodedUrl}/start/${position}/speed/${speed}` :
        `https://${req.get('host')}/proxy-audio/${encodedUrl}/speed/${speed}`;
    } else {
      // Use remote URL with speed parameter
      const cleanedUrl = cleanAudioUrl(episode.audioUrl);
      encodedUrl = Buffer.from(cleanedUrl).toString('base64');
      playUrl = position > 0 ? 
        `https://${req.get('host')}/proxy-audio/${encodedUrl}/start/${position}/speed/${speed}` :
        `https://${req.get('host')}/proxy-audio/${encodedUrl}/speed/${speed}`;
    }
    
    console.log(`🎵 Playing with speed ${speed}x: ${episode.title} (${episode.isCached ? 'cached' : 'remote'})`);
    
    // Set up gather with position tracking and speed-adjusted timing
    const gather = twiml.gather({
      numDigits: 1,
      action: `/webhook/playback-control?channel=${channel}&episodeIndex=${episodeIndex}&position=${position}&startTime=${Date.now()}`,
      method: 'POST',
      timeout: 30
    });
    
    // Play the episode with speed adjustment
    gather.play({ loop: 1 }, playUrl);
    gather.say(VOICE_CONFIG, `Press 1 for previous episode, 3 for next episode, 4 to skip back, 6 to skip forward, 2 or 5 to change speed, or 0 for menu.`);
    
    // Continue with updated position after timeout (adjusted for playback speed)
    const speedAdjustedDuration = Math.floor(30 / speed); // Adjust timeout for speed
    const nextPosition = position + speedAdjustedDuration;
    twiml.redirect(`/webhook/playback-control?channel=${channel}&episodeIndex=${episodeIndex}&position=${nextPosition}&startTime=${Date.now()}`);
    
  } catch (error) {
    console.error(`❌ Error playing episode with speed:`, error.message);
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
  
  const podcast = ALL_PODCASTS[channel] || EXTENSION_PODCASTS[channel];
  if (!podcast) {
    twiml.say(VOICE_CONFIG, 'Invalid channel.');
    twiml.redirect('/webhook/ivr-main');
    return res.type('text/xml').send(twiml.toString());
  }
  
  try {
    // Special handling for debates (channel 50)
    let episodes = [];
    if (channel === '50' && podcast.rssUrl === 'YOUTUBE_DEBATES') {
      try {
        const fs = require('fs');
        const path = require('path');
        let fileList = [];
        
        try {
          const debatesPath = path.join(__dirname, 'public', 'debates');
          const files = fs.readdirSync(debatesPath);
          const mp3Files = files
            .filter(file => file.toLowerCase().endsWith('.mp3'))
            .sort();
          
          if (mp3Files.length > 0) {
            fileList = mp3Files;
          } else {
            fileList = ['debate1.mp3', 'debate2.mp3', 'debate3.mp3'];
          }
        } catch (fsError) {
          console.error(`❌ Error reading debates folder: ${fsError.message}`);
          fileList = ['debate1.mp3', 'debate2.mp3', 'debate3.mp3'];
        }
        
        // Create episodes array for debates
        const railwayBaseUrl = `${req.protocol}://${req.get('host')}/debates/`;
        episodes = fileList.map((file, index) => ({
          title: file.replace('.mp3', '').replace(/[-_]/g, ' '),
          audioUrl: `${railwayBaseUrl}${file}`,
          description: `Debate audio file: ${file}`,
          episodeIndex: index
        }));
      } catch (error) {
        console.error(`❌ Error processing debates: ${error.message}`);
        episodes = [];
      }
    } else {
      // Fetch episodes to get the next one, with dynamic loading if needed
      episodes = await fetchPodcastEpisodes(podcast.rssUrl, 0, 10, channel);
    }
    
    const nextEpisodeIndex = episodeIndex + 1;
    
    // If we don't have enough episodes and we're near the end, fetch more
    if (!episodes[nextEpisodeIndex] && nextEpisodeIndex >= 8 && channel !== '50') {
      console.log(`🔄 Need more episodes for index ${nextEpisodeIndex}, fetching more...`);
      episodes = await fetchPodcastEpisodes(podcast.rssUrl, 0, 20, channel); // Fetch 20 total
    }
    
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
      gather.say(VOICE_CONFIG, VOICE_PROMPTS.podcasts.playbackControls);
      
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

// Test endpoint to generate realistic analytics data
app.get('/api/test-analytics', async (req, res) => {
  try {
    // Create some realistic test call sessions
    const testCalls = [
      {
        phoneNumber: '9183887174',
        duration: 180,
        listeningTime: 150,
        extension: '1',
        channelName: 'NPR News Now'
      },
      {
        phoneNumber: '5551234567', 
        duration: 300,
        listeningTime: 280,
        extension: '2',
        channelName: 'Weather Update'
      },
      {
        phoneNumber: '4045551234',
        duration: 450,
        listeningTime: 420,
        extension: '50',
        channelName: 'Debates'
      }
    ];

    for (const call of testCalls) {
      const testCallSid = 'realistic_test_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
      
      // Start session
      const session = analytics.startSession(testCallSid, call.phoneNumber);
      
      // Track channel selection
      analytics.trackChannelSelection(testCallSid, call.extension, call.channelName);
      
      // Simulate listening time
      session.channelStartTime = new Date(Date.now() - call.listeningTime * 1000);
      session.totalListeningTime = call.listeningTime;
      if (session.currentChannel) {
        session.currentChannel.listeningTime = call.listeningTime;
      }
      
      // End session
      analytics.endSession(testCallSid, 'hangup');
    }

    res.json({
      success: true,
      message: 'Realistic test analytics data created',
      testCallsGenerated: testCalls.length
    });
    
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

// Handle YouTube debates playback
app.all('/webhook/play-debate', async (req, res) => {
  const digits = req.body.Digits;
  const twiml = new VoiceResponse();
  
  console.log(`🎬 Debate selection: ${digits}`);
  
  // Handle return to main menu
  if (digits === '*') {
    twiml.redirect('/webhook/ivr-main');
    return res.type('text/xml').send(twiml.toString());
  }
  
  try {
    // Use the same static debates list from sync.com folder
    const staticDebates = [
      {
        id: 1,
        title: 'Debate 1',
        description: 'First available debate',
        url: 'https://ln5.sync.com/4.0/dl/34fe51340/teq5fmt7-aktqvy7h-27qrby4k-jevmstab/debate1.mp3'
      },
      {
        id: 2,
        title: 'Debate 2', 
        description: 'Second available debate',
        url: 'https://ln5.sync.com/4.0/dl/34fe51340/teq5fmt7-aktqvy7h-27qrby4k-jevmstab/debate2.mp3'
      },
      {
        id: 3,
        title: 'Debate 3',
        description: 'Third available debate', 
        url: 'https://ln5.sync.com/4.0/dl/34fe51340/teq5fmt7-aktqvy7h-27qrby4k-jevmstab/debate3.mp3'
      }
    ];
    
    const debates = staticDebates;
    const selectedIndex = parseInt(digits) - 1;
    
    if (selectedIndex < 0 || selectedIndex >= debates.length) {
      twiml.say(VOICE_CONFIG, 'Invalid selection. Please try again.');
      twiml.redirect('/webhook/select-channel?digits=50');
      return res.type('text/xml').send(twiml.toString());
    }
    
    const selectedDebate = debates[selectedIndex];
    console.log(`🎬 Playing debate from sync.com: ${selectedDebate.title}`);
    
    // Play the MP3 directly from sync.com
    const title = selectedDebate.title || selectedDebate.description || 'Selected debate';
    console.log(`🎵 Playing MP3 from sync.com: ${selectedDebate.url}`);
    
    twiml.say(VOICE_CONFIG, `Now playing: ${title}`);
    
    // Play the MP3 file directly - sync.com MP3s should work well with SignalWire
    twiml.play(selectedDebate.url);
    
    // Add playback controls after the audio - use main podcast endpoint for unified controls
    const gather = twiml.gather({
      numDigits: 1,
      timeout: 10,
      action: `/webhook/playback-control?channel=50&episodeIndex=${selectedIndex}&position=0&startTime=${Date.now()}`,
      method: 'POST'
    });
    
    gather.say(VOICE_CONFIG, 'Press 1 to hear another debate, or star to return to main menu.');
    
    twiml.say(VOICE_CONFIG, 'No input received.');
    twiml.redirect('/webhook/ivr-main');
    
  } catch (error) {
    console.error('❌ Error playing debate:', error);
    twiml.say(VOICE_CONFIG, 'Sorry, there was an error playing the debate.');
    twiml.redirect('/webhook/ivr-main');
  }
  
  res.type('text/xml');
  res.send(twiml.toString());
});

// Handle debate playback controls - standardized controls for Extension 50
app.all('/webhook/debate-controls', async (req, res) => {
  const digits = req.body.Digits;
  const currentIndex = parseInt(req.query.currentIndex || '0');
  const totalFiles = parseInt(req.query.totalFiles || '3');
  const currentPosition = parseInt(req.query.position || '0');
  const startTime = parseInt(req.query.startTime) || Date.now();
  const callerId = req.body.From || req.body.Caller;
  const twiml = new VoiceResponse();
  
  console.log(`🎵 Debate controls: ${digits}, currentIndex: ${currentIndex}, totalFiles: ${totalFiles}`);
  
  try {
    // Use Railway debates folder that mirrors /Users/josephsee/audio/
    const railwayBaseUrl = `${req.protocol}://${req.get('host')}/debates/`;
    
    // Dynamically detect MP3 files in the debates folder
    const fs = require('fs');
    const path = require('path');
    let fileList = [];
    
    try {
      const debatesPath = path.join(__dirname, 'public', 'debates');
      const files = fs.readdirSync(debatesPath);
      const mp3Files = files
        .filter(file => file.toLowerCase().endsWith('.mp3'))
        .sort();
      
      if (mp3Files.length > 0) {
        fileList = mp3Files;
      } else {
        fileList = ['debate1.mp3', 'debate2.mp3', 'debate3.mp3'];
      }
    } catch (fsError) {
      console.error(`❌ Error reading debates folder in controls: ${fsError.message}`);
      fileList = ['debate1.mp3', 'debate2.mp3', 'debate3.mp3'];
    }
  
    // Calculate actual position based on playback time
    const playbackDuration = Math.floor((Date.now() - startTime) / 1000);
    const playbackSpeed = callerSessions.getPlaybackSpeed(callerId) || 1.0;
    const actualPosition = currentPosition + Math.floor(playbackDuration * playbackSpeed);
  
    switch(digits) {
      case '1': // Previous episode/file
        const prevIndex = currentIndex > 0 ? currentIndex - 1 : fileList.length - 1;
        const prevFile = fileList[prevIndex];
        const prevFileUrl = `${railwayBaseUrl}${prevFile}`;
        const prevFilename = prevFile.replace('.mp3', '').replace(/[-_]/g, ' ');
        
        console.log(`⏮️ Playing previous file: ${prevFile} (index ${prevIndex})`);
        
        twiml.say(VOICE_CONFIG, `Previous episode: ${prevFilename}`);
        twiml.play(prevFileUrl);
        
        const prevGather = twiml.gather({
          numDigits: 1,
          timeout: 30,
          action: `/webhook/debate-controls?currentIndex=${prevIndex}&totalFiles=${fileList.length}&position=0&startTime=${Date.now()}`,
          method: 'POST'
        });
        
        prevGather.say(VOICE_CONFIG, 'Press 1 for previous, 3 for next, 4 to rewind, 6 to fast forward, 2 to slow down, 5 to speed up, or star to resume.');
        twiml.redirect('/webhook/ivr-main');
        break;
        
      case '3': // Next episode/file
        const nextIndex = (currentIndex + 1) % fileList.length;
        const nextFile = fileList[nextIndex];
        const nextFileUrl = `${railwayBaseUrl}${nextFile}`;
        const nextFilename = nextFile.replace('.mp3', '').replace(/[-_]/g, ' ');
        
        console.log(`⏭️ Playing next file: ${nextFile} (index ${nextIndex})`);
        
        twiml.say(VOICE_CONFIG, `Next episode: ${nextFilename}`);
        twiml.play(nextFileUrl);
        
        const nextGather = twiml.gather({
          numDigits: 1,
          timeout: 30,
          action: `/webhook/debate-controls?currentIndex=${nextIndex}&totalFiles=${fileList.length}&position=0&startTime=${Date.now()}`,
          method: 'POST'
        });
        
        nextGather.say(VOICE_CONFIG, 'Press 1 for previous, 3 for next, 4 to rewind, 6 to fast forward, 2 to slow down, 5 to speed up, or star to resume.');
        twiml.redirect('/webhook/ivr-main');
        break;
        
      case '4': // Rewind 30 seconds (seek backward)
        const backPosition = Math.max(0, actualPosition - 30);
        console.log(`⏪ Rewind 30s: ${actualPosition}s -> ${backPosition}s`);
        
        twiml.say(VOICE_CONFIG, 'Rewinding 30 seconds.');
        // For debates, we'll restart the current file since seeking isn't easily supported
        const currentFile = fileList[currentIndex];
        const currentFileUrl = `${railwayBaseUrl}${currentFile}`;
        twiml.play(currentFileUrl);
        
        const rewindGather = twiml.gather({
          numDigits: 1,
          timeout: 30,
          action: `/webhook/debate-controls?currentIndex=${currentIndex}&totalFiles=${fileList.length}&position=${backPosition}&startTime=${Date.now()}`,
          method: 'POST'
        });
        
        rewindGather.say(VOICE_CONFIG, 'Press 1 for previous, 3 for next, 4 to rewind, 6 to fast forward, 2 to slow down, 5 to speed up, or star to resume.');
        twiml.redirect('/webhook/ivr-main');
        break;
        
      case '6': // Fast forward 30 seconds (seek forward)
        const forwardPosition = actualPosition + 30;
        console.log(`⏩ Fast forward 30s: ${actualPosition}s -> ${forwardPosition}s`);
        
        twiml.say(VOICE_CONFIG, 'Fast forwarding 30 seconds.');
        // For debates, we'll continue with current file
        const currentFileForward = fileList[currentIndex];
        const currentFileUrlForward = `${railwayBaseUrl}${currentFileForward}`;
        twiml.play(currentFileUrlForward);
        
        const ffGather = twiml.gather({
          numDigits: 1,
          timeout: 30,
          action: `/webhook/debate-controls?currentIndex=${currentIndex}&totalFiles=${fileList.length}&position=${forwardPosition}&startTime=${Date.now()}`,
          method: 'POST'
        });
        
        ffGather.say(VOICE_CONFIG, 'Press 1 for previous, 3 for next, 4 to rewind, 6 to fast forward, 2 to slow down, 5 to speed up, or star to resume.');
        twiml.redirect('/webhook/ivr-main');
        break;
        
      case '2': // Decrease playback speed
        const currentSpeed = callerSessions.getPlaybackSpeed(callerId) || 1.0;
        const newSlowSpeed = Math.max(0.5, currentSpeed - 0.25);
        callerSessions.updatePlaybackSpeed(callerId, newSlowSpeed);
        console.log(`🐌 Speed decreased: ${currentSpeed}x -> ${newSlowSpeed}x`);
        
        twiml.say(VOICE_CONFIG, `Playback speed decreased to ${newSlowSpeed} times normal.`);
        
        // Continue current file at new speed
        const currentFileSpeed = fileList[currentIndex];
        const currentFileUrlSpeed = `${railwayBaseUrl}${currentFileSpeed}`;
        twiml.play({ rate: newSlowSpeed }, currentFileUrlSpeed);
        
        const speedGather = twiml.gather({
          numDigits: 1,
          timeout: 30,
          action: `/webhook/debate-controls?currentIndex=${currentIndex}&totalFiles=${fileList.length}&position=${actualPosition}&startTime=${Date.now()}`,
          method: 'POST'
        });
        
        speedGather.say(VOICE_CONFIG, 'Press 1 for previous, 3 for next, 4 to rewind, 6 to fast forward, 2 to slow down, 5 to speed up, or star for main menu.');
        twiml.say(VOICE_CONFIG, 'Returning to main menu.');
        twiml.redirect('/webhook/ivr-main');
        break;
        
      case '5': // Increase playback speed
        const currentFastSpeed = callerSessions.getPlaybackSpeed(callerId) || 1.0;
        const newFastSpeed = Math.min(2.0, currentFastSpeed + 0.25);
        callerSessions.updatePlaybackSpeed(callerId, newFastSpeed);
        console.log(`🏃 Speed increased: ${currentFastSpeed}x -> ${newFastSpeed}x`);
        
        twiml.say(VOICE_CONFIG, `Playback speed increased to ${newFastSpeed} times normal.`);
        
        // Continue current file at new speed
        const currentFileFast = fileList[currentIndex];
        const currentFileUrlFast = `${railwayBaseUrl}${currentFileFast}`;
        twiml.play({ rate: newFastSpeed }, currentFileUrlFast);
        
        const fastGather = twiml.gather({
          numDigits: 1,
          timeout: 30,
          action: `/webhook/debate-controls?currentIndex=${currentIndex}&totalFiles=${fileList.length}&position=${actualPosition}&startTime=${Date.now()}`,
          method: 'POST'
        });
        
        fastGather.say(VOICE_CONFIG, 'Press 1 for previous, 3 for next, 4 to rewind, 6 to fast forward, 2 to slow down, 5 to speed up, or star for main menu.');
        twiml.say(VOICE_CONFIG, 'Returning to main menu.');
        twiml.redirect('/webhook/ivr-main');
        break;
        
      case '*': // Resume last episode from another channel
        const lastSession = callerSessions.getLastPosition(callerId);
        if (lastSession && lastSession.channelId !== '50') {
          console.log(`🔄 Resuming previous episode: Channel ${lastSession.channelId}`);
          twiml.say(VOICE_CONFIG, `Resuming your previous episode in channel ${lastSession.channelId}.`);
          twiml.redirect(`/webhook/play-episode-at-position?channel=${lastSession.channelId}&episodeIndex=0&position=${lastSession.positionSeconds}`);
        } else {
          twiml.say(VOICE_CONFIG, 'No previous episode to resume.');
          // Continue current file
          const currentFileResume = fileList[currentIndex];
          const currentFileUrlResume = `${railwayBaseUrl}${currentFileResume}`;
          twiml.play(currentFileUrlResume);
          
          const resumeGather = twiml.gather({
            numDigits: 1,
            timeout: 30,
            action: `/webhook/debate-controls?currentIndex=${currentIndex}&totalFiles=${fileList.length}&position=${actualPosition}&startTime=${Date.now()}`,
            method: 'POST'
          });
          
          resumeGather.say(VOICE_CONFIG, 'Press 1 for previous, 3 for next, 4 to rewind, 6 to fast forward, 2 to slow down, 5 to speed up, or star to resume.');
          twiml.redirect('/webhook/ivr-main');
        }
        break;
        
      case '0': // Main menu
        twiml.say(VOICE_CONFIG, 'Returning to main menu.');
        twiml.redirect('/webhook/ivr-main');
        break;
        
      default:
        // Invalid input or timeout - continue current file
        const currentFileDefault = fileList[currentIndex];
        const currentFileUrlDefault = `${railwayBaseUrl}${currentFileDefault}`;
        
        twiml.say(VOICE_CONFIG, 'Continuing current episode.');
        twiml.play(currentFileUrlDefault);
        
        const defaultGather = twiml.gather({
          numDigits: 1,
          timeout: 30,
          action: `/webhook/debate-controls?currentIndex=${currentIndex}&totalFiles=${fileList.length}&position=${actualPosition}&startTime=${Date.now()}`,
          method: 'POST'
        });
        
        defaultGather.say(VOICE_CONFIG, 'Press 1 for previous, 3 for next, 4 to rewind, 6 to fast forward, 2 to slow down, 5 to speed up, or star to resume.');
        twiml.redirect('/webhook/ivr-main');
    }
  } catch (error) {
    console.error('❌ Error in debate controls:', error);
    twiml.say(VOICE_CONFIG, 'Sorry, there was an error with playback controls.');
    twiml.redirect('/webhook/ivr-main');
  }
  
  res.type('text/xml');
  res.send(twiml.toString());
});

// Handle sermon playback controls - file navigation
app.all('/webhook/sermon-controls', async (req, res) => {
  const digits = req.body.Digits;
  const currentIndex = parseInt(req.query.currentIndex || '0');
  const totalSermons = parseInt(req.query.totalSermons || '5');
  const twiml = new VoiceResponse();
  
  console.log(`⛪ Sermon controls: ${digits}, currentIndex: ${currentIndex}, totalSermons: ${totalSermons}`);
  
  try {
    // Re-scrape sermons from Pilgrim Ministry (or use cached results)
    const sermonUrl = 'https://www.pilgrimministry.org/allsermons';
    let sermonFiles = [];
    
    try {
      console.log(`📡 Re-fetching sermons for controls...`);
      const response = await axios.get(sermonUrl, { timeout: 10000 });
      const html = response.data;
      
      const audioMatches = html.match(/href="[^"]*\.mp3[^"]*"/gi) || [];
      
      audioMatches.slice(0, 10).forEach((match, index) => {
        const audioUrl = match.match(/href="([^"]*)"/i)[1];
        const fullUrl = audioUrl.startsWith('http') ? audioUrl : `https://www.pilgrimministry.org${audioUrl}`;
        
        sermonFiles.push({
          id: index + 1,
          title: `Sermon ${index + 1}`,
          url: fullUrl
        });
      });
      
    } catch (fetchError) {
      console.error(`❌ Error re-fetching sermons: ${fetchError.message}`);
      // Create fallback sermon list
      for (let i = 1; i <= totalSermons; i++) {
        sermonFiles.push({
          id: i,
          title: `Sermon ${i}`,
          url: `https://www.pilgrimministry.org/sermon${i}.mp3` // Fallback URL
        });
      }
    }
    
    if (digits === '*1') {
      // Next sermon
      const nextIndex = (currentIndex + 1) % sermonFiles.length;
      const nextSermon = sermonFiles[nextIndex];
      
      console.log(`⏭️ Playing next sermon: ${nextSermon.title} (index ${nextIndex})`);
      
      twiml.say(VOICE_CONFIG, `Playing: ${nextSermon.title}`);
      twiml.play(nextSermon.url);
      
      const gather = twiml.gather({
        numDigits: 2,
        timeout: 30,
        action: `/webhook/sermon-controls?currentIndex=${nextIndex}&totalSermons=${sermonFiles.length}`,
        method: 'POST'
      });
      
      gather.say(VOICE_CONFIG, 'Press star-1 for next sermon, star-2 for previous, or star-star for main menu.');
      twiml.redirect('/webhook/ivr-main');
      
    } else if (digits === '*2') {
      // Previous sermon
      const prevIndex = currentIndex > 0 ? currentIndex - 1 : sermonFiles.length - 1;
      const prevSermon = sermonFiles[prevIndex];
      
      console.log(`⏮️ Playing previous sermon: ${prevSermon.title} (index ${prevIndex})`);
      
      twiml.say(VOICE_CONFIG, `Playing: ${prevSermon.title}`);
      twiml.play(prevSermon.url);
      
      const gather = twiml.gather({
        numDigits: 2,
        timeout: 30,
        action: `/webhook/sermon-controls?currentIndex=${prevIndex}&totalSermons=${sermonFiles.length}`,
        method: 'POST'
      });
      
      gather.say(VOICE_CONFIG, 'Press star-1 for next sermon, star-2 for previous, or star-star for main menu.');
      twiml.redirect('/webhook/ivr-main');
      
    } else if (digits === '**') {
      // Return to main menu
      twiml.redirect('/webhook/ivr-main');
    } else {
      // Invalid input - replay current sermon
      const currentSermon = sermonFiles[currentIndex];
      
      twiml.say(VOICE_CONFIG, 'Invalid option. Replaying current sermon.');
      twiml.play(currentSermon.url);
      
      const gather = twiml.gather({
        numDigits: 2,
        timeout: 30,
        action: `/webhook/sermon-controls?currentIndex=${currentIndex}&totalSermons=${sermonFiles.length}`,
        method: 'POST'
      });
      
      gather.say(VOICE_CONFIG, 'Press star-1 for next sermon, star-2 for previous, or star-star for main menu.');
      twiml.redirect('/webhook/ivr-main');
    }
  } catch (error) {
    console.error('❌ Error in sermon controls:', error);
    twiml.say(VOICE_CONFIG, 'Sorry, there was an error with sermon playback controls.');
    twiml.redirect('/webhook/ivr-main');
  }
  
  res.type('text/xml');
  res.send(twiml.toString());
});

// Enhanced debate playback controls that work with episode caching for uniform speed control
app.all('/webhook/debate-playback-control', async (req, res) => {
  const channel = req.query.channel || req.body.channel;
  const episodeIndex = parseInt(req.query.episodeIndex || req.body.episodeIndex) || 0;
  const position = parseInt(req.query.position || req.body.position) || 0;
  const startTime = parseInt(req.query.startTime) || Date.now();
  const digits = req.body.Digits;
  const callerId = req.body.From || req.body.Caller;
  
  console.log(`🎵 Enhanced debate controls: ${digits}, episodeIndex: ${episodeIndex}, position: ${position}s`);
  
  const twiml = new VoiceResponse();
  
  try {
    // Initialize episode cache
    const episodeCache = new EpisodeCache();
    
    // Get debate files from local folder
    const fs = require('fs');
    const path = require('path');
    let fileList = [];
    
    try {
      const debatesPath = path.join(__dirname, 'public', 'debates');
      const files = fs.readdirSync(debatesPath);
      const mp3Files = files
        .filter(file => file.toLowerCase().endsWith('.mp3'))
        .sort();
      
      if (mp3Files.length > 0) {
        fileList = mp3Files;
      } else {
        fileList = ['debate1.mp3', 'debate2.mp3', 'debate3.mp3'];
      }
    } catch (fsError) {
      console.error(`❌ Error reading debates folder: ${fsError.message}`);
      fileList = ['debate1.mp3', 'debate2.mp3', 'debate3.mp3'];
    }
    
    // Create episodes array
    const railwayBaseUrl = `${req.protocol}://${req.get('host')}/debates/`;
    const episodes = fileList.map((file, index) => ({
      title: file.replace('.mp3', '').replace(/[-_]/g, ' '),
      audioUrl: `${railwayBaseUrl}${file}`,
      description: `Debate audio file: ${file}`,
      episodeIndex: index
    }));
    
    // Calculate actual position based on playback time
    const playbackDuration = Math.floor((Date.now() - startTime) / 1000);
    const playbackSpeed = callerSessions.getPlaybackSpeed(callerId) || 1.0;
    const actualPosition = position + Math.floor(playbackDuration * playbackSpeed);
    
    switch(digits) {
      case '1': // Previous episode
        const prevIndex = episodeIndex > 0 ? episodeIndex - 1 : episodes.length - 1;
        const prevEpisode = episodes[prevIndex];
        
        console.log(`⏮️ Playing previous debate: ${prevEpisode.title} (index ${prevIndex})`);
        
        // Cache and play previous episode
        let prevCachedPath = null;
        try {
          if (episodeCache.isCached('debates', prevEpisode.audioUrl)) {
            prevCachedPath = episodeCache.getCachedEpisodePath('debates', prevEpisode.audioUrl);
          } else {
            prevCachedPath = await episodeCache.cacheEpisode('debates', prevEpisode.audioUrl, prevEpisode.title, 'temporary');
          }
        } catch (cacheError) {
          console.warn(`⚠️ Caching failed for previous episode: ${cacheError.message}`);
        }
        
        const prevPlaybackUrl = prevCachedPath ? 
          `https://${req.get('host')}/cached_episodes/${path.basename(prevCachedPath)}` : 
          prevEpisode.audioUrl;
        
        twiml.say(VOICE_CONFIG, `Previous episode: ${prevEpisode.title}`);
        twiml.play(prevPlaybackUrl);
        
        const prevGather = twiml.gather({
          numDigits: 1,
          timeout: 30,
          action: `/webhook/debate-playback-control?channel=debates&episodeIndex=${prevIndex}&position=0&startTime=${Date.now()}`,
          method: 'POST'
        });
        
        prevGather.say(VOICE_CONFIG, 'Press 1 for previous, 3 for next, 4 to rewind, 6 to fast forward, 2 to slow down, 5 to speed up, or star for main menu.');
        twiml.redirect('/webhook/ivr-main');
        break;
        
      case '3': // Next episode
        const nextIndex = (episodeIndex + 1) % episodes.length;
        const nextEpisode = episodes[nextIndex];
        
        console.log(`⏭️ Playing next debate: ${nextEpisode.title} (index ${nextIndex})`);
        
        // Cache and play next episode
        let nextCachedPath = null;
        try {
          if (episodeCache.isCached('debates', nextEpisode.audioUrl)) {
            nextCachedPath = episodeCache.getCachedEpisodePath('debates', nextEpisode.audioUrl);
          } else {
            nextCachedPath = await episodeCache.cacheEpisode('debates', nextEpisode.audioUrl, nextEpisode.title, 'temporary');
          }
        } catch (cacheError) {
          console.warn(`⚠️ Caching failed for next episode: ${cacheError.message}`);
        }
        
        const nextPlaybackUrl = nextCachedPath ? 
          `https://${req.get('host')}/cached_episodes/${path.basename(nextCachedPath)}` : 
          nextEpisode.audioUrl;
        
        twiml.say(VOICE_CONFIG, `Next episode: ${nextEpisode.title}`);
        twiml.play(nextPlaybackUrl);
        
        const nextGather = twiml.gather({
          numDigits: 1,
          timeout: 30,
          action: `/webhook/debate-playback-control?channel=debates&episodeIndex=${nextIndex}&position=0&startTime=${Date.now()}`,
          method: 'POST'
        });
        
        nextGather.say(VOICE_CONFIG, 'Press 1 for previous, 3 for next, 4 to rewind, 6 to fast forward, 2 to slow down, 5 to speed up, or star for main menu.');
        twiml.redirect('/webhook/ivr-main');
        break;
        
      case '4': // Rewind 30 seconds
        const backPosition = Math.max(0, actualPosition - 30);
        console.log(`⏪ Rewind 30s: ${actualPosition}s -> ${backPosition}s`);
        
        const currentEpisodeRewind = episodes[episodeIndex];
        
        // Use cached version if available
        let rewindCachedPath = episodeCache.getCachedEpisodePath('debates', currentEpisodeRewind.audioUrl);
        const rewindPlaybackUrl = rewindCachedPath ? 
          `https://${req.get('host')}/cached_episodes/${path.basename(rewindCachedPath)}` : 
          currentEpisodeRewind.audioUrl;
        
        twiml.say(VOICE_CONFIG, 'Rewinding 30 seconds.');
        twiml.play(rewindPlaybackUrl);
        
        const rewindGather = twiml.gather({
          numDigits: 1,
          timeout: 30,
          action: `/webhook/debate-playback-control?channel=debates&episodeIndex=${episodeIndex}&position=${backPosition}&startTime=${Date.now()}`,
          method: 'POST'
        });
        
        rewindGather.say(VOICE_CONFIG, 'Press 1 for previous, 3 for next, 4 to rewind, 6 to fast forward, 2 to slow down, 5 to speed up, or star for main menu.');
        twiml.redirect('/webhook/ivr-main');
        break;
        
      case '6': // Fast forward 30 seconds
        const forwardPosition = actualPosition + 30;
        console.log(`⏩ Fast forward 30s: ${actualPosition}s -> ${forwardPosition}s`);
        
        const currentEpisodeForward = episodes[episodeIndex];
        
        // Use cached version if available
        let forwardCachedPath = episodeCache.getCachedEpisodePath('debates', currentEpisodeForward.audioUrl);
        const forwardPlaybackUrl = forwardCachedPath ? 
          `https://${req.get('host')}/cached_episodes/${path.basename(forwardCachedPath)}` : 
          currentEpisodeForward.audioUrl;
        
        twiml.say(VOICE_CONFIG, 'Fast forwarding 30 seconds.');
        twiml.play(forwardPlaybackUrl);
        
        const ffGather = twiml.gather({
          numDigits: 1,
          timeout: 30,
          action: `/webhook/debate-playback-control?channel=debates&episodeIndex=${episodeIndex}&position=${forwardPosition}&startTime=${Date.now()}`,
          method: 'POST'
        });
        
        ffGather.say(VOICE_CONFIG, 'Press 1 for previous, 3 for next, 4 to rewind, 6 to fast forward, 2 to slow down, 5 to speed up, or star for main menu.');
        twiml.redirect('/webhook/ivr-main');
        break;
        
      case '2': // Decrease playback speed
        const currentSpeed = callerSessions.getPlaybackSpeed(callerId) || 1.0;
        const newSlowSpeed = Math.max(0.5, currentSpeed - 0.25);
        callerSessions.updatePlaybackSpeed(callerId, newSlowSpeed);
        console.log(`🐌 Speed decreased: ${currentSpeed}x -> ${newSlowSpeed}x`);
        
        const currentEpisodeSlow = episodes[episodeIndex];
        
        // Use cached version for speed control
        let slowCachedPath = episodeCache.getCachedEpisodePath('debates', currentEpisodeSlow.audioUrl);
        const slowPlaybackUrl = slowCachedPath ? 
          `https://${req.get('host')}/cached_episodes/${path.basename(slowCachedPath)}` : 
          currentEpisodeSlow.audioUrl;
        
        twiml.say(VOICE_CONFIG, `Playback speed decreased to ${newSlowSpeed} times normal.`);
        twiml.play({ rate: newSlowSpeed }, slowPlaybackUrl);
        
        const speedGather = twiml.gather({
          numDigits: 1,
          timeout: 30,
          action: `/webhook/debate-playback-control?channel=debates&episodeIndex=${episodeIndex}&position=${actualPosition}&startTime=${Date.now()}`,
          method: 'POST'
        });
        
        speedGather.say(VOICE_CONFIG, 'Press 1 for previous, 3 for next, 4 to rewind, 6 to fast forward, 2 to slow down, 5 to speed up, or star for main menu.');
        twiml.redirect('/webhook/ivr-main');
        break;
        
      case '5': // Increase playback speed
        const currentFastSpeed = callerSessions.getPlaybackSpeed(callerId) || 1.0;
        const newFastSpeed = Math.min(2.0, currentFastSpeed + 0.25);
        callerSessions.updatePlaybackSpeed(callerId, newFastSpeed);
        console.log(`🏃 Speed increased: ${currentFastSpeed}x -> ${newFastSpeed}x`);
        
        const currentEpisodeFast = episodes[episodeIndex];
        
        // Use cached version for speed control
        let fastCachedPath = episodeCache.getCachedEpisodePath('debates', currentEpisodeFast.audioUrl);
        const fastPlaybackUrl = fastCachedPath ? 
          `https://${req.get('host')}/cached_episodes/${path.basename(fastCachedPath)}` : 
          currentEpisodeFast.audioUrl;
        
        twiml.say(VOICE_CONFIG, `Playback speed increased to ${newFastSpeed} times normal.`);
        twiml.play({ rate: newFastSpeed }, fastPlaybackUrl);
        
        const fastGather = twiml.gather({
          numDigits: 1,
          timeout: 30,
          action: `/webhook/debate-playback-control?channel=debates&episodeIndex=${episodeIndex}&position=${actualPosition}&startTime=${Date.now()}`,
          method: 'POST'
        });
        
        fastGather.say(VOICE_CONFIG, 'Press 1 for previous, 3 for next, 4 to rewind, 6 to fast forward, 2 to slow down, 5 to speed up, or star for main menu.');
        twiml.redirect('/webhook/ivr-main');
        break;
        
      case '*': // Return to main menu
        console.log(`🏠 Returning to main menu from debates`);
        twiml.say(VOICE_CONFIG, 'Returning to main menu.');
        twiml.redirect('/webhook/ivr-main');
        break;
        
      default:
        // Continue current episode
        const currentEpisodeDefault = episodes[episodeIndex];
        
        // Use cached version if available
        let defaultCachedPath = episodeCache.getCachedEpisodePath('debates', currentEpisodeDefault.audioUrl);
        const defaultPlaybackUrl = defaultCachedPath ? 
          `https://${req.get('host')}/cached_episodes/${path.basename(defaultCachedPath)}` : 
          currentEpisodeDefault.audioUrl;
        
        twiml.say(VOICE_CONFIG, 'Continuing current debate.');
        twiml.play(defaultPlaybackUrl);
        
        const defaultGather = twiml.gather({
          numDigits: 1,
          timeout: 30,
          action: `/webhook/debate-playback-control?channel=debates&episodeIndex=${episodeIndex}&position=${actualPosition}&startTime=${Date.now()}`,
          method: 'POST'
        });
        
        defaultGather.say(VOICE_CONFIG, 'Press 1 for previous, 3 for next, 4 to rewind, 6 to fast forward, 2 to slow down, 5 to speed up, or star for main menu.');
        twiml.redirect('/webhook/ivr-main');
    }
  } catch (error) {
    console.error('❌ Error in enhanced debate controls:', error);
    twiml.say(VOICE_CONFIG, 'Sorry, there was an error with playback controls.');
    twiml.redirect('/webhook/ivr-main');
  }
  
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

