const fs = require('fs');
const path = require('path');
const axios = require('axios');

const AD_CONFIG_FILE = path.join(__dirname, 'ad-config.json');
const EXEMPT_NUMBERS_FILE = path.join(__dirname, 'ad-exempt-numbers.json');

class AdSystem {
  constructor() {
    this.loadConfig();
    this.sessionData = new Map(); // Track ad state per call session
  }

  loadConfig() {
    try {
      this.config = JSON.parse(fs.readFileSync(AD_CONFIG_FILE, 'utf8'));
      this.exemptNumbers = JSON.parse(fs.readFileSync(EXEMPT_NUMBERS_FILE, 'utf8'));
      console.log('📺 Ad system configuration loaded');
    } catch (error) {
      console.error('❌ Failed to load ad configuration:', error.message);
      this.config = { providers: {}, customAds: { preroll: [], midroll: [] } };
      this.exemptNumbers = { exemptNumbers: [] };
    }
  }

  // Check if caller is exempt from ads
  isExemptFromAds(phoneNumber) {
    const normalized = this.normalizePhoneNumber(phoneNumber);
    return this.exemptNumbers.exemptNumbers.some(exempt => 
      this.normalizePhoneNumber(exempt.number) === normalized
    );
  }

  normalizePhoneNumber(number) {
    if (!number) return '';
    return number.replace(/\D/g, '').replace(/^1/, '');
  }

  // Initialize ad session for a caller
  initSession(callSid, phoneNumber) {
    const isExempt = this.isExemptFromAds(phoneNumber);
    
    this.sessionData.set(callSid, {
      phoneNumber: this.normalizePhoneNumber(phoneNumber),
      isExempt,
      adsPlayed: [],
      lastMidrollTime: null,
      totalAdsPlayed: 0,
      sessionStartTime: Date.now()
    });

    console.log(`📺 Ad session initialized for ${phoneNumber} - Exempt: ${isExempt}`);
    return !isExempt;
  }

  // Get preroll ad for session start
  async getPrerollAd(callSid, channelId, channelName) {
    const session = this.sessionData.get(callSid);
    if (!session || session.isExempt) {
      return null;
    }

    // Check if we should show preroll based on frequency
    const prerollChance = this.config.providers.custom.frequency.preroll;
    if (Math.random() * 100 > prerollChance) {
      console.log(`🎲 Skipping preroll (${prerollChance}% chance)`);
      return null;
    }

    try {
      // Try custom ads first
      const customAd = await this.selectCustomAd('preroll', channelId);
      if (customAd) {
        return this.formatAdResponse(customAd, 'preroll', callSid);
      }

      // Try external provider
      const providerAd = await this.getProviderAd('preroll', channelId, channelName);
      if (providerAd) {
        return this.formatAdResponse(providerAd, 'preroll', callSid);
      }

      console.log('📺 No preroll ad available');
      return null;

    } catch (error) {
      console.error('❌ Error getting preroll ad:', error.message);
      return null;
    }
  }

  // Get midroll ad during podcast playback
  async getMidrollAd(callSid, channelId, channelName, currentPlaybackTime) {
    const session = this.sessionData.get(callSid);
    if (!session || session.isExempt) {
      return null;
    }

    // Check if enough time has passed since last midroll
    const midrollInterval = this.config.settings.midrollIntervalMinutes * 60 * 1000; // ms
    const now = Date.now();
    
    if (session.lastMidrollTime && (now - session.lastMidrollTime) < midrollInterval) {
      return null;
    }

    // Check max ads per session
    if (session.totalAdsPlayed >= this.config.settings.maxAdsPerSession) {
      console.log(`🚫 Max ads per session reached (${this.config.settings.maxAdsPerSession})`);
      return null;
    }

    // Check midroll frequency
    const midrollChance = this.config.providers.custom.frequency.midroll;
    if (Math.random() * 100 > midrollChance) {
      console.log(`🎲 Skipping midroll (${midrollChance}% chance)`);
      return null;
    }

    try {
      // Try custom ads first
      const customAd = await this.selectCustomAd('midroll', channelId);
      if (customAd) {
        session.lastMidrollTime = now;
        return this.formatAdResponse(customAd, 'midroll', callSid);
      }

      // Try external provider
      const providerAd = await this.getProviderAd('midroll', channelId, channelName);
      if (providerAd) {
        session.lastMidrollTime = now;
        return this.formatAdResponse(providerAd, 'midroll', callSid);
      }

      console.log('📺 No midroll ad available');
      return null;

    } catch (error) {
      console.error('❌ Error getting midroll ad:', error.message);
      return null;
    }
  }

  // Select custom ad based on weight
  async selectCustomAd(adType, channelId) {
    const ads = this.config.customAds[adType]?.filter(ad => ad.active) || [];
    if (ads.length === 0) return null;

    // Weighted random selection
    const totalWeight = ads.reduce((sum, ad) => sum + (ad.weight || 50), 0);
    let random = Math.random() * totalWeight;

    for (const ad of ads) {
      random -= (ad.weight || 50);
      if (random <= 0) {
        console.log(`📺 Selected custom ${adType} ad: ${ad.name}`);
        return ad;
      }
    }

    // Fallback to first ad
    return ads[0];
  }

