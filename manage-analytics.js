#!/usr/bin/env node

// Analytics Management Script
// Usage: node manage-analytics.js [command] [options]

const fs = require('fs');
const path = require('path');

const ANALYTICS_FILE = path.join(__dirname, 'analytics-data.json');
const FEEDBACK_FILE = path.join(__dirname, 'feedback-records.json');

// Load analytics data
function loadAnalytics() {
  try {
    if (fs.existsSync(ANALYTICS_FILE)) {
      return JSON.parse(fs.readFileSync(ANALYTICS_FILE, 'utf8'));
    }
    return { calls: [], dailyStats: {}, callerProfiles: {}, metadata: {} };
  } catch (error) {
    console.error('❌ Failed to load analytics data:', error.message);
    return { calls: [], dailyStats: {}, callerProfiles: {}, metadata: {} };
  }
}

// Load feedback data
function loadFeedback() {
  try {
    if (fs.existsSync(FEEDBACK_FILE)) {
      return JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf8'));
    }
    return [];
  } catch (error) {
    console.error('❌ Failed to load feedback data:', error.message);
    return [];
  }
}

// Format duration in minutes and seconds
function formatDuration(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}m ${secs}s`;
}

// Format date
function formatDate(dateStr) {
  return new Date(dateStr).toLocaleDateString();
}

// Commands
const commands = {
  summary: () => {
    const data = loadAnalytics();
    const feedback = loadFeedback();
    
    console.log('\\n📊 ANALYTICS SUMMARY:');
    
    console.log(`\\nOVERALL STATS:`);
    console.log(`  Total calls: ${data.metadata.totalCalls || 0}`);
    console.log(`  Total listening time: ${formatDuration(data.metadata.totalListeningTime || 0)}`);
    console.log(`  Total ad revenue: $${(data.metadata.totalAdRevenue || 0).toFixed(2)}`);
    console.log(`  Unique callers: ${Object.keys(data.callerProfiles).length}`);
    console.log(`  Feedback messages: ${feedback.length}`);
    
    // Today's stats
    const today = new Date().toISOString().split('T')[0];
    const todayStats = data.dailyStats[today];
    
    if (todayStats) {
      console.log(`\\nTODAY'S STATS:`);
      console.log(`  Calls: ${todayStats.totalCalls || 0}`);
      console.log(`  Unique callers: ${todayStats.uniqueCallers || 0}`);
      console.log(`  Listening time: ${formatDuration(todayStats.totalListeningTime || 0)}`);
      console.log(`  Revenue: $${(todayStats.totalRevenue || 0).toFixed(2)}`);
    }
    
    // Most popular channels
    const channelStats = {};
    data.calls.forEach(call => {
      call.channels.forEach(channel => {
        if (!channelStats[channel.channelName]) {
          channelStats[channel.channelName] = { listens: 0, totalTime: 0 };
        }
        channelStats[channel.channelName].listens++;
        channelStats[channel.channelName].totalTime += channel.listeningTime;
      });
    });
    
    const topChannels = Object.entries(channelStats)
      .sort((a, b) => b[1].listens - a[1].listens)
      .slice(0, 5);
    
    if (topChannels.length > 0) {
      console.log(`\\nTOP CHANNELS:`);
      topChannels.forEach(([name, stats], index) => {
        console.log(`  ${index + 1}. ${name}: ${stats.listens} listens, ${formatDuration(stats.totalTime)}`);
      });
    }
  },

  daily: (date) => {
    const data = loadAnalytics();
    const targetDate = date || new Date().toISOString().split('T')[0];
    const dayStats = data.dailyStats[targetDate];
    
    if (!dayStats) {
      console.log(`❌ No data found for ${targetDate}`);
      return;
    }
    
    console.log(`\\n📅 DAILY REPORT - ${formatDate(targetDate)}:`);
    
    console.log(`\\nOVERALL:`);
    console.log(`  Total calls: ${dayStats.totalCalls || 0}`);
    console.log(`  Unique callers: ${dayStats.uniqueCallers || 0}`);
    console.log(`  Total listening time: ${formatDuration(dayStats.totalListeningTime || 0)}`);
    console.log(`  Total revenue: $${(dayStats.totalRevenue || 0).toFixed(2)}`);
    
    // Hourly breakdown
    if (dayStats.hourlyStats) {
      console.log(`\\nHOURLY BREAKDOWN:`);
      Object.entries(dayStats.hourlyStats)
        .sort((a, b) => parseInt(a[0]) - parseInt(b[0]))
        .forEach(([hour, calls]) => {
          const hourStr = hour.padStart(2, '0') + ':00';
          console.log(`  ${hourStr}: ${calls} calls`);
        });
    }
    
    // Channel breakdown
    if (dayStats.channelStats) {
      console.log(`\\nCHANNEL BREAKDOWN:`);
      Object.entries(dayStats.channelStats)
        .sort((a, b) => b[1].listens - a[1].listens)
        .forEach(([channelId, stats]) => {
          console.log(`  ${stats.name}: ${stats.listens} listens, ${formatDuration(stats.totalTime)}`);
        });
    }
  },

  caller: (phoneNumber) => {
    if (!phoneNumber) {
      console.error('❌ Usage: node manage-analytics.js caller <phoneNumber>');
      return;
    }
    
    const data = loadAnalytics();
    const normalized = phoneNumber.replace(/\\D/g, '').replace(/^1/, '');
    const profile = data.callerProfiles[normalized];
    
    if (!profile) {
      console.log(`❌ No data found for ${phoneNumber}`);
      return;
    }
    
    console.log(`\\n📞 CALLER PROFILE - ${phoneNumber}:`);
    
    console.log(`\\nOVERALL STATS:`);
    console.log(`  First call: ${formatDate(profile.firstCall)}`);
    console.log(`  Last call: ${formatDate(profile.lastCall || profile.firstCall)}`);
    console.log(`  Total calls: ${profile.totalCalls}`);
    console.log(`  Total listening time: ${formatDuration(profile.totalListeningTime)}`);
    console.log(`  Average session: ${formatDuration(profile.averageSessionDuration)}`);
    console.log(`  Total ad revenue: $${profile.totalAdRevenue.toFixed(2)}`);
    console.log(`  Location: ${profile.location}`);
    console.log(`  Feedback messages: ${profile.feedbackCount || 0}`);
    
    // Favorite channels
    if (profile.favoriteChannels) {
      const favorites = Object.entries(profile.favoriteChannels)
        .sort((a, b) => b[1].timesListened - a[1].timesListened)
        .slice(0, 5);
      
      console.log(`\\nFAVORITE CHANNELS:`);
      favorites.forEach(([channelId, stats], index) => {
        console.log(`  ${index + 1}. ${stats.name}: ${stats.timesListened} times, ${formatDuration(stats.totalTime)}`);
      });
    }
  },

  calls: (limit) => {
    const data = loadAnalytics();
    const maxCalls = parseInt(limit) || 10;
    
    const recentCalls = data.calls
      .sort((a, b) => new Date(b.startTime) - new Date(a.startTime))
      .slice(0, maxCalls);
    
    console.log(`\\n📱 RECENT CALLS (${recentCalls.length}):`);
    
    recentCalls.forEach((call, index) => {
      const duration = formatDuration(call.totalDuration);
      const listening = formatDuration(call.totalListeningTime);
      const revenue = call.sessionRevenue.toFixed(2);
      
      console.log(`\\n${index + 1}. ${call.callerNumber} - ${formatDate(call.startTime)}`);
      console.log(`   Duration: ${duration}, Listening: ${listening}, Revenue: $${revenue}`);
      console.log(`   Channels: ${call.channelsVisited}, Ads: ${call.totalAdsPlayed}, End: ${call.endReason}`);
      
      if (call.channels.length > 0) {
        console.log(`   Listened to: ${call.channels.map(ch => ch.channelName).join(', ')}`);
      }
    });
  },

  feedback: (limit) => {
    const feedback = loadFeedback();
    const maxFeedback = parseInt(limit) || 10;
    
    const recentFeedback = feedback
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, maxFeedback);
    
    console.log(`\\n🎤 RECENT FEEDBACK (${recentFeedback.length}):`);
    
    recentFeedback.forEach((fb, index) => {
      const status = fb.processed ? '✅' : '⏳';
      const duration = formatDuration(fb.duration);
      
      console.log(`\\n${index + 1}. ${status} ${formatDate(fb.timestamp)} - ${duration}`);
      console.log(`   Call: ${fb.callSid}`);
      
      if (fb.transcription) {
        const preview = fb.transcription.length > 100 
          ? fb.transcription.substring(0, 100) + '...'
          : fb.transcription;
        console.log(`   Text: "${preview}"`);
      } else {
        console.log(`   Text: [Pending transcription]`);
      }
      
      if (fb.recordingUrl) {
        console.log(`   Audio: ${fb.recordingUrl}`);
      }
    });
  },

  export: (format, filename) => {
    const data = loadAnalytics();
    const exportFormat = format || 'json';
    const exportFile = filename || `analytics-export-${new Date().toISOString().split('T')[0]}.${exportFormat}`;
    
    try {
      if (exportFormat === 'csv') {
        const headers = [
          'CallSid', 'CallerNumber', 'StartTime', 'Duration', 'ListeningTime', 
          'ChannelsVisited', 'AdsPlayed', 'Revenue', 'Location', 'EndReason'
        ];
        
        const rows = data.calls.map(call => [
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

        const csvContent = [headers, ...rows].map(row => row.join(',')).join('\\n');
        fs.writeFileSync(exportFile, csvContent);
        
      } else {
        fs.writeFileSync(exportFile, JSON.stringify(data, null, 2));
      }
      
      console.log(`✅ Analytics exported to ${exportFile}`);
      console.log(`📊 Exported ${data.calls.length} calls and ${Object.keys(data.callerProfiles).length} caller profiles`);
      
    } catch (error) {
      console.error('❌ Export failed:', error.message);
    }
  },

  clean: (days) => {
    const cutoffDays = parseInt(days) || 30;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - cutoffDays);
    
    const data = loadAnalytics();
    const initialCalls = data.calls.length;
    
    // Remove old calls
    data.calls = data.calls.filter(call => new Date(call.startTime) > cutoffDate);
    
    // Remove old daily stats
    Object.keys(data.dailyStats).forEach(date => {
      if (new Date(date) < cutoffDate) {
        delete data.dailyStats[date];
      }
    });
    
    // Update metadata
    data.metadata.totalCalls = data.calls.length;
    data.metadata.totalListeningTime = data.calls.reduce((sum, call) => sum + (call.totalListeningTime || 0), 0);
    data.metadata.totalAdRevenue = data.calls.reduce((sum, call) => sum + (call.sessionRevenue || 0), 0);
    data.metadata.lastUpdated = new Date().toISOString();
    
    try {
      fs.writeFileSync(ANALYTICS_FILE, JSON.stringify(data, null, 2));
      const removed = initialCalls - data.calls.length;
      console.log(`✅ Cleaned analytics data: removed ${removed} calls older than ${cutoffDays} days`);
      console.log(`📊 Remaining: ${data.calls.length} calls`);
    } catch (error) {
      console.error('❌ Failed to save cleaned data:', error.message);
    }
  },

  help: () => {
    console.log(`
📊 Analytics Management Tool

Commands:
  summary                        - Show overall analytics summary
  daily [YYYY-MM-DD]            - Show daily report (default: today)
  caller <phoneNumber>          - Show detailed caller profile
  calls [limit]                 - Show recent calls (default: 10)
  feedback [limit]              - Show recent feedback (default: 10)
  export [format] [filename]    - Export data (json/csv)
  clean [days]                  - Remove data older than X days (default: 30)
  help                          - Show this help

Examples:
  node manage-analytics.js summary
  node manage-analytics.js daily 2025-06-07
  node manage-analytics.js caller "+19185551234"
  node manage-analytics.js calls 20
  node manage-analytics.js export csv analytics.csv
  node manage-analytics.js clean 60
`);
  }
};

// Parse command line arguments
const [,, command, ...args] = process.argv;

if (!command || !commands[command]) {
  commands.help();
  process.exit(1);
}

// Execute command
commands[command](...args);