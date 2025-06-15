const fs = require('fs');
const path = require('path');
const axios = require('axios');

class EpisodeCache {
  constructor() {
    this.cacheDir = path.join(__dirname, 'cached_episodes');
    this.metadataFile = path.join(this.cacheDir, 'cache_metadata.json');
    this.maxCacheSize = 2000; // 2GB limit
    this.ensureCacheDirectory();
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
    
    // Check if latest episode (permanent) or temporary (24 hours)
    if (episode.type === 'latest') {
      return true;
    } else if (episode.type === 'temporary') {
      const isExpired = Date.now() - episode.downloadTime > 24 * 60 * 60 * 1000; // 24 hours
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
      
      // Remove temporary episodes older than 24 hours
      if (episode.type === 'temporary') {
        const isExpired = now - episode.downloadTime > 24 * 60 * 60 * 1000;
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
}

module.exports = EpisodeCache;