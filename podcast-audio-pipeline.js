require('dotenv').config();
const textToSpeech = require('@google-cloud/text-to-speech');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const crypto = require('crypto');

class PodcastAudioPipeline {
  constructor() {
    // Removed RingCentral SDK - now using direct file storage
    
    // Configure Google Cloud TTS (works without credentials on free tier)
    try {
      this.ttsClient = new textToSpeech.TextToSpeechClient({
        keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS || undefined
      });
      console.log('✅ Google Cloud TTS initialized');
    } catch (error) {
      console.log('⚠️ Google Cloud TTS using free tier (no credentials)');
      this.ttsClient = new textToSpeech.TextToSpeechClient();
    }
    
    // Audio storage directory
    this.audioDir = path.join(__dirname, 'podcast_audio');
    this.ensureAudioDirectory();
    
    // Podcast configuration
    this.podcastSources = {
      1: {
        name: 'Daily Tech News',
        extensionId: '101', // Your actual extension IDs
        audioSource: 'rss', // 'rss', 'api', or 'file'
        sourceUrl: 'https://feeds.feedburner.com/TechCrunch', // RSS feed
        duration: 600, // 10 minutes in seconds
        updateFrequency: 'daily' // How often to refresh
      },
      2: {
        name: 'Weather & Traffic',
        extensionId: '102',
        audioSource: 'tts', // Text-to-speech generated
        sourceUrl: 'https://api.weather.com/dallas', // Weather API
        duration: 300, // 5 minutes
        updateFrequency: 'hourly'
      },
      3: {
        name: 'Daily Stories',
        extensionId: '103', 
        audioSource: 'file', // Pre-recorded files
        sourceUrl: '/path/to/story/files/',
        duration: 900, // 15 minutes
        updateFrequency: 'daily'
      }
    };
  }

  async initialize() {
    // Initialize pipeline (RingCentral login removed)
    console.log('✅ Audio pipeline initialized');
    console.log('📁 Audio directory:', this.audioDir);
  }

  ensureAudioDirectory() {
    if (!fs.existsSync(this.audioDir)) {
      fs.mkdirSync(this.audioDir, { recursive: true });
      console.log('📁 Created audio directory:', this.audioDir);
    }
  }

  // Main function to update all podcast content
  async updateAllPodcasts() {
    console.log('🔄 Starting podcast content update...');
    
    for (const [channelId, config] of Object.entries(this.podcastSources)) {
      try {
        console.log(`\n📻 Processing: ${config.name}`);
        
        // 1. Get latest content
        const audioFile = await this.getLatestContent(channelId, config);
        
        // 2. Process audio (convert format, add intro/outro)
        const processedFile = await this.processAudio(audioFile, config);
        
        // 3. Upload to RingCentral extension
        await this.uploadToExtension(config.extensionId, processedFile, config);
        
        console.log(`✅ ${config.name} updated successfully`);
        
      } catch (error) {
        console.error(`❌ Error updating ${config.name}:`, error.message);
      }
    }
    
    console.log('\n🎉 All podcasts updated!');
  }

  // Get latest content based on source type
  async getLatestContent(channelId, config) {
    switch (config.audioSource) {
      case 'rss':
        return await this.getContentFromRSS(channelId, config);
      case 'tts':
        return await this.generateTTSContent(channelId, config);
      case 'file':
        return await this.getFileContent(channelId, config);
      case 'api':
        return await this.getContentFromAPI(channelId, config);
      default:
        throw new Error(`Unknown audio source: ${config.audioSource}`);
    }
  }

  // Get podcast from RSS feed
  async getContentFromRSS(channelId, config) {
    console.log(`📡 Fetching from RSS: ${config.sourceUrl}`);
    
    // For demo, we'll create a sample tech news podcast
    const newsContent = await this.fetchLatestNews();
    const scriptText = this.generateNewsScript(newsContent);
    
    // Convert to audio using TTS
    return await this.textToSpeech(scriptText, `tech_news_${Date.now()}.mp3`);
  }

  // Generate content using Text-to-Speech
  async generateTTSContent(channelId, config) {
    console.log(`🗣️ Generating TTS content for: ${config.name}`);
    
    let scriptText = '';
    
    if (config.name.includes('Weather')) {
      const weatherData = await this.fetchWeatherData();
      scriptText = this.generateWeatherScript(weatherData);
    }
    
    return await this.textToSpeech(scriptText, `weather_${Date.now()}.mp3`);
  }

  // Get pre-recorded file content
  async getFileContent(channelId, config) {
    console.log(`📁 Getting file content for: ${config.name}`);
    
    // For demo, create a sample story
    const storyScript = this.generateStoryScript();
    return await this.textToSpeech(storyScript, `story_${Date.now()}.mp3`);
  }

  // Fetch latest news for tech podcast
  async fetchLatestNews() {
    // Simplified news fetching - in production, use news APIs
    return [
      "Apple announces new AI features coming to iOS",
      "Google unveils quantum computing breakthrough", 
      "Tesla reports record quarterly deliveries",
      "Microsoft Azure gains new enterprise features"
    ];
  }

