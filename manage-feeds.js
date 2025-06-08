#!/usr/bin/env node

// Podcast Feed Management Script
// Usage: node manage-feeds.js [command] [options]

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const CONFIG_FILE = path.join(__dirname, 'podcast-feeds.json');
const BASE_URL = process.env.RAILWAY_URL || 'https://podcast-ivr-production.up.railway.app';

// Load config
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (error) {
    console.error('❌ Failed to load podcast-feeds.json:', error.message);
    process.exit(1);
  }
}

// Save config
function saveConfig(config) {
  try {
    config.metadata.lastUpdated = new Date().toISOString().split('T')[0];
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    console.log('✅ Configuration saved');
  } catch (error) {
    console.error('❌ Failed to save config:', error.message);
  }
}

// Commands
const commands = {
  list: () => {
    const config = loadConfig();
    console.log('\n📻 ACTIVE PODCAST FEEDS:');
    Object.entries(config.feeds).forEach(([id, feed]) => {
      console.log(`  ${id}: ${feed.name} - ${feed.description}`);
    });
    
    console.log('\n📋 EXTENSION FEEDS (Ready to activate):');
    Object.entries(config.extensions).forEach(([id, feed]) => {
      console.log(`  ${id}: ${feed.name} - ${feed.description}`);
    });
    
    console.log(`\n📊 Total: ${Object.keys(config.feeds).length} active, ${Object.keys(config.extensions).length} extensions`);
  },

  add: (channel, name, rssUrl, description = 'Custom feed') => {
    if (!channel || !name || !rssUrl) {
      console.error('❌ Usage: node manage-feeds.js add <channel> <name> <rssUrl> [description]');
      return;
    }
    
    const config = loadConfig();
    config.extensions[channel] = { name, rssUrl, description };
    config.metadata.totalFeeds = Object.keys(config.feeds).length + Object.keys(config.extensions).length;
    
    saveConfig(config);
    console.log(`✅ Added "${name}" as extension channel ${channel}`);
  },

  activate: (channel) => {
    if (!channel) {
      console.error('❌ Usage: node manage-feeds.js activate <channel>');
      return;
    }
    
    const config = loadConfig();
    if (!config.extensions[channel]) {
      console.error(`❌ Extension channel ${channel} not found`);
      return;
    }
    
    config.feeds[channel] = config.extensions[channel];
    delete config.extensions[channel];
    
    saveConfig(config);
    console.log(`✅ Activated "${config.feeds[channel].name}" as channel ${channel}`);
  },

  test: async (channel) => {
    if (!channel) {
      console.error('❌ Usage: node manage-feeds.js test <channel>');
      return;
    }
    
    try {
      console.log(`🧪 Testing channel ${channel}...`);
      const response = await axios.get(`${BASE_URL}/test-podcast/${channel}`);
      
      if (response.data.error) {
        console.error(`❌ Error: ${response.data.error}`);
      } else {
        console.log(`✅ Channel ${channel} working:`);
        console.log(`   Podcast: ${response.data.podcast}`);
        console.log(`   Episode: ${response.data.episodeTitle}`);
        console.log(`   URL cleaned: ${response.data.urlChanged ? 'Yes' : 'No'}`);
      }
    } catch (error) {
      console.error(`❌ Test failed: ${error.message}`);
    }
  },

  deploy: () => {
    console.log('🚀 To deploy changes to Railway:');
    console.log('1. git add podcast-feeds.json');
    console.log('2. git commit -m "Update podcast feeds"');
    console.log('3. git push origin main');
    console.log('4. Railway will auto-deploy the updated feeds');
  },

  help: () => {
    console.log(`
📻 Podcast Feed Management Tool

Commands:
  list                           - List all feeds (active and extensions)
  add <ch> <name> <url> [desc]  - Add new feed to extensions
  activate <channel>            - Move extension feed to active
  test <channel>               - Test RSS feed functionality
  deploy                       - Show deployment instructions
  help                         - Show this help

Examples:
  node manage-feeds.js list
  node manage-feeds.js add 31 "New Podcast" "https://feed.url/rss" "Description"
  node manage-feeds.js activate 31
  node manage-feeds.js test 1
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