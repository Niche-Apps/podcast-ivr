// Enhanced Podcast Streaming System
// Fetches RSS feeds in real-time and streams audio directly to Twilio

const https = require('https');
const http = require('http');
const { URL } = require('url');

// Voice configuration
const VOICE_CONFIG = {
    voice: 'Polly.Brian',
    language: 'en-GB'
};

// Constants
const CHUNK_DURATION = 360; // 6 minutes in seconds
const SKIP_DURATION = 120;  // 2 minutes in seconds
const MAX_REDIRECTS = 10;
const REQUEST_TIMEOUT = 20000; // 20 seconds
const MAX_RETRIES = 3;

// Enhanced URL cleaner with better validation
function cleanAudioUrl(originalUrl) {
    console.log(`URL Cleaning: Initial URL for cleaning: ${originalUrl}`);
    
    if (!originalUrl || typeof originalUrl !== 'string') {
        console.log('Invalid URL provided to cleanAudioUrl, returning as is.');
        return originalUrl;
    }
    
    let cleanedUrl = originalUrl.trim();
    let previousUrl = ''; 
    
    try {
        // Step 0: Fix XML-encoded entities first
        cleanedUrl = cleanedUrl
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'");
        
        console.log(`After XML entity cleanup: ${cleanedUrl}`);
        
        // Step 1: Remove tracking domains and redirects (iteratively)
        const trackingPatterns = [
            /^https?:\/\/[^\/]*claritaspod\.com\/measure\//i,
            /^https?:\/\/[^\/]*arttrk\.com\/p\//i,
            /^https?:\/\/[^\/]*podscribe\.com\/rss\/p\//i,
            /^https?:\/\/[^\/]*pfx\.vpixl\.com\/[^\/]+\//i,
            /^https?:\/\/[^\/]*prfx\.byspotify\.com\/e\//i,
            /^https?:\/\/[^\/]*dts\.podtrac\.com\/redirect\.(mp3|aac)\//i,
            /^https?:\/\/[^\/]*mgln\.ai\/e\//i,
            /^https?:\/\/chtbl\.com\/track\/[A-Z0-9]+\//i,
            /^https?:\/\/www\.podtrac\.com\/pts\/redirect\.(mp3|aac)\//i,
            /^https?:\/\/pdst\.fm\/e\//i,
            /^https?:\/\/gnrl\.fm\//i,
            /^https?:\/\/proxy\.pocketcasts\.com\//i,
            /^https?:\/\/audio\.simplecast\.com\/tracking\//i,
            /^https?:\/\/stats\.adswizz\.com\//i,
            /^https?:\/\/analytics\.tritondigital\.com\//i,
            /^https?:\/\/op3\.dev\/[^\/]+\//i,
            /^https?:\/\/traffic\.omny\.fm\/[^\/]+\//i,
            /^https?:\/\/tracking\.feedpress\.it\/[^\/]+\//i,
            /^https?:\/\/aw\.noxsolutions\.com\/[^\/]+\//i,
            /^https?:\/\/play\.podtrac\.com\/npr-[^\/]+\//i,
            /^https?:\/\/megaphone\.fm\/ad\/[^\/]+\//i,
            /^https?:\/\/pixel\.simplecastapps\.com\/[^\/]+\//i,
            /^https?:\/\/redirect\.xn--simplecast-t0a\.com\//i,
            /^https?:\/\/www\.google\.com\/url\?q=/i,
            /^https?:\/\/feedproxy\.google\.com\//i,
            /^https?:\/\/[^\/]*doubleclick\.net\/[^\/]+\//i,
            /^https?:\/\/[^\/]*googletagmanager\.com\/[^\/]+\//i,
            /^https?:\/\/[^\/]*chartable\.com\/[^\/]+\//i,
            /^https?:\/\/[^\/]*spotify\.com\/track\/[^\/]+\//i,
            /^https?:\/\/[^\/]*podsights\.com\/[^\/]+\//i,
        ];
        
        let urlChangedInIteration;
        do { 
            urlChangedInIteration = false;
            previousUrl = cleanedUrl;
            for (const pattern of trackingPatterns) {
                if (pattern.test(cleanedUrl)) {
                    let newUrl = cleanedUrl.replace(pattern, '');
                    // Add back https if removed
                    if (!newUrl.startsWith('http') && newUrl.includes('.')) {
                        newUrl = 'https://' + newUrl;
                    }
                    if (newUrl !== cleanedUrl) {
                        console.log(`Removed tracking pattern: ${pattern}, URL now: ${newUrl}`);
                        cleanedUrl = newUrl;
                        urlChangedInIteration = true; 
                    }
                }
            }
        } while (urlChangedInIteration && cleanedUrl !== previousUrl);
        
        // Step 2: Handle Simplecast audio URLs specifically
        if (cleanedUrl.includes('simplecastaudio.com') || cleanedUrl.includes('simplecast.com')) {
            console.log(`Detected Simplecast URL after cleaning, applying special handling...`);
            
            if (cleanedUrl.includes('injector.simplecastaudio.com') && cleanedUrl.includes('hash_redirect=1')) {
                console.log(`Simplecast injector URL detected - will resolve redirect during validation`);
            } else if (cleanedUrl.includes('injector.simplecastaudio.com')) {
                console.log(`Simplecast injector URL without hash_redirect - cleaning parameters`);
                try {
                    const urlObj = new URL(cleanedUrl);
                    const essentialParams = ['aid', 'awCollectionId', 'awEpisodeId', 'feed', 'hash_redirect', 'x-total-bytes', 'x-ais-classified'];
                    const newParams = new URLSearchParams();
                    
                    for (const [key, value] of urlObj.searchParams) {
                        if (essentialParams.includes(key)) {
                            newParams.set(key, value);
                        } else {
                            console.log(`Removing Simplecast tracking param: ${key}`);
                        }
                    }
                    
                    cleanedUrl = `${urlObj.origin}${urlObj.pathname}?${newParams.toString()}`;
                    console.log(`Cleaned Simplecast injector URL: ${cleanedUrl}`);
                    
                } catch (urlError) {
                    console.log(`Could not parse Simplecast URL as URL object, keeping as-is: ${urlError.message}`);
                }
            }
        }
        
        // Step 3: Clean query parameters more selectively
        if (cleanedUrl.includes('?')) {
            const urlObj = new URL(cleanedUrl);
            const knownTrackingParams = [
                'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
                'utm_id', 'utm_source_platform', 'utm_creative_format', 'utm_marketing_tactic',
                'gclid', 'fbclid', 'msclkid', 'dclid', 'yclid',
                '_ga', '_gl', 'gad_source',
                'mc_eid', 'mc_cid', '_ke',
                'vero_id', 'hsCtaTracking', 'hsa_acc', 'hsa_cam', 'hsa_grp', 'hsa_ad',
                'hsa_src', 'hsa_tgt', 'hsa_kw', 'hsa_mt', 'hsa_net', 'hsa_ver',
                'trk_', 'piwik_', 'matomo_', 'pk_'
            ];
            
            const newParams = new URLSearchParams();
            let paramsModified = false;
            
            for (const [key, value] of urlObj.searchParams) {
                if (knownTrackingParams.some(trackingParam => key.toLowerCase().startsWith(trackingParam))) {
                    paramsModified = true;
                    console.log(`Removing known tracking query parameter: ${key}=${value}`);
                } else {
                    newParams.set(key, value);
                }
            }
            
            if (paramsModified) {
                if (newParams.toString()) {
                    cleanedUrl = `${urlObj.origin}${urlObj.pathname}?${newParams.toString()}`;
                } else {
                    cleanedUrl = `${urlObj.origin}${urlObj.pathname}`;
                }
                console.log(`Cleaned tracking query parameters. URL now: ${cleanedUrl}`);
            }
        }
        
        // Step 4: Ensure proper protocol
        if (cleanedUrl.startsWith('//')) {
            cleanedUrl = 'https:' + cleanedUrl;
            console.log(`Added https protocol (from //): ${cleanedUrl}`);
        } else if (!cleanedUrl.startsWith('http://') && !cleanedUrl.startsWith('https://')) {
            if (cleanedUrl.includes('.') && !cleanedUrl.includes(' ')) {
                cleanedUrl = 'https://' + cleanedUrl;
                console.log(`Added https protocol (from no protocol): ${cleanedUrl}`);
            }
        }
        
        console.log(`Final cleaned URL after all steps: ${cleanedUrl}`);
        
        // Final validation that we have a reasonable URL
        if (!cleanedUrl.startsWith('http')) {
            console.error(`URL cleaning resulted in invalid URL: ${cleanedUrl}`);
            console.log(`Falling back to original URL: ${originalUrl}`);
            return originalUrl;
        }
        
        // Log the cleaning summary
        if (cleanedUrl !== originalUrl) {
            console.log(`=== URL CLEANING SUMMARY ===`);
            console.log(`Original length: ${originalUrl.length} chars`);
            console.log(`Cleaned length: ${cleanedUrl.length} chars`);
            console.log(`Domains removed: ${(originalUrl.match(/https?:\/\//g) || []).length - (cleanedUrl.match(/https?:\/\//g) || []).length}`);
        }
        
        return cleanedUrl;
        
    } catch (error) {
        console.error(`URL cleaning error: ${error.message} for URL: ${originalUrl}. Returning original URL.`);
        return originalUrl; 
    }
}