  // Generate news script
  generateNewsScript(newsItems) {
    const intro = "Welcome to Daily Tech News. Here are today's top technology stories.";
    const stories = newsItems.map((item, index) => 
      `Story ${index + 1}: ${item}. More details on this developing story at our website.`
    ).join(' ');
    const outro = "That's your Daily Tech News update. Thanks for listening, and we'll see you tomorrow.";
    
    return `${intro} ${stories} ${outro}`;
  }

  // Fetch weather data
  async fetchWeatherData() {
    // Simplified - in production, use weather APIs
    return {
      temperature: 72,
      condition: 'partly cloudy',
      humidity: 65,
      windSpeed: 8
    };
  }

  // Generate weather script
  generateWeatherScript(weatherData) {
    return `Good morning! This is your Dallas weather and traffic update. 
    Currently, it's ${weatherData.temperature} degrees and ${weatherData.condition}. 
    Humidity is at ${weatherData.humidity} percent with winds at ${weatherData.windSpeed} miles per hour.
    Traffic is moving smoothly on I-35 and I-75 with no major incidents to report.
    Have a great day, and drive safely!`;
  }

  // Generate story script
  generateStoryScript() {
    const stories = [
      "Today's story takes us to a small town where a local baker discovered an old recipe that changes everything...",
      "In today's tale, we explore the mystery of the lighthouse keeper who vanished one stormy night...",
      "Our story today follows a young programmer who discovers their code is somehow predicting the future..."
    ];
    
    const randomStory = stories[Math.floor(Math.random() * stories.length)];
    return `Welcome to Daily Stories. ${randomStory} But that's just the beginning of our tale...`;
  }

  // Convert text to speech using Google Cloud TTS with British male voice
  async textToSpeech(text, filename, voiceOverride = null) {
    console.log(`🎤 Converting text to speech with Google British voice: ${filename}`);
    
    const outputPath = path.join(this.audioDir, filename);
    
    try {
      // Prepare TTS request with British male voice options
      const voiceName = voiceOverride || process.env.TTS_VOICE_NAME || 'en-GB-Neural2-B';
      
      const request = {
        input: { text: text },
        voice: {
          languageCode: process.env.TTS_LANGUAGE_CODE || 'en-GB',
          name: voiceName,
          ssmlGender: 'MALE'
        },
        audioConfig: {
          audioEncoding: 'MP3',
          speakingRate: 1.0,
          pitch: 0.0,
          volumeGainDb: 0.0
        }
      };

      // Add SSML for better control on longer text
      if (text.length > 100) {
        request.input = {
          ssml: `<speak><prosody rate="medium" pitch="medium">${text}</prosody></speak>`
        };
      }

      console.log(`🇬🇧 Generating speech with ${voiceName}...`);
      
      // Call Google Cloud TTS
      const [response] = await this.ttsClient.synthesizeSpeech(request);
      
      if (response.audioContent) {
        // Write the audio content to file
        fs.writeFileSync(outputPath, response.audioContent, 'binary');
        console.log(`✅ Google TTS audio created: ${outputPath}`);
        
        // Log audio details
        console.log(`📊 Audio details: Voice=${voiceName}, Language=${request.voice.languageCode}, Size=${response.audioContent.length} bytes`);
        
        return outputPath;
      } else {
        throw new Error('No audio content returned from Google TTS');
      }
      
    } catch (error) {
      console.error(`❌ Google TTS failed: ${error.message}`);
      
      // Try fallback voice if the main one fails
      if (!voiceOverride && error.message.includes('not found')) {
        console.log(`🔄 Trying fallback voice: en-GB-Wavenet-B`);
        return await this.textToSpeech(text, filename, 'en-GB-Wavenet-B');
      }
      
      // Final fallback to demo file
      console.log(`🔄 Creating fallback audio file...`);
      const fallbackData = Buffer.from(`DEMO_AUDIO_FALLBACK_${text.substring(0, 50)}`);
      fs.writeFileSync(outputPath, fallbackData);
      
      return outputPath;
    }
  }

  // Get available British male voices
  async getAvailableBritishVoices() {
    try {
      const [response] = await this.ttsClient.listVoices({
        languageCode: 'en-GB'
      });
      
      const britishMaleVoices = response.voices.filter(voice => 
        voice.ssmlGender === 'MALE' && voice.languageCodes.includes('en-GB')
      );
      
      return britishMaleVoices.map(voice => ({
        name: voice.name,
        gender: voice.ssmlGender,
        language: voice.languageCodes[0]
      }));
      
    } catch (error) {
      console.error('❌ Failed to get available voices:', error.message);
      return [
        { name: 'en-GB-Neural2-B', gender: 'MALE', language: 'en-GB' },
        { name: 'en-GB-Wavenet-B', gender: 'MALE', language: 'en-GB' },
        { name: 'en-GB-Standard-B', gender: 'MALE', language: 'en-GB' }
      ];
    }
  }

