// Test URL cleaning function
const testUrl = 'https://claritaspod.com/measure/arttrk.com/p/24FDE/verifi.podscribe.com/rss/p/pfx.vpixl.com/2jSe3/prfx.byspotify.com/e/dts.podtrac.com/redirect.mp3/mgln.ai/e/121/injector.simplecastaudio.com/d1078767-cdeb-4a60-8561-25db7745b425/episodes/916e7d4a-17b2-4d96-9be1-a7d322f78ac4/audio/128/default.mp3?aid=rss_feed&awCollectionId=d1078767-cdeb-4a60-8561-25db7745b425&awEpisodeId=916e7d4a-17b2-4d96-9be1-a7d322f78ac4&feed=pp_b9xO6';

function cleanAudioUrl(url) {
    if (!url || typeof url !== 'string') return url;
    
    console.log(`🧹 Cleaning URL: ${url.substring(0, 80)}...`);
    
    try {
        let cleaned = url;
        
        const trackingPatterns = [
            /^https?:\/\/[^\/]*claritaspod\.com\/measure\//i,
            /^https?:\/\/[^\/]*arttrk\.com\/p\/[^\/]+\//i,
            /^https?:\/\/[^\/]*podscribe\.com\/rss\/p\//i,
            /^https?:\/\/[^\/]*pfx\.vpixl\.com\/[^\/]+\//i,
            /^https?:\/\/[^\/]*prfx\.byspotify\.com\/e\//i,
            /^https?:\/\/[^\/]*dts\.podtrac\.com\/redirect\.(mp3|aac)\//i,
            /^https?:\/\/[^\/]*mgln\.ai\/e\/[^\/]+\//i,
        ];
        
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
                        console.log(`   Result: ${newUrl.substring(0, 80)}...`);
                        cleaned = newUrl;
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

const result = cleanAudioUrl(testUrl);
console.log(`\n✅ Final result: ${result}`);