#!/usr/bin/env node

// Ad System Management Script
// Usage: node manage-ads.js [command] [options]

const fs = require('fs');
const path = require('path');

const AD_CONFIG_FILE = path.join(__dirname, 'ad-config.json');
const EXEMPT_FILE = path.join(__dirname, 'ad-exempt-numbers.json');

// Load ad configuration
function loadAdConfig() {
  try {
    return JSON.parse(fs.readFileSync(AD_CONFIG_FILE, 'utf8'));
  } catch (error) {
    console.error('❌ Failed to load ad-config.json:', error.message);
    process.exit(1);
  }
}

// Load exempt numbers
function loadExemptNumbers() {
  try {
    return JSON.parse(fs.readFileSync(EXEMPT_FILE, 'utf8'));
  } catch (error) {
    console.error('❌ Failed to load ad-exempt-numbers.json:', error.message);
    process.exit(1);
  }
}

// Save ad configuration
function saveAdConfig(config) {
  try {
    config.metadata.lastUpdated = new Date().toISOString().split('T')[0];
    fs.writeFileSync(AD_CONFIG_FILE, JSON.stringify(config, null, 2));
    console.log('✅ Ad configuration saved');
  } catch (error) {
    console.error('❌ Failed to save ad config:', error.message);
  }
}

// Save exempt numbers
function saveExemptNumbers(exempt) {
  try {
    exempt.metadata.lastUpdated = new Date().toISOString().split('T')[0];
    fs.writeFileSync(EXEMPT_FILE, JSON.stringify(exempt, null, 2));
    console.log('✅ Exempt numbers saved');
  } catch (error) {
    console.error('❌ Failed to save exempt numbers:', error.message);
  }
}

