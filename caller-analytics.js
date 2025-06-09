const fs = require('fs');
const path = require('path');

const ANALYTICS_FILE = path.join(__dirname, 'analytics-data.json');
const DAILY_STATS_FILE = path.join(__dirname, 'daily-stats.json');

class CallerAnalytics {
  constructor() {
    this.sessions = new Map(); // Active call sessions
    this.loadExistingData();
  }

  loadExistingData() {
    try {
      if (fs.existsSync(ANALYTICS_FILE)) {
        this.data = JSON.parse(fs.readFileSync(ANALYTICS_FILE, 'utf8'));
      } else {
        this.data = this.createEmptyAnalytics();
      }
    } catch (error) {
      console.error('❌ Failed to load analytics data:', error.message);
      this.data = this.createEmptyAnalytics();
    }
  }

  createEmptyAnalytics() {
    return {
      calls: [],
      dailyStats: {},
      callerProfiles: {},
      metadata: {
        totalCalls: 0,
        totalListeningTime: 0,
        totalAdRevenue: 0,
        lastUpdated: new Date().toISOString()
      }
    };
  }

  // Start tracking a new call session
  startSession(callSid, callerNumber, fromLocation = null) {
    const session = {
      callSid,
      callerNumber: this.normalizePhoneNumber(callerNumber),
      startTime: new Date(),
      channels: [],
      adsPlayed: [],
      totalListeningTime: 0,
      currentChannel: null,
      channelStartTime: null,
      location: fromLocation || this.getLocationFromNumber(callerNumber),
      sessionRevenue: 0
    };

    this.sessions.set(callSid, session);
    console.log(`📊 Started analytics session for ${callerNumber}`);
    return session;
  }

  // Track channel selection
  trackChannelSelection(callSid, channelId, channelName) {
    const session = this.sessions.get(callSid);
    if (!session) return;

    // End previous channel if exists
    if (session.currentChannel && session.channelStartTime) {
      this.endChannelListening(callSid);
    }

    session.currentChannel = {
      channelId,
      channelName,
      startTime: new Date(),
      adsPlayed: [],
      listeningTime: 0
    };
    session.channelStartTime = new Date();

    console.log(`🎧 ${session.callerNumber} selected channel ${channelId}: ${channelName}`);
  }

  // End channel listening (when switching or hanging up)
  endChannelListening(callSid) {
    const session = this.sessions.get(callSid);
    if (!session || !session.currentChannel || !session.channelStartTime) return;

    const listeningTime = (new Date() - session.channelStartTime) / 1000; // seconds
    session.currentChannel.listeningTime = listeningTime;
    session.totalListeningTime += listeningTime;

    session.channels.push({...session.currentChannel});
    session.currentChannel = null;
    session.channelStartTime = null;

    console.log(`⏱️ Channel listening ended: ${Math.round(listeningTime)}s`);
  }

  // Track ad playback
  trackAdPlayed(callSid, adData) {
    const session = this.sessions.get(callSid);
    if (!session) return;

    const adEvent = {
      timestamp: new Date(),
      adId: adData.id,
      adName: adData.name || 'Unknown Ad',
      adType: adData.type, // 'preroll' or 'midroll'
      sponsor: adData.sponsor,
      revenue: adData.revenue || 0,
      duration: adData.duration || 0,
      channelId: session.currentChannel?.channelId,
      channelName: session.currentChannel?.channelName
    };

    session.adsPlayed.push(adEvent);
    session.sessionRevenue += adEvent.revenue;

    if (session.currentChannel) {
      session.currentChannel.adsPlayed.push(adEvent);
    }

    console.log(`💰 Ad played: ${adEvent.adName} - $${adEvent.revenue}`);
  }

  // Track feedback submission
  trackFeedback(callSid, feedbackData) {
    const session = this.sessions.get(callSid);
    if (!session) return;

    session.feedback = {
      timestamp: new Date(),
      duration: feedbackData.duration,
      transcription: feedbackData.transcription,
      recordingUrl: feedbackData.recordingUrl,
      sentiment: feedbackData.sentiment || 'unknown'
    };

    console.log(`🎤 Feedback recorded from ${session.callerNumber}`);
  }

  // End call session and save data
  endSession(callSid, endReason = 'hangup') {
    const session = this.sessions.get(callSid);
    if (!session) return;

    // End current channel listening
    if (session.currentChannel) {
      this.endChannelListening(callSid);
    }

    session.endTime = new Date();
    session.totalDuration = (session.endTime - session.startTime) / 1000; // seconds
    session.endReason = endReason;

    // Create call record
    const callRecord = {
      callSid: session.callSid,
      callerNumber: session.callerNumber,
      startTime: session.startTime,
      endTime: session.endTime,
      totalDuration: session.totalDuration,
      totalListeningTime: session.totalListeningTime,
      channelsVisited: session.channels.length,
      channels: session.channels,
      adsPlayed: session.adsPlayed,
      totalAdsPlayed: session.adsPlayed.length,
      sessionRevenue: session.sessionRevenue,
      location: session.location,
      endReason: session.endReason,
      feedback: session.feedback || null
    };

    // Save to analytics data
    this.data.calls.push(callRecord);
    this.data.metadata.totalCalls++;
    this.data.metadata.totalListeningTime += session.totalListeningTime;
    this.data.metadata.totalAdRevenue += session.sessionRevenue;
    this.data.metadata.lastUpdated = new Date().toISOString();

    // Update caller profile
    this.updateCallerProfile(callRecord);

    // Update daily stats
    this.updateDailyStats(callRecord);

    // Save to file
    this.saveAnalytics();

    console.log(`📋 Session ended: ${session.callerNumber} - ${Math.round(session.totalDuration)}s total, $${session.sessionRevenue} revenue`);

    // Remove from active sessions
    this.sessions.delete(callSid);
  }