  // Get ad from external provider (Spotify, etc.)
  async getProviderAd(adType, channelId, channelName) {
    const provider = this.config.providers.spotify;
    if (!provider.enabled || !provider[adType + 'Enabled']) {
      return null;
    }

    try {
      // This is a placeholder for actual provider integration
      // Each provider will have different API endpoints and formats
      console.log(`🔍 Requesting ${adType} ad from provider for channel ${channelId}`);
      
      // Example provider request (would need actual implementation)
      const response = await axios.post(provider.apiUrl, {
        adType,
        channelId,
        channelName,
        targetDemographic: 'podcast_listeners',
        maxDuration: 30
      }, {
        headers: {
          'Authorization': `Bearer ${provider.apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 5000
      });

      if (response.data && response.data.ad) {
        console.log(`✅ Provider ad received: ${response.data.ad.name}`);
        return {
          id: response.data.ad.id,
          name: response.data.ad.name,
          audioUrl: response.data.ad.audioUrl,
          duration: response.data.ad.duration,
          sponsor: response.data.ad.advertiser,
          revenue: response.data.ad.payout || 0
        };
      }

      return null;

    } catch (error) {
      console.error(`❌ Provider ad request failed: ${error.message}`);
      return null;
    }
  }

  // Format ad response for TwiML consumption
  formatAdResponse(ad, adType, callSid) {
    const session = this.sessionData.get(callSid);
    if (session) {
      session.totalAdsPlayed++;
      session.adsPlayed.push({
        id: ad.id,
        name: ad.name,
        type: adType,
        timestamp: new Date(),
        revenue: ad.revenue || 0
      });
    }

    return {
      id: ad.id,
      name: ad.name,
      type: adType,
      audioUrl: ad.audioUrl,
      duration: ad.duration || 30,
      sponsor: ad.sponsor,
      revenue: ad.revenue || 0,
      skipAfter: this.config.settings.skipAdAfterSeconds,
      volumeAdjustment: this.config.settings.adVolumeAdjustment
    };
  }

  // Track ad completion
  trackAdPlayed(callSid, adId, playbackDuration, skipped = false) {
    const session = this.sessionData.get(callSid);
    if (!session) return;

    const adRecord = session.adsPlayed.find(ad => ad.id === adId);
    if (adRecord) {
      adRecord.playbackDuration = playbackDuration;
      adRecord.skipped = skipped;
      adRecord.completedAt = new Date();
      
      console.log(`📈 Ad tracking: ${adRecord.name} - ${playbackDuration}s ${skipped ? '(skipped)' : '(completed)'}`);
    }
  }

  // Get ad statistics for session
  getSessionAdStats(callSid) {
    const session = this.sessionData.get(callSid);
    if (!session) return null;

    const totalRevenue = session.adsPlayed.reduce((sum, ad) => sum + (ad.revenue || 0), 0);
    
    return {
      totalAdsPlayed: session.totalAdsPlayed,
      adsPlayed: session.adsPlayed,
      totalRevenue: totalRevenue,
      isExempt: session.isExempt
    };
  }

  // Clean up session data
  endSession(callSid) {
    const session = this.sessionData.get(callSid);
    if (session) {
      console.log(`📺 Ad session ended: ${session.totalAdsPlayed} ads, $${session.adsPlayed.reduce((sum, ad) => sum + (ad.revenue || 0), 0).toFixed(2)} revenue`);
      this.sessionData.delete(callSid);
    }
  }

  // Add/remove exempt numbers
  addExemptNumber(phoneNumber, reason, notes = '') {
    const normalized = this.normalizePhoneNumber(phoneNumber);
    
    // Check if already exempt
    const existing = this.exemptNumbers.exemptNumbers.find(exempt => 
      this.normalizePhoneNumber(exempt.number) === normalized
    );
    
    if (existing) {
      console.log(`📞 ${phoneNumber} already exempt`);
      return false;
    }

    this.exemptNumbers.exemptNumbers.push({
      number: phoneNumber,
      reason,
      exemptSince: new Date().toISOString().split('T')[0],
      notes
    });

    this.exemptNumbers.metadata.totalExemptions = this.exemptNumbers.exemptNumbers.length;
    this.exemptNumbers.metadata.lastUpdated = new Date().toISOString().split('T')[0];

    this.saveExemptNumbers();
    console.log(`✅ Added ${phoneNumber} to ad exemption list`);
    return true;
  }

  removeExemptNumber(phoneNumber) {
    const normalized = this.normalizePhoneNumber(phoneNumber);
    const initialLength = this.exemptNumbers.exemptNumbers.length;
    
    this.exemptNumbers.exemptNumbers = this.exemptNumbers.exemptNumbers.filter(exempt => 
      this.normalizePhoneNumber(exempt.number) !== normalized
    );

    if (this.exemptNumbers.exemptNumbers.length < initialLength) {
      this.exemptNumbers.metadata.totalExemptions = this.exemptNumbers.exemptNumbers.length;
      this.exemptNumbers.metadata.lastUpdated = new Date().toISOString().split('T')[0];
      this.saveExemptNumbers();
      console.log(`✅ Removed ${phoneNumber} from ad exemption list`);
      return true;
    }

    console.log(`📞 ${phoneNumber} was not in exemption list`);
    return false;
  }

  saveExemptNumbers() {
    try {
      fs.writeFileSync(EXEMPT_NUMBERS_FILE, JSON.stringify(this.exemptNumbers, null, 2));
    } catch (error) {
      console.error('❌ Failed to save exempt numbers:', error.message);
    }
  }

  // Get system statistics
  getSystemStats() {
    const activeSessions = this.sessionData.size;
    const totalExemptions = this.exemptNumbers.exemptNumbers.length;
    
    return {
      activeSessions,
      totalExemptions,
      customAdsActive: {
        preroll: this.config.customAds.preroll?.filter(ad => ad.active).length || 0,
        midroll: this.config.customAds.midroll?.filter(ad => ad.active).length || 0
      },
      providersEnabled: Object.entries(this.config.providers).filter(([key, provider]) => provider.enabled).length
    };
  }
}

module.exports = AdSystem;