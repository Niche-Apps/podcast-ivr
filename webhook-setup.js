require('dotenv').config();
const SDK = require('@ringcentral/sdk').SDK;
const fs = require('fs');
const path = require('path');

// RingCentral configuration
const rc = new SDK({
  server: process.env.RC_SERVER_URL,
  clientId: process.env.RC_CLIENT_ID,
  clientSecret: process.env.RC_CLIENT_SECRET
});

class RingCentralAutomation {
  constructor() {
    this.extensionConfig = {
      101: { name: 'Daily Tech News', sponsor: 'TechCorp Solutions' },
      102: { name: 'Weather & Traffic', sponsor: 'Dallas Auto Group' },
      103: { name: 'Daily Stories', sponsor: 'StoryBrand Publishing' }
    };
  }

  async initialize() {
    try {
      await rc.login({ jwt: process.env.RC_JWT_TOKEN });
      console.log('✅ Authenticated with RingCentral');
      return true;
    } catch (error) {
      console.error('❌ Authentication failed:', error.message);
      return false;
    }
  }

  // 🚀 FULLY AUTOMATED RINGCENTRAL SETUP
  async fullSetup() {
    console.log('\n🚀 Starting full RingCentral automation...');
    
    if (!(await this.initialize())) return false;

    try {
      // 1. Create webhook subscription
      await this.createWebhook();
      
      // 2. Configure extensions
      await this.configureExtensions();
      
      // 3. Create IVR menu
      await this.createIVRMenu();
      
      // 4. Upload initial podcast episodes
      await this.uploadInitialEpisodes();
      
      console.log('\n🎉 RINGCENTRAL FULLY CONFIGURED!');
      console.log('📞 Your podcast hotline is ready!');
      console.log('🎧 Call (904) 371-2672 to test');
      
      return true;
      
    } catch (error) {
      console.error('❌ Setup failed:', error.message);
      return false;
    }
  }

  async createWebhook() {
    try {
      const webhookUrl = 'https://podcast-ivr-production.up.railway.app/webhook';
      
      // Check if webhook already exists
      const existingSubscriptions = await rc.get('/restapi/v1.0/subscription');
      const existing = await existingSubscriptions.json();
      
      // Delete existing webhooks to avoid duplicates
      for (const sub of existing.records) {
        if (sub.deliveryMode.address === webhookUrl) {
          await rc.delete(`/restapi/v1.0/subscription/${sub.id}`);
          console.log('🗑️ Removed existing webhook');
        }
      }

      const subscription = await rc.post('/restapi/v1.0/subscription', {
        eventFilters: [
          '/restapi/v1.0/account/~/telephony/sessions',
          '/restapi/v1.0/account/~/extension/~/telephony/sessions'
        ],
        deliveryMode: {
          transportType: 'WebHook',
          address: webhookUrl
        },
        expiresIn: 630720000
      });

      const response = await subscription.json();
      console.log(`✅ Webhook created: ${response.id}`);
      
    } catch (error) {
      console.error('❌ Webhook creation failed:', error.message);
    }
  }

  async configureExtensions() {
    console.log('\n📋 Configuring podcast extensions...');
    
    for (const [extId, config] of Object.entries(this.extensionConfig)) {
      try {
        // Set extension to take messages only (plays greeting)
        await rc.put(`/restapi/v1.0/account/~/extension/${extId}/answering-rule/business-hours-rule`, {
          callHandlingAction: 'TakeMessagesOnly',
          greetings: [{
            type: 'Voicemail',
            text: `Welcome to ${config.name}, brought to you by ${config.sponsor}. Please enjoy this episode.`
          }]
        });
        
        console.log(`✅ Extension ${extId} configured: ${config.name}`);
        
      } catch (error) {
        console.log(`⚠️ Extension ${extId} config skipped: ${error.message}`);
      }
    }
  }

  async createIVRMenu() {
    try {
      console.log('\n🎛️ Creating IVR menu...');
      
      // Create auto-receptionist (IVR)
      const ivrData = {
        name: 'Podcast Hotline IVR',
        enabled: true,
        language: {
          id: '1033' // English US
        },
        businessHours: {
          sunday: { enabled: true, from: '00:00', to: '23:59' },
          monday: { enabled: true, from: '00:00', to: '23:59' },
          tuesday: { enabled: true, from: '00:00', to: '23:59' },
          wednesday: { enabled: true, from: '00:00', to: '23:59' },
          thursday: { enabled: true, from: '00:00', to: '23:59' },
          friday: { enabled: true, from: '00:00', to: '23:59' },
          saturday: { enabled: true, from: '00:00', to: '23:59' }
        },
        greetings: [{
          type: 'Voicemail',
          text: 'Welcome to the Podcast Hotline! Press 1 for Daily Tech News, 2 for Weather and Traffic, 3 for Daily Stories, 9 to repeat this menu, or 0 for a representative.'
        }],
        businessHoursRule: {
          callHandlingAction: 'Operator',
          keyPressActions: [
            { input: '1', action: 'Transfer', extension: { id: '101' } },
            { input: '2', action: 'Transfer', extension: { id: '102' } },
            { input: '3', action: 'Transfer', extension: { id: '103' } },
            { input: '9', action: 'RepeatMenuGreeting' },
            { input: '0', action: 'Transfer', extension: { id: '101' } }
          ]
        }
      };

      const ivr = await rc.post('/restapi/v1.0/account/~/ivr-menus', ivrData);
      const ivrResponse = await ivr.json();
      
      console.log(`✅ IVR Menu created: ${ivrResponse.id}`);
      
      // Assign phone number to IVR
      await this.assignPhoneToIVR(ivrResponse.id);
      
    } catch (error) {
      console.log(`⚠️ IVR creation skipped: ${error.message}`);
    }
  }