  updateCallerProfile(callRecord) {
    const number = callRecord.callerNumber;
    
    if (!this.data.callerProfiles[number]) {
      this.data.callerProfiles[number] = {
        firstCall: callRecord.startTime,
        totalCalls: 0,
        totalListeningTime: 0,
        favoriteChannels: {},
        totalAdRevenue: 0,
        averageSessionDuration: 0,
        location: callRecord.location,
        feedbackCount: 0
      };
    }

    const profile = this.data.callerProfiles[number];
    profile.totalCalls++;
    profile.totalListeningTime += callRecord.totalListeningTime;
    profile.totalAdRevenue += callRecord.sessionRevenue;
    profile.averageSessionDuration = profile.totalListeningTime / profile.totalCalls;
    profile.lastCall = callRecord.endTime;

    if (callRecord.feedback) {
      profile.feedbackCount++;
    }

    // Track favorite channels
    callRecord.channels.forEach(channel => {
      if (!profile.favoriteChannels[channel.channelId]) {
        profile.favoriteChannels[channel.channelId] = {
          name: channel.channelName,
          timesListened: 0,
          totalTime: 0
        };
      }
      profile.favoriteChannels[channel.channelId].timesListened++;
      profile.favoriteChannels[channel.channelId].totalTime += channel.listeningTime;
    });
  }

  updateDailyStats(callRecord) {
    const date = callRecord.startTime.toISOString().split('T')[0];
    
    if (!this.data.dailyStats[date]) {
      this.data.dailyStats[date] = {
        totalCalls: 0,
        uniqueCallers: [],
        totalListeningTime: 0,
        totalRevenue: 0,
        channelStats: {},
        adStats: {},
        peakHour: null,
        hourlyStats: {}
      };
    }

    const dayStats = this.data.dailyStats[date];
    dayStats.totalCalls++;
    
    // Handle uniqueCallers as array
    if (!Array.isArray(dayStats.uniqueCallers)) {
      dayStats.uniqueCallers = [];
    }
    if (!dayStats.uniqueCallers.includes(callRecord.callerNumber)) {
      dayStats.uniqueCallers.push(callRecord.callerNumber);
    }
    dayStats.totalListeningTime += callRecord.totalListeningTime;
    dayStats.totalRevenue += callRecord.sessionRevenue;

    // Track hourly stats
    const hour = callRecord.startTime.getHours();
    if (!dayStats.hourlyStats[hour]) {
      dayStats.hourlyStats[hour] = 0;
    }
    dayStats.hourlyStats[hour]++;

    // Track channel stats
    callRecord.channels.forEach(channel => {
      if (!dayStats.channelStats[channel.channelId]) {
        dayStats.channelStats[channel.channelId] = {
          name: channel.channelName,
          listens: 0,
          totalTime: 0
        };
      }
      dayStats.channelStats[channel.channelId].listens++;
      dayStats.channelStats[channel.channelId].totalTime += channel.listeningTime;
    });

    // Keep uniqueCallers as array length for JSON serialization in getSummary()
    // No need to convert here since we're using array
  }

  saveAnalytics() {
    try {
      fs.writeFileSync(ANALYTICS_FILE, JSON.stringify(this.data, null, 2));
      console.log('💾 Analytics data saved');
    } catch (error) {
      console.error('❌ Failed to save analytics:', error.message);
    }
  }

  normalizePhoneNumber(number) {
    if (!number) return 'unknown';
    return number.replace(/\D/g, '').replace(/^1/, ''); // Remove non-digits and leading 1
  }

  getLocationFromNumber(phoneNumber) {
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
      '713': 'Houston, TX',
      '469': 'Dallas, TX',
      '972': 'Dallas, TX'
    };
    
    return locationMap[areaCode] || `Area Code ${areaCode}`;
  }

  // Get analytics summary
  getSummary() {
    const activeSessions = this.sessions.size;
    const today = new Date().toISOString().split('T')[0];
    const todayStats = this.data.dailyStats[today] || {};

    return {
      activeSessions,
      totalCalls: this.data.metadata.totalCalls,
      totalListeningTime: Math.round(this.data.metadata.totalListeningTime),
      totalRevenue: this.data.metadata.totalAdRevenue.toFixed(2),
      todayCalls: todayStats.totalCalls || 0,
      todayUniqueCallers: Array.isArray(todayStats.uniqueCallers) ? todayStats.uniqueCallers.length : (todayStats.uniqueCallers || 0),
      todayRevenue: (todayStats.totalRevenue || 0).toFixed(2),
      uniqueCallers: Object.keys(this.data.callerProfiles).length
    };
  }

  // Get detailed analytics for a specific caller
  getCallerAnalytics(phoneNumber) {
    const normalized = this.normalizePhoneNumber(phoneNumber);
    return this.data.callerProfiles[normalized] || null;
  }

  // Export analytics data
  exportData(format = 'json') {
    if (format === 'csv') {
      return this.exportToCSV();
    }
    return this.data;
  }

  exportToCSV() {
    const headers = [
      'CallSid', 'CallerNumber', 'StartTime', 'Duration', 'ListeningTime', 
      'ChannelsVisited', 'AdsPlayed', 'Revenue', 'Location', 'EndReason'
    ];
    
    const rows = this.data.calls.map(call => [
      call.callSid,
      call.callerNumber,
      call.startTime,
      Math.round(call.totalDuration),
      Math.round(call.totalListeningTime),
      call.channelsVisited,
      call.totalAdsPlayed,
      call.sessionRevenue.toFixed(2),
      call.location,
      call.endReason
    ]);

    return [headers, ...rows].map(row => row.join(',')).join('\n');
  }
}

module.exports = CallerAnalytics;