// Simplified Simplecast URL resolver
async function resolveSimplecastInjector(injectorUrl) {
    console.log(`=== SIMPLECAST INJECTOR RESOLVER ===`);
    console.log(`Resolving: ${injectorUrl}`);
    
    const fetchWithTimeout = (url, options) => {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Request timeout'));
            }, options.timeout || 10000);
            
            const requestModule = url.startsWith('https:') ? https : http;
            const urlObj = new URL(url);
            
            const requestOptions = {
                hostname: urlObj.hostname,
                port: urlObj.port,
                path: urlObj.pathname + urlObj.search,
                method: options.method || 'HEAD',
                headers: options.headers || {},
                timeout: options.timeout || 10000
            };
            
            const req = requestModule.request(requestOptions, (res) => {
                clearTimeout(timeout);
                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    ok: res.statusCode >= 200 && res.statusCode < 300
                });
            });
            
            req.on('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            });
            
            req.end();
        });
    };
    
    try {
        const headResponse = await fetchWithTimeout(injectorUrl, {
            method: 'HEAD',
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; TwilioPodcastBot/2.0)',
                'Accept': 'audio/mpeg, audio/mp4, audio/ogg, audio/wav, audio/*, */*',
                'Referer': 'https://player.simplecast.com/',
                'Origin': 'https://player.simplecast.com'
            },
            timeout: 10000
        });
        
        console.log(`HEAD response status: ${headResponse.status}`);
        
        // If we get a redirect, follow it
        if (headResponse.status >= 300 && headResponse.status < 400) {
            const location = headResponse.headers.location;
            if (location) {
                const resolvedUrl = location.startsWith('http') ? location : new URL(location, injectorUrl).href;
                console.log(`✓ Got redirect to: ${resolvedUrl}`);
                return {
                    success: true,
                    originalUrl: injectorUrl,
                    resolvedUrl: resolvedUrl
                };
            }
        }
        
        console.log(`No redirect found, injector URL may work directly`);
        return {
            success: true,
            originalUrl: injectorUrl,
            resolvedUrl: injectorUrl
        };
        
    } catch (error) {
        console.error(`Simplecast resolution error: ${error.message}`);
        return {
            success: false,
            error: error.message,
            originalUrl: injectorUrl
        };
    }
}

