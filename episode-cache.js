const fs = require('fs');
const path = require('path');
const axios = require('axios');

class EpisodeCache {
  constructor() {
    this.cacheDir = path.join(__dirname, 'cached_episodes');
    this.metadataFile = path.join(this.cacheDir, 'cache_metadata.json');
    this.maxCacheSize = 10000; // 10GB limit - increased for better coverage
    this.ensureCacheDirectory();
    this.backgroundJobs = new Map(); // Track background caching jobs
  }

  ensureCacheDirectory() {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      console.log('📁 Created episode cache directory');
    }
  }

  // Load cache metadata
  loadMetadata() {
    try {
      if (fs.existsSync(this.metadataFile)) {
        return JSON.parse(fs.readFileSync(this.metadataFile, 'utf8'));
      }
    } catch (error) {
      console.error('❌ Failed to load cache metadata:', error.message);
    }
    return { episodes: {}, lastCleanup: Date.now() };
  }

  // Save cache metadata
  saveMetadata(metadata) {
    try {
      fs.writeFileSync(this.metadataFile, JSON.stringify(metadata, null, 2));
    } catch (error) {
      console.error('❌ Failed to save cache metadata:', error.message);
    }
  }

  // Generate cache key for episode
  getCacheKey(channelId, episodeUrl) {
    const hash = require('crypto').createHash('md5').update(episodeUrl).digest('hex');
    return `${channelId}_${hash}`;
  }

  // Check if episode is cached and valid
  isCached(channelId, episodeUrl) {
    const metadata = this.loadMetadata();
    const cacheKey = this.getCacheKey(channelId, episodeUrl);
    const episode = metadata.episodes[cacheKey];
    
    if (!episode) return false;
    
    const filePath = path.join(this.cacheDir, episode.filename);
    if (!fs.existsSync(filePath)) {
      // File missing, remove from metadata
      delete metadata.episodes[cacheKey];
      this.saveMetadata(metadata);
      return false;
    }
    
    // Check if latest episode (permanent until replaced) or temporary (48 hours)
    if (episode.type === 'latest') {
      return true;
    } else if (episode.type === 'temporary') {
      const isExpired = Date.now() - episode.downloadTime > 48 * 60 * 60 * 1000; // 48 hours
      if (isExpired) {
        this.removeEpisode(cacheKey);
        return false;
      }
      return true;
    }
    
    return false;
  }

  // Get cached episode file path
  getCachedEpisodePath(channelId, episodeUrl) {
    const metadata = this.loadMetadata();
    const cacheKey = this.getCacheKey(channelId, episodeUrl);
    const episode = metadata.episodes[cacheKey];
    
    if (episode && fs.existsSync(path.join(this.cacheDir, episode.filename))) {
      return path.join(this.cacheDir, episode.filename);
    }
    
    return null;
  }

  // Download and cache episode
  async cacheEpisode(channelId, episodeUrl, episodeTitle, type = 'temporary') {
    const cacheKey = this.getCacheKey(channelId, episodeUrl);
    const filename = `${cacheKey}.mp3`;
    const filePath = path.join(this.cacheDir, filename);
    
    console.log(`📥 Downloading episode: ${episodeTitle}`);
    console.log(`🔗 URL: ${episodeUrl}`);
    
    try {
      // Download episode with progress tracking
      const response = await axios({
        method: 'GET',
        url: episodeUrl,
        responseType: 'stream',
        timeout: 30000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; PodcastIVR/1.0)',
          'Accept': 'audio/mpeg,audio/*,*/*'
        }
      });
      
      const writer = fs.createWriteStream(filePath);
      let downloadedBytes = 0;
      const totalBytes = parseInt(response.headers['content-length'] || '0');
      
      response.data.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        if (totalBytes > 0) {
          const progress = Math.round((downloadedBytes / totalBytes) * 100);
          if (progress % 10 === 0) { // Log every 10%
            console.log(`📊 Download progress: ${progress}% (${Math.round(downloadedBytes / 1024 / 1024)}MB)`);
          }
        }
      });
      
      response.data.pipe(writer);
      
      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });
      
      // Update metadata
      const metadata = this.loadMetadata();
      metadata.episodes[cacheKey] = {
        channelId,
        episodeUrl,
        episodeTitle,
        filename,
        downloadTime: Date.now(),
        type, // 'latest' or 'temporary'
        fileSize: fs.statSync(filePath).size
      };
      
      this.saveMetadata(metadata);
      
      console.log(`✅ Episode cached: ${episodeTitle} (${Math.round(fs.statSync(filePath).size / 1024 / 1024)}MB)`);
      return filePath;
      
    } catch (error) {
      console.error(`❌ Failed to cache episode:`, error.message);
      // Clean up partial download
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      throw error;
    }
  }

  // Remove episode from cache
  removeEpisode(cacheKey) {
    const metadata = this.loadMetadata();
    const episode = metadata.episodes[cacheKey];
    
    if (episode) {
      const filePath = path.join(this.cacheDir, episode.filename);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`🗑️ Removed cached episode: ${episode.episodeTitle}`);
      }
      delete metadata.episodes[cacheKey];
      this.saveMetadata(metadata);
    }
  }

  // Clean up expired episodes
  cleanupExpiredEpisodes() {
    const metadata = this.loadMetadata();
    const now = Date.now();
    let cleanedCount = 0;
    
    Object.keys(metadata.episodes).forEach(cacheKey => {
      const episode = metadata.episodes[cacheKey];
      
      // Remove temporary episodes older than 48 hours
      if (episode.type === 'temporary') {
        const isExpired = now - episode.downloadTime > 48 * 60 * 60 * 1000;
        if (isExpired) {
          this.removeEpisode(cacheKey);
          cleanedCount++;
        }
      }
    });
    
    if (cleanedCount > 0) {
      console.log(`🧹 Cleaned up ${cleanedCount} expired episodes`);
    }
    
    // Update last cleanup time
    metadata.lastCleanup = now;
    this.saveMetadata(metadata);
  }

  // Get cache statistics
  getCacheStats() {
    const metadata = this.loadMetadata();
    const episodes = Object.values(metadata.episodes);
    
    const stats = {
      totalEpisodes: episodes.length,
      latestEpisodes: episodes.filter(e => e.type === 'latest').length,
      temporaryEpisodes: episodes.filter(e => e.type === 'temporary').length,
      totalSizeMB: Math.round(episodes.reduce((sum, e) => sum + (e.fileSize || 0), 0) / 1024 / 1024),
      lastCleanup: new Date(metadata.lastCleanup || 0).toISOString()
    };
    
    return stats;
  }

  // Auto-download latest episode for channel if not cached
  async ensureLatestEpisode(channelId, latestEpisodeUrl, episodeTitle) {
    if (!this.isCached(channelId, latestEpisodeUrl)) {
      // Remove old latest episode for this channel
      const metadata = this.loadMetadata();
      Object.keys(metadata.episodes).forEach(cacheKey => {
        const episode = metadata.episodes[cacheKey];
        if (episode.channelId === channelId && episode.type === 'latest') {
          this.removeEpisode(cacheKey);
        }
      });
      
      // Download new latest episode
      await this.cacheEpisode(channelId, latestEpisodeUrl, episodeTitle, 'latest');
    }
  }

  // Start background caching for an episode without blocking caller
  startBackgroundCaching(channelId, episodeUrl, episodeTitle) {
    const cacheKey = this.getCacheKey(channelId, episodeUrl);
    
    // Don't start if already caching or cached
    if (this.backgroundJobs.has(cacheKey) || this.isCached(channelId, episodeUrl)) {
      return false;
    }
    
    console.log(`📥 Starting background cache: ${episodeTitle.substring(0, 50)}`);
    
    // Start background job
    const promise = this.cacheEpisode(channelId, episodeUrl, episodeTitle, 'temporary')
      .then(filePath => {
        console.log(`✅ Background cache completed: ${episodeTitle.substring(0, 50)}`);
        this.backgroundJobs.delete(cacheKey);
        return filePath;
      })
      .catch(error => {
        console.error(`❌ Background cache failed: ${episodeTitle.substring(0, 50)} - ${error.message}`);
        this.backgroundJobs.delete(cacheKey);
        return null;
      });
    
    this.backgroundJobs.set(cacheKey, promise);
    return true;
  }

  // Check if episode is currently being cached in background
  isBackgroundCaching(channelId, episodeUrl) {
    const cacheKey = this.getCacheKey(channelId, episodeUrl);
    return this.backgroundJobs.has(cacheKey);
  }

  // Get background caching promise if exists
  getBackgroundCachingPromise(channelId, episodeUrl) {
    const cacheKey = this.getCacheKey(channelId, episodeUrl);
    return this.backgroundJobs.get(cacheKey);
  }

  // Check for newer episodes and update latest cache
  async checkForNewerEpisodes(channelId, currentLatestUrl, fetchEpisodesFunction, rssUrl) {
    try {
      console.log(`🔍 Checking for newer episodes on channel ${channelId}`);
      
      // Fetch the latest episode from RSS
      const episodes = await fetchEpisodesFunction(rssUrl, 0, 1, channelId);
      
      if (episodes && episodes.length > 0) {
        const latestEpisode = episodes[0];
        
        // If the latest episode URL is different from what we have cached
        if (latestEpisode.audioUrl !== currentLatestUrl) {
          console.log(`🆕 New episode detected for channel ${channelId}: ${latestEpisode.title.substring(0, 50)}`);
          
          // Cache the new latest episode
          await this.ensureLatestEpisode(channelId, latestEpisode.audioUrl, latestEpisode.title);
          
          return {
            hasNewer: true,
            newEpisode: latestEpisode
          };
        }
      }
      
      return { hasNewer: false };
      
    } catch (error) {
      console.error(`❌ Failed to check for newer episodes on channel ${channelId}: ${error.message}`);
      return { hasNewer: false };
    }
  }

  // Get the latest cached episode for a channel
  getLatestCachedEpisode(channelId) {
    const metadata = this.loadMetadata();
    
    for (const [cacheKey, episode] of Object.entries(metadata.episodes)) {
      if (episode.channelId === channelId && episode.type === 'latest') {
        return {
          cacheKey,
          episode,
          filePath: this.getCachedEpisodePath(channelId, episode.episodeUrl)
        };
      }
    }
    
    return null;
  }

  // Preload latest episodes for all active channels
  async preloadLatestEpisodes(channels, fetchEpisodesFunction) {
    console.log(`🚀 Preloading latest episodes for ${Object.keys(channels).length} channels`);
    
    const promises = Object.entries(channels).map(async ([channelId, podcast]) => {
      try {
        if (podcast.rssUrl && !podcast.rssUrl.startsWith('STATIC_') && !podcast.rssUrl.startsWith('YOUTUBE_')) {
          const episodes = await fetchEpisodesFunction(podcast.rssUrl, 0, 1, channelId);
          
          if (episodes && episodes.length > 0) {
            const latestEpisode = episodes[0];
            await this.ensureLatestEpisode(channelId, latestEpisode.audioUrl, latestEpisode.title);
            console.log(`✅ Preloaded latest for ${podcast.name}: ${latestEpisode.title.substring(0, 40)}`);
          }
        }
      } catch (error) {
        console.warn(`⚠️ Failed to preload latest for ${podcast.name}: ${error.message}`);
      }
    });
    
    await Promise.allSettled(promises);
    console.log(`🎯 Latest episode preloading completed`);
  }
}

module.exports = EpisodeCache;