  async assignPhoneToIVR(ivrId) {
    try {
      // Get phone numbers
      const phoneNumbers = await rc.get('/restapi/v1.0/account/~/phone-number');
      const numbers = await phoneNumbers.json();
      
      // Find your main number
      const mainNumber = numbers.records.find(n => 
        n.phoneNumber.includes('9043712672') || n.usage === 'MainCompanyNumber'
      );
      
      if (mainNumber) {
        await rc.put(`/restapi/v1.0/account/~/phone-number/${mainNumber.id}`, {
          extension: { id: ivrId }
        });
        console.log(`✅ Phone number assigned to IVR`);
      }
      
    } catch (error) {
      console.log(`⚠️ Phone assignment skipped: ${error.message}`);
    }
  }

  // 🎵 UPLOAD PODCAST EPISODES
  async uploadEpisode(extensionId, audioFile, episodeTitle) {
    try {
      console.log(`📤 Uploading episode to extension ${extensionId}: ${episodeTitle}`);
      
      const audioBuffer = fs.readFileSync(audioFile);
      
      // Upload as custom greeting
      const formData = new FormData();
      formData.append('name', episodeTitle);
      formData.append('type', 'Voicemail');
      formData.append('binary', new Blob([audioBuffer], { type: 'audio/mpeg' }));

      const response = await rc.post(
        `/restapi/v1.0/account/~/extension/${extensionId}/greeting`,
        formData
      );

      const greeting = await response.json();
      
      // Set as active greeting
      await rc.put(`/restapi/v1.0/account/~/extension/${extensionId}/answering-rule/business-hours-rule`, {
        greetings: [{
          type: 'Voicemail',
          preset: { id: greeting.id }
        }]
      });

      console.log(`✅ Episode uploaded and activated: ${episodeTitle}`);
      return greeting.id;
      
    } catch (error) {
      console.error(`❌ Upload failed for ${episodeTitle}:`, error.message);
      return null;
    }
  }

  async uploadInitialEpisodes() {
    console.log('\n🎵 Uploading initial podcast episodes...');
    
    const episodes = [
      { ext: 101, file: './podcast_audio/tech-news-latest.mp3', title: 'Daily Tech News - Latest' },
      { ext: 102, file: './podcast_audio/weather-latest.mp3', title: 'Weather & Traffic Update' },
      { ext: 103, file: './podcast_audio/story-latest.mp3', title: 'Daily Stories - Featured' }
    ];

    for (const episode of episodes) {
      if (fs.existsSync(episode.file)) {
        await this.uploadEpisode(episode.ext, episode.file, episode.title);
      } else {
        console.log(`⚠️ Audio file not found: ${episode.file}`);
      }
    }
  }

  // 🔄 ADD NEW EPISODE (Call this from Railway)
  async addNewEpisode(podcastType, audioFile, title) {
    const extensionMap = {
      'tech': 101,
      'weather': 102, 
      'stories': 103
    };

    const extensionId = extensionMap[podcastType];
    if (!extensionId) {
      throw new Error(`Unknown podcast type: ${podcastType}`);
    }

    return await this.uploadEpisode(extensionId, audioFile, title);
  }

  // 📊 GET SYSTEM STATUS
  async getSystemStatus() {
    try {
      const extensions = await rc.get('/restapi/v1.0/account/~/extension');
      const extData = await extensions.json();
      
      const subscriptions = await rc.get('/restapi/v1.0/subscription');
      const subData = await subscriptions.json();

      return {
        extensions: extData.records.length,
        webhooks: subData.records.length,
        configured: true,
        lastChecked: new Date().toISOString()
      };
    } catch (error) {
      return { error: error.message, configured: false };
    }
  }
}

// 🚀 MAIN SETUP FUNCTION
async function setupRingCentral() {
  const automation = new RingCentralAutomation();
  await automation.fullSetup();
}

// Export for use in server.js
module.exports = { RingCentralAutomation, setupRingCentral };

// Run if called directly
if (require.main === module) {
  setupRingCentral();
}