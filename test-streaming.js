// Test the streaming functionality
const { fetchPodcastEpisodes, cleanAudioUrl } = require('./podcast-streaming');

async function testStreaming() {
    console.log('🧪 Testing RSS feed streaming...\n');
    
    // Test NPR News Now
    console.log('=== Testing NPR News Now ===');
    const nprUrl = 'https://feeds.npr.org/500005/podcast.xml';
    
    try {
        const episodes = await fetchPodcastEpisodes(nprUrl);
        console.log(`✅ Found ${episodes.length} NPR episodes`);
        
        if (episodes.length > 0) {
            const episode = episodes[0];
            console.log(`Latest episode: "${episode.title.substring(0, 60)}"`);
            console.log(`Raw URL: ${episode.audioUrl.substring(0, 80)}...`);
            
            const cleanedUrl = cleanAudioUrl(episode.audioUrl);
            console.log(`Cleaned URL: ${cleanedUrl.substring(0, 80)}...`);
            
            if (cleanedUrl !== episode.audioUrl) {
                console.log(`✅ URL cleaning worked - removed tracking`);
            } else {
                console.log(`ℹ️ No tracking detected in URL`);
            }
        }
    } catch (error) {
        console.error(`❌ NPR test failed:`, error.message);
    }
    
    console.log('\n=== Testing The Daily (Simplecast) ===');
    const dailyUrl = 'https://feeds.simplecast.com/54nAGcIl';
    
    try {
        const episodes = await fetchPodcastEpisodes(dailyUrl);
        console.log(`✅ Found ${episodes.length} The Daily episodes`);
        
        if (episodes.length > 0) {
            const episode = episodes[0];
            console.log(`Latest episode: "${episode.title.substring(0, 60)}"`);
            console.log(`Raw URL: ${episode.audioUrl.substring(0, 80)}...`);
            
            const cleanedUrl = cleanAudioUrl(episode.audioUrl);
            console.log(`Cleaned URL: ${cleanedUrl.substring(0, 80)}...`);
            
            if (cleanedUrl.includes('simplecastaudio.com')) {
                console.log(`✅ Simplecast URL detected - will need resolution`);
            }
        }
    } catch (error) {
        console.error(`❌ The Daily test failed:`, error.message);
    }
    
    console.log('\n🎯 Streaming test complete!');
}

testStreaming();