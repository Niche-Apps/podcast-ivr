# 🇬🇧 British Voice Audio Generation Guide

## 📁 **Text Scripts Created:**

All scripts are written in proper British English style and ready for TTS generation:

### **Main IVR Menu:**
- **File:** `audio_scripts/main-greeting.txt`
- **Purpose:** Primary greeting callers hear when calling (904) 371-2672
- **Duration:** ~30 seconds

### **Podcast Introductions:**
- **Tech News:** `audio_scripts/tech-news-intro.txt` 
- **Weather:** `audio_scripts/weather-intro.txt`
- **Stories:** `audio_scripts/stories-intro.txt`

### **Full Podcast Content:**
- **Tech News:** `audio_scripts/tech-news-content.txt`
- **Weather:** `audio_scripts/weather-content.txt` 
- **Stories:** `audio_scripts/stories-content.txt`

---

## 🎙️ **Option 1: Generate Audio via Railway App**

Your Railway app has the British TTS system built-in. Use these API calls:

```bash
# Main greeting
curl -X POST https://podcast-ivr-production.up.railway.app/api/tts/generate \
  -H "Content-Type: application/json" \
  -d '{"text": "Good day and welcome to the Podcast Hotline! Your premier source for on-demand audio content. Please press 1 for today'\''s Daily Tech News, featuring the latest technology updates and industry insights from across the globe. Press 2 for Weather and Traffic, providing you with current local conditions and travel updates. Press 3 for Daily Stories, featuring engaging narratives and premium storytelling content. Press 9 to repeat this menu, or press 0 to speak with one of our representatives. Please make your selection now.", "filename": "main-greeting.mp3"}'

# Tech news intro
curl -X POST https://podcast-ivr-production.up.railway.app/api/tts/generate \
  -H "Content-Type: application/json" \
  -d '{"text": "You'\''ve selected Daily Tech News. This episode is brought to you by TechCorp Solutions, your trusted partner in digital transformation. Stay tuned for today'\''s top technology stories from Britain and around the world.", "filename": "tech-news-intro.mp3"}'

# Weather intro  
curl -X POST https://podcast-ivr-production.up.railway.app/api/tts/generate \
  -H "Content-Type: application/json" \
  -d '{"text": "You'\''ve selected Weather and Traffic. This update is proudly sponsored by Dallas Auto Group, serving all your automotive needs across the region.", "filename": "weather-intro.mp3"}'

# Stories intro
curl -X POST https://podcast-ivr-production.up.railway.app/api/tts/generate \
  -H "Content-Type: application/json" \
  -d '{"text": "You'\''ve selected Daily Stories. Today'\''s narrative is presented by StoryBrand Publishing, where every story matters and every tale finds its voice.", "filename": "stories-intro.mp3"}'
```

Then download the generated files:
```bash
curl https://podcast-ivr-production.up.railway.app/audio/main-greeting.mp3 -o main-greeting.mp3
curl https://podcast-ivr-production.up.railway.app/audio/tech-news-intro.mp3 -o tech-news-intro.mp3
curl https://podcast-ivr-production.up.railway.app/audio/weather-intro.mp3 -o weather-intro.mp3
curl https://podcast-ivr-production.up.railway.app/audio/stories-intro.mp3 -o stories-intro.mp3
```

---

## 🎙️ **Option 2: Use Online TTS Services**

### **Recommended British Male Voices:**

1. **Google Cloud TTS:**
   - Voice: `en-GB-Neural2-B` or `en-GB-Wavenet-B`
   - High quality, natural British accent

2. **Amazon Polly:**
   - Voice: `Brian` (British male)
   - Neural engine for best quality

3. **Microsoft Azure:**
   - Voice: `en-GB-RyanNeural` or `en-GB-ThomasNeural`

4. **ElevenLabs:** 
   - Custom British male voices
   - Very high quality but paid service

### **Free Online Options:**
- **Speechify:** https://speechify.com/text-to-speech-online
- **Natural Reader:** https://www.naturalreaders.com/online/
- **TTSMaker:** https://ttsmaker.com (supports British voices)

---

## 🔧 **Option 3: Set up Google Cloud TTS Locally**

1. **Create Google Cloud Account:**
   - Go to https://cloud.google.com
   - Enable Text-to-Speech API
   - Create service account and download credentials JSON

2. **Set Environment Variable:**
   ```bash
   export GOOGLE_APPLICATION_CREDENTIALS="/path/to/your/credentials.json"
   ```

3. **Run the Generator:**
   ```bash
   node generate-audio.js
   ```

---

## 📋 **Upload Instructions for RingCentral:**

Once you have the MP3 files:

1. **For Main Greeting:**
   - Upload `main-greeting.mp3` to your Auto-Receptionist greeting

2. **For Extensions:**
   - Extension 101: Upload `tech-news-intro.mp3` + `tech-news-content.mp3`
   - Extension 102: Upload `weather-intro.mp3` + `weather-content.mp3`  
   - Extension 103: Upload `stories-intro.mp3` + `stories-content.mp3`

3. **File Requirements:**
   - Format: MP3 or WAV
   - Max size: Usually 10MB per file
   - Recommended quality: 44.1kHz, 16-bit

---

## 🎯 **Quick Test:**

After uploading, call `(904) 371-2672` and you should hear your professional British voice greeting! 🇬🇧