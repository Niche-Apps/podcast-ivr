const fs = require('fs');
const path = require('path');

class CallerSessions {
  constructor() {
    this.sessionsFile = path.join(__dirname, 'caller_sessions.json');
    this.sessions = this.loadSessions();
    
    // Clean up old sessions every hour
    setInterval(() => this.cleanupOldSessions(), 60 * 60 * 1000);
  }

  // Load sessions from file
  loadSessions() {
    try {
      if (fs.existsSync(this.sessionsFile)) {
        return JSON.parse(fs.readFileSync(this.sessionsFile, 'utf8'));
      }
    } catch (error) {
      console.error('❌ Failed to load caller sessions:', error.message);
    }
    return {};
  }

  // Save sessions to file
  saveSessions() {
    try {
      fs.writeFileSync(this.sessionsFile, JSON.stringify(this.sessions, null, 2));
    } catch (error) {
      console.error('❌ Failed to save caller sessions:', error.message);
    }
  }

  // Create session key from phone number
  getSessionKey(phoneNumber) {
    // Remove country code and format consistently
    return phoneNumber.replace(/\D/g, '').slice(-10);
  }

  // Update caller's current position in episode
  updatePosition(phoneNumber, channelId, episodeUrl, positionSeconds, episodeTitle) {
    const sessionKey = this.getSessionKey(phoneNumber);
    
    this.sessions[sessionKey] = {
      phoneNumber,
      channelId,
      episodeUrl,
      episodeTitle,
      positionSeconds,
      lastUpdated: Date.now(),
      playbackSpeed: this.sessions[sessionKey]?.playbackSpeed || 1.25 // Default 1.25x speed
    };
    
    this.saveSessions();
    console.log(`💾 Updated position for ${phoneNumber}: ${Math.floor(positionSeconds / 60)}:${(positionSeconds % 60).toString().padStart(2, '0')} in "${episodeTitle}"`);
  }

  // Get caller's last position
  getLastPosition(phoneNumber) {
    const sessionKey = this.getSessionKey(phoneNumber);
    const session = this.sessions[sessionKey];
    
    if (!session) return null;
    
    // Check if session is recent (within 7 days)
    const daysSinceLastUpdate = (Date.now() - session.lastUpdated) / (1000 * 60 * 60 * 24);
    if (daysSinceLastUpdate > 7) {
      delete this.sessions[sessionKey];
      this.saveSessions();
      return null;
    }
    
    return session;
  }

  // Check if caller has a resumable session
  hasResumableSession(phoneNumber) {
    const session = this.getLastPosition(phoneNumber);
    return session && session.positionSeconds > 30; // Only offer resume if more than 30 seconds in
  }

  // Generate resume prompt for TwiML
  generateResumePrompt(phoneNumber) {
    const session = this.getLastPosition(phoneNumber);
    if (!session) return null;
    
    const minutes = Math.floor(session.positionSeconds / 60);
    const seconds = session.positionSeconds % 60;
    const timeString = seconds > 0 ? `${minutes} minutes and ${seconds} seconds` : `${minutes} minutes`;
    
    return {
      prompt: `Welcome back! You were listening to "${session.episodeTitle}" at ${timeString}. Press 1 to resume, or 2 to start over.`,
      session: session
    };
  }

  // Clear caller's session
  clearSession(phoneNumber) {
    const sessionKey = this.getSessionKey(phoneNumber);
    if (this.sessions[sessionKey]) {
      delete this.sessions[sessionKey];
      this.saveSessions();
      console.log(`🗑️ Cleared session for ${phoneNumber}`);
    }
  }

  // Update playback speed preference
  updatePlaybackSpeed(phoneNumber, speed) {
    const sessionKey = this.getSessionKey(phoneNumber);
    if (this.sessions[sessionKey]) {
      this.sessions[sessionKey].playbackSpeed = speed;
      this.saveSessions();
      console.log(`⚡ Updated playback speed for ${phoneNumber}: ${speed}x`);
    }
  }

