require('dotenv').config();
const textToSpeech = require('@google-cloud/text-to-speech');
const fs = require('fs');
const path = require('path');

// Initialize Google Cloud TTS client
const ttsClient = new textToSpeech.TextToSpeechClient();

// Audio files to generate
const audioFiles = [
  {
    script: 'audio_scripts/main-greeting.txt',
    output: 'generated_audio/main-greeting.mp3',
    description: 'Main IVR greeting'
  },
  {
    script: 'audio_scripts/tech-news-intro.txt', 
    output: 'generated_audio/tech-news-intro.mp3',
    description: 'Tech news introduction'
  },
  {
    script: 'audio_scripts/tech-news-content.txt',
    output: 'generated_audio/tech-news-content.mp3', 
    description: 'Tech news full content'
  },
  {
    script: 'audio_scripts/weather-intro.txt',
    output: 'generated_audio/weather-intro.mp3',
    description: 'Weather introduction'
  },
  {
    script: 'audio_scripts/weather-content.txt',
    output: 'generated_audio/weather-content.mp3',
    description: 'Weather full content'
  },
  {
    script: 'audio_scripts/stories-intro.txt',
    output: 'generated_audio/stories-intro.mp3',
    description: 'Stories introduction'
  },
  {
    script: 'audio_scripts/stories-content.txt',
    output: 'generated_audio/stories-content.mp3',
    description: 'Stories full content'
  }
];

async function generateBritishVoiceAudio(text, outputPath, description) {
  console.log(`🎤 Generating: ${description}`);
  
  try {
    // Prepare TTS request with British male voice
    const request = {
      input: { text: text },
      voice: {
        languageCode: 'en-GB',
        name: 'en-GB-Neural2-B',
        ssmlGender: 'MALE'
      },
      audioConfig: {
        audioEncoding: 'MP3',
        speakingRate: 0.95, // Slightly slower for clarity
        pitch: 0.0,
        volumeGainDb: 2.0 // Slightly louder
      }
    };

    // Add SSML for better pronunciation and pacing
    if (text.length > 100) {
      request.input = {
        ssml: `<speak><prosody rate="medium" pitch="medium">${text}</prosody></speak>`
      };
    }

    console.log(`🇬🇧 Generating speech with British Neural voice...`);
    
    // Call Google Cloud TTS
    const [response] = await ttsClient.synthesizeSpeech(request);
    
    if (response.audioContent) {
      // Write the audio content to file
      fs.writeFileSync(outputPath, response.audioContent, 'binary');
      console.log(`✅ Generated: ${outputPath} (${response.audioContent.length} bytes)`);
      return true;
    } else {
      throw new Error('No audio content returned from Google TTS');
    }
    
  } catch (error) {
    console.error(`❌ Failed to generate ${description}: ${error.message}`);
    
    // Create demo fallback file
    const fallbackContent = `BRITISH_VOICE_DEMO_${text.substring(0, 50)}`;
    fs.writeFileSync(outputPath, fallbackContent);
    console.log(`📄 Created demo file: ${outputPath}`);
    return false;
  }
}

async function generateAllAudio() {
  console.log('🎙️ Starting British voice audio generation...\n');
  
  // Ensure output directory exists
  const outputDir = 'generated_audio';
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  let successCount = 0;
  
  for (const audioFile of audioFiles) {
    try {
      // Read the script text
      const scriptText = fs.readFileSync(audioFile.script, 'utf8');
      
      // Generate audio
      const success = await generateBritishVoiceAudio(
        scriptText.trim(), 
        audioFile.output, 
        audioFile.description
      );
      
      if (success) successCount++;
      
      // Small delay between generations
      await new Promise(resolve => setTimeout(resolve, 1000));
      
    } catch (error) {
      console.error(`❌ Error processing ${audioFile.script}: ${error.message}`);
    }
  }
  
  console.log(`\n🎉 Audio generation complete!`);
  console.log(`✅ Successfully generated: ${successCount}/${audioFiles.length} files`);
  console.log(`📁 Audio files saved in: ./${outputDir}/`);
  
  // List generated files
  console.log('\n📋 Generated files:');
  audioFiles.forEach(file => {
    const exists = fs.existsSync(file.output);
    const size = exists ? fs.statSync(file.output).size : 0;
    console.log(`   ${exists ? '✅' : '❌'} ${file.output} (${size} bytes)`);
  });
}

// Run the generation
generateAllAudio().catch(console.error);