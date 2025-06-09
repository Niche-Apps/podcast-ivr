#!/usr/bin/env node

// Test all podcast channels for playback issues
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// Load configuration
const podcastConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'podcast-feeds.json'), 'utf8'));
const ALL_PODCASTS = podcastConfig.feeds;

// RSS fetching function (simplified from server.js)
async function fetchPodcastEpisodes(rssUrl) {
    console.log(`🔍 Testing: ${rssUrl.substring(0, 60)}...`);
    
    try {
        const response = await axios.get(rssUrl, {
            timeout: 8000,
            maxRedirects: 3,
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; TwilioPodcastBot/2.0)',
                'Accept': 'application/rss+xml, application/xml, text/xml, */*'
            }
        });
        
        const xmlText = response.data;
        const episodes = [];
        
        // Simple regex-based episode extraction
        const itemMatches = xmlText.match(/<item[\s\S]*?<\/item>/gi) || [];
        
        // Process first episode only for testing
        if (itemMatches.length > 0) {
            const item = itemMatches[0];
            
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
                
                if (audioUrl.startsWith('http') && title.length > 0) {
                    episodes.push({ title, audioUrl });
                }
            }
        }
        
        return episodes;
        
    } catch (error) {
        console.error(`❌ RSS fetch failed: ${error.message}`);
        return [];
    }
}

// Enhanced URL cleaning function to handle complex redirect chains
function cleanAudioUrl(url) {
    if (!url || typeof url !== 'string') return url;
    
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
                        break;
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

// Test URL accessibility
async function testUrlAccess(url) {
    try {
        const response = await axios({
            method: 'HEAD',
            url: url,
            timeout: 25000, // Increased timeout for slow Libsyn redirects
            maxRedirects: 15, // Increased for complex redirect chains
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; TwilioPodcastBot/2.0)',
                'Accept': 'audio/mpeg, audio/mp4, audio/*, */*'
            }
        });
        
        return {
            accessible: true,
            status: response.status,
            contentType: response.headers['content-type'],
            contentLength: response.headers['content-length'],
            finalUrl: response.request.res ? response.request.res.responseUrl : url
        };
    } catch (error) {
        return {
            accessible: false,
            error: error.message,
            status: error.response ? error.response.status : 'No response'
        };
    }
}

// Main test function
async function testAllChannels() {
    console.log('🧪 TESTING ALL PODCAST CHANNELS\\n');
    
    const results = [];
    
    for (const [channelId, podcast] of Object.entries(ALL_PODCASTS)) {
        console.log(`\\n📻 Channel ${channelId}: ${podcast.name}`);
        console.log(`   RSS: ${podcast.rssUrl}`);
        
        if (podcast.rssUrl === 'STATIC_TEST' || podcast.rssUrl === 'WEATHER_SERVICE' || podcast.rssUrl === 'FEEDBACK_SERVICE') {
            console.log(`   ✅ Special service channel - skipping URL test`);
            results.push({
                channelId,
                name: podcast.name,
                status: 'special_service',
                accessible: true
            });
            continue;
        }
        
        // Test RSS feed
        const episodes = await fetchPodcastEpisodes(podcast.rssUrl);
        
        if (episodes.length === 0) {
            console.log(`   ❌ No episodes found`);
            results.push({
                channelId,
                name: podcast.name,
                status: 'no_episodes',
                accessible: false
            });
            continue;
        }
        
        const episode = episodes[0];
        console.log(`   📄 Episode: "${episode.title.substring(0, 50)}..."`);
        
        // Test original URL
        console.log(`   🔗 Original URL: ${episode.audioUrl.substring(0, 60)}...`);
        const originalTest = await testUrlAccess(episode.audioUrl);
        
        // Test cleaned URL
        const cleanedUrl = cleanAudioUrl(episode.audioUrl);
        const urlChanged = cleanedUrl !== episode.audioUrl;
        console.log(`   🧹 Cleaned URL: ${cleanedUrl.substring(0, 60)}...${urlChanged ? ' (CHANGED)' : ''}`);
        
        const cleanedTest = await testUrlAccess(cleanedUrl);
        
        // Determine final result
        let finalResult;
        if (cleanedTest.accessible) {
            console.log(`   ✅ ACCESSIBLE via cleaned URL (${cleanedTest.status})`);
            finalResult = {
                channelId,
                name: podcast.name,
                status: 'working',
                accessible: true,
                originalWorked: originalTest.accessible,
                cleanedWorked: cleanedTest.accessible,
                urlCleaned: urlChanged,
                contentType: cleanedTest.contentType,
                finalUrl: cleanedTest.finalUrl
            };
        } else if (originalTest.accessible) {
            console.log(`   ⚠️ ACCESSIBLE via original URL only (${originalTest.status})`);
            finalResult = {
                channelId,
                name: podcast.name,
                status: 'original_only',
                accessible: true,
                originalWorked: originalTest.accessible,
                cleanedWorked: cleanedTest.accessible,
                urlCleaned: urlChanged,
                contentType: originalTest.contentType,
                finalUrl: originalTest.finalUrl
            };
        } else {
            console.log(`   ❌ NOT ACCESSIBLE (Original: ${originalTest.status}, Cleaned: ${cleanedTest.status})`);
            finalResult = {
                channelId,
                name: podcast.name,
                status: 'broken',
                accessible: false,
                originalWorked: originalTest.accessible,
                cleanedWorked: cleanedTest.accessible,
                urlCleaned: urlChanged,
                originalError: originalTest.error,
                cleanedError: cleanedTest.error
            };
        }
        
        results.push(finalResult);
    }
    
    // Summary report
    console.log('\\n\\n📊 CHANNEL TEST SUMMARY\\n');
    
    const working = results.filter(r => r.status === 'working' || r.status === 'special_service');
    const originalOnly = results.filter(r => r.status === 'original_only');
    const broken = results.filter(r => r.status === 'broken' || r.status === 'no_episodes');
    
    console.log(`✅ Working channels: ${working.length}`);
    working.forEach(r => console.log(`   ${r.channelId}: ${r.name}`));
    
    if (originalOnly.length > 0) {
        console.log(`\\n⚠️ Original URL only: ${originalOnly.length}`);
        originalOnly.forEach(r => console.log(`   ${r.channelId}: ${r.name}`));
    }
    
    if (broken.length > 0) {
        console.log(`\\n❌ Broken channels: ${broken.length}`);
        broken.forEach(r => console.log(`   ${r.channelId}: ${r.name} (${r.status})`));
    }
    
    console.log(`\\n📈 Success rate: ${Math.round((working.length + originalOnly.length) / results.length * 100)}%`);
    
    // Save detailed results
    fs.writeFileSync('./channel-test-results.json', JSON.stringify(results, null, 2));
    console.log(`\\n💾 Detailed results saved to channel-test-results.json`);
}

// Run the test
testAllChannels().catch(console.error);