// Commands
const commands = {
  list: (type) => {
    const config = loadAdConfig();
    
    if (type === 'preroll' || type === 'midroll') {
      console.log(`\\n📺 ${type.toUpperCase()} ADS:`);
      const ads = config.customAds[type] || [];
      ads.forEach((ad, index) => {
        const status = ad.active ? '✅' : '❌';
        console.log(`  ${index + 1}. ${status} ${ad.name} (${ad.duration}s) - $${ad.revenue} - Weight: ${ad.weight}`);
        console.log(`     Sponsor: ${ad.sponsor}`);
        console.log(`     URL: ${ad.audioUrl}`);
      });
    } else if (type === 'exempt') {
      const exempt = loadExemptNumbers();
      console.log(`\\n📞 EXEMPT PHONE NUMBERS:`);
      exempt.exemptNumbers.forEach((entry, index) => {
        console.log(`  ${index + 1}. ${entry.number} - ${entry.reason}`);
        console.log(`     Since: ${entry.exemptSince} - ${entry.notes}`);
      });
    } else {
      console.log('\\n📺 AD SYSTEM OVERVIEW:');
      console.log(`Preroll ads: ${(config.customAds.preroll || []).length} (${(config.customAds.preroll || []).filter(ad => ad.active).length} active)`);
      console.log(`Midroll ads: ${(config.customAds.midroll || []).length} (${(config.customAds.midroll || []).filter(ad => ad.active).length} active)`);
      
      const exempt = loadExemptNumbers();
      console.log(`Exempt numbers: ${exempt.exemptNumbers.length}`);
      
      console.log(`\\nFREQUENCY SETTINGS:`);
      console.log(`Preroll: ${config.providers.custom.frequency.preroll}%`);
      console.log(`Midroll: ${config.providers.custom.frequency.midroll}%`);
      console.log(`Midroll interval: ${config.settings.midrollIntervalMinutes} minutes`);
    }
  },

  add: (type, name, audioUrl, duration, sponsor, revenue, weight) => {
    if (type !== 'preroll' && type !== 'midroll') {
      console.error('❌ Type must be "preroll" or "midroll"');
      return;
    }
    
    if (!name || !audioUrl || !duration || !sponsor || !revenue) {
      console.error('❌ Usage: node manage-ads.js add <type> <name> <audioUrl> <duration> <sponsor> <revenue> [weight]');
      return;
    }
    
    const config = loadAdConfig();
    
    if (!config.customAds[type]) {
      config.customAds[type] = [];
    }
    
    const newAd = {
      id: `custom_${type}_${Date.now()}`,
      name,
      audioUrl,
      duration: parseInt(duration),
      sponsor,
      revenue: parseFloat(revenue),
      weight: parseInt(weight) || 50,
      active: true
    };
    
    config.customAds[type].push(newAd);
    config.metadata.totalCustomAds = (config.metadata.totalCustomAds || 0) + 1;
    
    saveAdConfig(config);
    console.log(`✅ Added ${type} ad: "${name}" - $${revenue}`);
  },

  toggle: (type, index) => {
    if (!type || !index) {
      console.error('❌ Usage: node manage-ads.js toggle <preroll|midroll> <index>');
      return;
    }
    
    const config = loadAdConfig();
    const ads = config.customAds[type] || [];
    const adIndex = parseInt(index) - 1;
    
    if (adIndex < 0 || adIndex >= ads.length) {
      console.error(`❌ Invalid ad index. Use 1-${ads.length}`);
      return;
    }
    
    ads[adIndex].active = !ads[adIndex].active;
    const status = ads[adIndex].active ? 'activated' : 'deactivated';
    
    saveAdConfig(config);
    console.log(`✅ ${ads[adIndex].name} ${status}`);
  },

  frequency: (type, percentage) => {
    if (!type || !percentage) {
      console.error('❌ Usage: node manage-ads.js frequency <preroll|midroll> <percentage>');
      return;
    }
    
    const config = loadAdConfig();
    const freq = parseInt(percentage);
    
    if (freq < 0 || freq > 100) {
      console.error('❌ Frequency must be between 0 and 100');
      return;
    }
    
    config.providers.custom.frequency[type] = freq;
    
    saveAdConfig(config);
    console.log(`✅ ${type} frequency set to ${freq}%`);
  },

  exempt: (action, phoneNumber, reason, notes) => {
    if (action === 'add') {
      if (!phoneNumber || !reason) {
        console.error('❌ Usage: node manage-ads.js exempt add <phoneNumber> <reason> [notes]');
        return;
      }
      
      const exempt = loadExemptNumbers();
      
      // Check if already exists
      const existing = exempt.exemptNumbers.find(entry => entry.number === phoneNumber);
      if (existing) {
        console.error(`❌ ${phoneNumber} is already exempt`);
        return;
      }
      
      exempt.exemptNumbers.push({
        number: phoneNumber,
        reason,
        exemptSince: new Date().toISOString().split('T')[0],
        notes: notes || ''
      });
      
      exempt.metadata.totalExemptions = exempt.exemptNumbers.length;
      
      saveExemptNumbers(exempt);
      console.log(`✅ Added ${phoneNumber} to exemption list`);
      
    } else if (action === 'remove') {
      if (!phoneNumber) {
        console.error('❌ Usage: node manage-ads.js exempt remove <phoneNumber>');
        return;
      }
      
      const exempt = loadExemptNumbers();
      const initialLength = exempt.exemptNumbers.length;
      
      exempt.exemptNumbers = exempt.exemptNumbers.filter(entry => entry.number !== phoneNumber);
      
      if (exempt.exemptNumbers.length < initialLength) {
        exempt.metadata.totalExemptions = exempt.exemptNumbers.length;
        saveExemptNumbers(exempt);
        console.log(`✅ Removed ${phoneNumber} from exemption list`);
      } else {
        console.error(`❌ ${phoneNumber} not found in exemption list`);
      }
      
    } else {
      console.error('❌ Action must be "add" or "remove"');
    }
  },

  stats: () => {
    const config = loadAdConfig();
    const exempt = loadExemptNumbers();
    
    console.log('\\n📊 AD SYSTEM STATISTICS:');
    
    const prerollAds = config.customAds.preroll || [];
    const midrollAds = config.customAds.midroll || [];
    
    console.log(`\\nAD INVENTORY:`);
    console.log(`  Preroll: ${prerollAds.length} total (${prerollAds.filter(ad => ad.active).length} active)`);
    console.log(`  Midroll: ${midrollAds.length} total (${midrollAds.filter(ad => ad.active).length} active)`);
    
    const totalRevenue = [...prerollAds, ...midrollAds].reduce((sum, ad) => sum + (ad.revenue || 0), 0);
    console.log(`  Total potential revenue per session: $${totalRevenue.toFixed(2)}`);
    
    console.log(`\\nFREQUENCY SETTINGS:`);
    console.log(`  Preroll chance: ${config.providers.custom.frequency.preroll}%`);
    console.log(`  Midroll chance: ${config.providers.custom.frequency.midroll}%`);
    console.log(`  Midroll interval: ${config.settings.midrollIntervalMinutes} minutes`);
    console.log(`  Max ads per session: ${config.settings.maxAdsPerSession}`);
    
    console.log(`\\nEXEMPTIONS:`);
    console.log(`  Exempt phone numbers: ${exempt.exemptNumbers.length}`);
    
    console.log(`\\nSPONSORS:`);
    const sponsors = [...new Set([...prerollAds, ...midrollAds].map(ad => ad.sponsor))];
    sponsors.forEach(sponsor => {
      const sponsorAds = [...prerollAds, ...midrollAds].filter(ad => ad.sponsor === sponsor);
      const sponsorRevenue = sponsorAds.reduce((sum, ad) => sum + (ad.revenue || 0), 0);
      console.log(`  ${sponsor}: ${sponsorAds.length} ads, $${sponsorRevenue.toFixed(2)} potential`);
    });
  },

  test: (type) => {
    const config = loadAdConfig();
    
    if (type === 'preroll' || type === 'midroll') {
      const ads = config.customAds[type]?.filter(ad => ad.active) || [];
      
      if (ads.length === 0) {
        console.log(`❌ No active ${type} ads to test`);
        return;
      }
      
      console.log(`\\n🧪 TESTING ${type.toUpperCase()} AD SELECTION:`);
      
      // Simulate 10 ad selections
      for (let i = 0; i < 10; i++) {
        const totalWeight = ads.reduce((sum, ad) => sum + (ad.weight || 50), 0);
        let random = Math.random() * totalWeight;
        
        let selectedAd = null;
        for (const ad of ads) {
          random -= (ad.weight || 50);
          if (random <= 0) {
            selectedAd = ad;
            break;
          }
        }
        
        if (selectedAd) {
          console.log(`  ${i + 1}. ${selectedAd.name} ($${selectedAd.revenue})`);
        }
      }
      
    } else {
      console.error('❌ Type must be "preroll" or "midroll"');
    }
  },

  help: () => {
    console.log(`
📺 Ad System Management Tool

Commands:
  list [type]                    - List all ads or specific type (preroll, midroll, exempt)
  add <type> <name> <url> <dur> <sponsor> <rev> [weight] - Add new ad
  toggle <type> <index>          - Activate/deactivate ad by index
  frequency <type> <percentage>  - Set ad frequency (0-100%)
  exempt <action> <phone> [reason] [notes] - Manage exempt numbers (add/remove)
  stats                          - Show system statistics
  test <type>                    - Test ad selection algorithm
  help                          - Show this help

Examples:
  node manage-ads.js list preroll
  node manage-ads.js add preroll "Coffee Shop" "https://example.com/ad.mp3" 30 "Local Coffee" 2.50 60
  node manage-ads.js toggle preroll 1
  node manage-ads.js frequency midroll 25
  node manage-ads.js exempt add "+19185551234" "premium_subscriber" "Annual membership"
  node manage-ads.js stats
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