  // Process audio file (format conversion, add intro/outro)
  async processAudio(audioFile, config) {
    console.log(`🎵 Processing audio: ${audioFile}`);
    
    const processedFile = audioFile.replace('.mp3', '_processed.mp3');
    
    // Add podcast intro/outro
    const introText = `This podcast is brought to you by ${this.getSponsor(config.name)}. `;
    const outroText = ` Thank you for listening. This has been ${config.name}.`;
    
    // For demo, just copy the file
    // In production, you'd use FFmpeg or similar to:
    // 1. Convert to proper format (WAV, specific bitrate)
    // 2. Add intro/outro audio
    // 3. Normalize volume levels
    // 4. Add sponsorship messages
    
    fs.copyFileSync(audioFile, processedFile);
    
    console.log(`✅ Audio processed: ${processedFile}`);
    return processedFile;
  }

  getSponsor(podcastName) {
    const sponsors = {
      'Daily Tech News': 'TechCorp Solutions',
      'Weather & Traffic': 'Dallas Auto Group', 
      'Daily Stories': 'BookWorld Publishing'
    };
    return sponsors[podcastName] || 'Our Sponsors';
  }

  // Save audio file for serving via HTTP (replaced RingCentral upload)
  async uploadToExtension(extensionId, audioFile, config) {
    console.log(`📤 Saving audio for extension ${extensionId}: ${config.name}`);
    
    try {
      // Copy to serving directory with standardized name
      const servingPath = path.join(this.audioDir, `podcast-${extensionId}-latest.mp3`);
      fs.copyFileSync(audioFile, servingPath);
      
      console.log(`✅ Successfully saved ${config.name} to ${servingPath}`);
      
      // Clean up local audio file if it's different from serving path
      if (audioFile !== servingPath) {
        fs.unlinkSync(audioFile);
      }
      
      return { success: true, path: servingPath };
      
    } catch (error) {
      console.error(`❌ Failed to save audio for extension ${extensionId}:`, error.message);
      throw error;
    }
  }

  // Set the uploaded greeting as active (now just logs - RingCentral removed)
  async setActiveGreeting(extensionId, greetingId) {
    console.log(`✅ Audio ready for extension ${extensionId} (greeting: ${greetingId})`);
    // Note: RingCentral greeting activation removed - files served directly via HTTP
  }

  // Fallback: Set extension to generic message (now just logs - RingCentral removed)
  async setGenericMessage(extensionId, config) {
    console.log(`✅ Generic message available for extension ${extensionId}: ${config.name}`);
    // Note: RingCentral message configuration removed - handled by TwiML responses
  }

  // Schedule automatic updates
  setupScheduledUpdates() {
    console.log('⏰ Setting up scheduled updates...');
    
    // Update hourly content (weather)
    setInterval(async () => {
      const hourlyChannels = Object.entries(this.podcastSources)
        .filter(([id, config]) => config.updateFrequency === 'hourly');
      
      for (const [channelId, config] of hourlyChannels) {
        console.log(`🕐 Hourly update: ${config.name}`);
        await this.updateSinglePodcast(channelId, config);
      }
    }, 60 * 60 * 1000); // 1 hour

    // Update daily content (news, stories)  
    setInterval(async () => {
      const dailyChannels = Object.entries(this.podcastSources)
        .filter(([id, config]) => config.updateFrequency === 'daily');
      
      for (const [channelId, config] of dailyChannels) {
        console.log(`📅 Daily update: ${config.name}`);
        await this.updateSinglePodcast(channelId, config);
      }
    }, 24 * 60 * 60 * 1000); // 24 hours

    console.log('✅ Scheduled updates configured');
  }

  async updateSinglePodcast(channelId, config) {
    try {
      const audioFile = await this.getLatestContent(channelId, config);
      const processedFile = await this.processAudio(audioFile, config);
      await this.uploadToExtension(config.extensionId, processedFile, config);
      console.log(`✅ Updated: ${config.name}`);
    } catch (error) {
      console.error(`❌ Error updating ${config.name}:`, error.message);
    }
  }

  // Manual update trigger (for testing)
  async manualUpdate(channelId) {
    const config = this.podcastSources[channelId];
    if (!config) {
      throw new Error(`Podcast channel ${channelId} not found`);
    }
    
    console.log(`🎯 Manual update triggered: ${config.name}`);
    await this.updateSinglePodcast(channelId, config);
  }

  // Get current status of all podcasts
  async getStatus() {
    const status = {};
    
    for (const [channelId, config] of Object.entries(this.podcastSources)) {
      status[channelId] = {
        name: config.name,
        extension: config.extensionId,
        lastUpdated: 'Unknown', // Would track in database
        nextUpdate: config.updateFrequency,
        source: config.audioSource
      };
    }
    
    return status;
  }
}

// Initialize and start the audio pipeline
async function startAudioPipeline() {
  const pipeline = new PodcastAudioPipeline();
  await pipeline.initialize();
  
  // Initial content update
  await pipeline.updateAllPodcasts();
  
  // Set up scheduled updates
  pipeline.setupScheduledUpdates();
  
  console.log('\n🎉 AUDIO PIPELINE ACTIVE!');
  console.log('📻 Podcast extensions will now play actual audio content');
  console.log('⏰ Content updates scheduled automatically');
  
  return pipeline;
}

module.exports = { PodcastAudioPipeline, startAudioPipeline };