// URL resolution and validation
async function resolveAndValidateUrl(url, retryCount = 0) {
    console.log(`=== URL RESOLUTION START (Attempt ${retryCount + 1}) ===`);
    console.log(`Resolving URL: ${url}`);
    
    const isSimplecast = url.includes('simplecastaudio.com');
    if (isSimplecast) {
        console.log(`Detected Simplecast URL - using enhanced validation`);
    }
    
    const fetchWithTimeout = (url, options) => {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Request timeout'));
            }, options.timeout || REQUEST_TIMEOUT);
            
            const requestModule = url.startsWith('https:') ? https : http;
            const urlObj = new URL(url);
            
            const requestOptions = {
                hostname: urlObj.hostname,
                port: urlObj.port,
                path: urlObj.pathname + urlObj.search,
                method: options.method || 'HEAD',
                headers: options.headers || {},
                timeout: options.timeout || REQUEST_TIMEOUT
            };
            
            const req = requestModule.request(requestOptions, (res) => {
                clearTimeout(timeout);
                
                let body = '';
                if (options.method === 'GET') {
                    res.on('data', chunk => body += chunk);
                }
                
                res.on('end', () => {
                    resolve({
                        status: res.statusCode,
                        headers: res.headers,
                        ok: res.statusCode >= 200 && res.statusCode < 300,
                        body: body
                    });
                });
            });
            
            req.on('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            });
            
            req.end();
        });
    };
    
    try {
        // Follow redirects manually to have more control
        let currentUrl = url;
        let redirectCount = 0;
        
        while (redirectCount < MAX_REDIRECTS) {
            console.log(`Checking URL (redirect ${redirectCount}): ${currentUrl}`);
            
            const response = await fetchWithTimeout(currentUrl, {
                method: 'HEAD',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; TwilioPodcastBot/2.0)',
                    'Accept': 'audio/mpeg, audio/mp4, audio/ogg, audio/wav, audio/*, */*',
                    'Accept-Encoding': 'identity',
                    'Referer': isSimplecast ? 'https://player.simplecast.com/' : undefined,
                    'Origin': isSimplecast ? 'https://player.simplecast.com' : undefined
                },
                timeout: REQUEST_TIMEOUT
            });
            
            console.log(`Response status: ${response.status}`);
            
            // Handle redirects
            if (response.status >= 300 && response.status < 400) {
                const location = response.headers.location;
                if (!location) {
                    throw new Error(`Redirect response ${response.status} without Location header`);
                }
                
                const newUrl = location.startsWith('http') ? location : new URL(location, currentUrl).href;
                console.log(`Following redirect to: ${newUrl}`);
                
                currentUrl = newUrl;
                redirectCount++;
                continue;
            }
            
            // Handle specific Simplecast errors
            if (isSimplecast && response.status === 403) {
                console.log(`Simplecast 403 error - assuming URL is valid for Twilio`);
                return {
                    success: true,
                    url: currentUrl,
                    contentType: 'audio/mpeg',
                    contentLength: null,
                    supportsRanges: true,
                    isSimplecast: true,
                    note: `Assumed valid (${response.status} is common for Simplecast HEAD requests)`
                };
            }
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            
            const contentType = response.headers['content-type'];
            const contentLength = response.headers['content-length'];
            const acceptRanges = response.headers['accept-ranges'];
            
            console.log(`✓ URL resolved successfully: ${currentUrl}`);
            return {
                success: true,
                url: currentUrl,
                contentType,
                contentLength: contentLength ? parseInt(contentLength) : null,
                supportsRanges: acceptRanges === 'bytes'
            };
        }
        
        throw new Error(`Too many redirects (${MAX_REDIRECTS})`);
        
    } catch (error) {
        console.error(`URL resolution failed: ${error.message}`);
        
        if (retryCount < MAX_RETRIES - 1) {
            console.log(`Retrying in 2 seconds... (${retryCount + 1}/${MAX_RETRIES})`);
            await new Promise(resolve => setTimeout(resolve, 2000));
            return resolveAndValidateUrl(url, retryCount + 1);
        }
        
        return {
            success: false,
            error: error.message,
            url: url
        };
    }
}