  // Get playback speed preference
  getPlaybackSpeed(phoneNumber) {
    const sessionKey = this.getSessionKey(phoneNumber);
    return this.sessions[sessionKey]?.playbackSpeed || 1.25;
  }

  // Clean up sessions older than 7 days
  cleanupOldSessions() {
    const cutoffTime = Date.now() - (7 * 24 * 60 * 60 * 1000); // 7 days
    let cleanedCount = 0;
    
    Object.keys(this.sessions).forEach(sessionKey => {
      if (this.sessions[sessionKey].lastUpdated < cutoffTime) {
        delete this.sessions[sessionKey];
        cleanedCount++;
      }
    });
    
    if (cleanedCount > 0) {
      console.log(`🧹 Cleaned up ${cleanedCount} old caller sessions`);
      this.saveSessions();
    }
  }

  // Update caller's zipcode preference
  updateZipcode(phoneNumber, zipcode) {
    const sessionKey = this.getSessionKey(phoneNumber);
    
    if (!this.sessions[sessionKey]) {
      this.sessions[sessionKey] = {
        phoneNumber,
        lastUpdated: Date.now()
      };
    }
    
    this.sessions[sessionKey].weatherZipcode = zipcode;
    this.sessions[sessionKey].lastUpdated = Date.now();
    
    this.saveSessions();
    console.log(`📍 Updated zipcode for ${phoneNumber}: ${zipcode}`);
  }

  // Get caller's saved zipcode
  getSavedZipcode(phoneNumber) {
    const sessionKey = this.getSessionKey(phoneNumber);
    const session = this.sessions[sessionKey];
    
    if (!session) return null;
    
    // Check if session is recent (within 30 days for weather preferences)
    const daysSinceLastUpdate = (Date.now() - session.lastUpdated) / (1000 * 60 * 60 * 24);
    if (daysSinceLastUpdate > 30) {
      return null;
    }
    
    return session.weatherZipcode || null;
  }

  // Check if caller has a saved zipcode
  hasSavedZipcode(phoneNumber) {
    return this.getSavedZipcode(phoneNumber) !== null;
  }

  // Generate zipcode memory prompt for TwiML
  generateZipcodePrompt(phoneNumber) {
    const savedZipcode = this.getSavedZipcode(phoneNumber);
    if (!savedZipcode) return null;
    
    return {
      prompt: `Welcome back! I remember your zipcode is ${savedZipcode.split('').join(' ')}. Press 1 to use this zipcode, or 2 to enter a different one.`,
      zipcode: savedZipcode
    };
  }

  // Get session statistics
  getStats() {
    const sessions = Object.values(this.sessions);
    const now = Date.now();
    
    return {
      totalSessions: sessions.length,
      activeSessions: sessions.filter(s => (now - s.lastUpdated) < 24 * 60 * 60 * 1000).length, // Last 24h
      averagePosition: sessions.length > 0 ? Math.round(sessions.reduce((sum, s) => sum + s.positionSeconds, 0) / sessions.length) : 0,
      savedZipcodes: sessions.filter(s => s.weatherZipcode).length,
      speedPreferences: {
        '1x': sessions.filter(s => s.playbackSpeed === 1).length,
        '1.25x': sessions.filter(s => s.playbackSpeed === 1.25).length,
        '1.5x': sessions.filter(s => s.playbackSpeed === 1.5).length,
        '2x': sessions.filter(s => s.playbackSpeed === 2).length
      }
    };
  }

  // Calculate ad break positions (every 10 minutes)
  getAdBreakPositions(episodeDurationSeconds) {
    const adInterval = 10 * 60; // 10 minutes
    const positions = [];
    
    for (let pos = adInterval; pos < episodeDurationSeconds; pos += adInterval) {
      positions.push(pos);
    }
    
    return positions;
  }

  // Check if current position should trigger an ad break
  shouldShowAd(positionSeconds, lastAdPosition = 0) {
    const adInterval = 10 * 60; // 10 minutes
    const nextAdPosition = Math.floor(lastAdPosition / adInterval + 1) * adInterval;
    
    return positionSeconds >= nextAdPosition;
  }
}

module.exports = CallerSessions;