// Fetch podcast episodes from RSS feed
async function fetchPodcastEpisodes(rssUrl) {
    console.log(`=== FETCH EPISODES START ===`);
    console.log(`URL: ${rssUrl}`);
    
    const fetchWithTimeout = (url) => {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Request timeout'));
            }, REQUEST_TIMEOUT);
            
            const requestModule = url.startsWith('https:') ? https : http;
            const urlObj = new URL(url);
            
            const requestOptions = {
                hostname: urlObj.hostname,
                port: urlObj.port,
                path: urlObj.pathname + urlObj.search,
                method: 'GET',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; TwilioPodcastBot/2.0; +https://example.com/bot)',
                    'Accept': 'application/rss+xml, application/xml, text/xml, application/atom+xml, */*',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache'
                }
            };
            
            const req = requestModule.request(requestOptions, (res) => {
                clearTimeout(timeout);
                
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    resolve({
                        status: res.statusCode,
                        headers: res.headers,
                        text: body,
                        ok: res.statusCode >= 200 && res.statusCode < 300
                    });
                });
            });
            
            req.on('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            });
            
            req.end();
        });
    };
    
    try {
        const response = await fetchWithTimeout(rssUrl);
        
        console.log(`HTTP Status: ${response.status}`);
        console.log(`Content-Type: ${response.headers['content-type']}`);
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        
        const xmlText = response.text;
        console.log(`XML Length: ${xmlText.length} characters`);
        
        // Validate XML content
        if (xmlText.length < 100) {
            throw new Error('RSS feed too short');
        }
        
        if (xmlText.includes('<html') || xmlText.includes('<!DOCTYPE html')) {
            throw new Error('Received HTML instead of XML/RSS');
        }
        
        if (!xmlText.includes('<rss') && !xmlText.includes('<feed') && !xmlText.includes('<channel')) {
            throw new Error('Content does not appear to be RSS/Atom feed');
        }
        
        const episodes = [];
        
        // Try different item patterns for RSS and Atom feeds
        let itemMatches = xmlText.match(/<item[\s\S]*?<\/item>/gi) || 
                         xmlText.match(/<entry[\s\S]*?<\/entry>/gi);
        
        console.log(`Episodes found: ${itemMatches ? itemMatches.length : 0}`);
        
        if (!itemMatches || itemMatches.length === 0) {
            console.log(`No episodes found in feed. First 500 chars of XML:`, xmlText.substring(0, 500));
            return [];
        }
        
        // Process episodes (limit to first 15 for better performance)
        for (let i = 0; i < Math.min(itemMatches.length, 15); i++) {
            const item = itemMatches[i];
            
            // Enhanced title extraction
            const titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/i) ||
                              item.match(/<title[^>]*>(.*?)<\/title>/i);
            
            // Enhanced audio URL extraction with more patterns
            const enclosureMatch = item.match(/<enclosure[^>]+url=["']([^"']+)["'][^>]*/i) ||
                                  item.match(/<media:content[^>]+url=["']([^"']+)["'][^>]*/i) ||
                                  item.match(/<link[^>]+href=["']([^"']+)["'][^>]*type=["']audio[^"']*["']/i) ||
                                  item.match(/<guid[^>]*>([^<]+)<\/guid>/i);
            
            if (titleMatch && enclosureMatch) {
                const title = titleMatch[1]
                    .replace(/<[^>]*>/g, '')
                    .replace(/&lt;/g, '<')
                    .replace(/&gt;/g, '>')
                    .replace(/&amp;/g, '&')
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
                
                // Validate that the URL looks like an audio URL
                const isValidAudioUrl = audioUrl.startsWith('http') && (
                    audioUrl.includes('.mp3') ||
                    audioUrl.includes('.mp4') ||
                    audioUrl.includes('.m4a') ||
                    audioUrl.includes('.aac') ||
                    audioUrl.includes('.ogg') ||
                    audioUrl.includes('audio') ||
                    audioUrl.includes('media') ||
                    audioUrl.includes('cdn')
                );
                
                if (isValidAudioUrl && title.length > 0) {
                    episodes.push({
                        title: title,
                        audioUrl: audioUrl
                    });
                    
                    console.log(`✓ Episode ${i + 1}: "${title.substring(0, 60)}"`);
                } else {
                    console.log(`✗ Skipped episode ${i + 1}: Invalid URL or title`);
                }
            }
        }
        
        console.log(`Successfully parsed ${episodes.length} episodes`);
        return episodes;
        
    } catch (error) {
        console.error(`Fetch error: ${error.message}`);
        return [];
    }
}

module.exports = {
    cleanAudioUrl,
    resolveSimplecastInjector,
    resolveAndValidateUrl,
    fetchPodcastEpisodes,
    VOICE_CONFIG,
    CHUNK_DURATION,
    SKIP_DURATION
};