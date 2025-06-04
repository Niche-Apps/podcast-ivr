#!/bin/bash

# British Voice Audio Generation Script
# Uses your Railway app's Google TTS endpoint

echo "🇬🇧 Generating British voice audio files..."
echo "Using Railway TTS endpoint: https://podcast-ivr-production.up.railway.app"
echo ""

# Create output directory
mkdir -p generated_audio

# Function to generate audio file
generate_audio() {
    local text_file="$1"
    local output_name="$2"
    local description="$3"
    
    echo "🎤 Generating: $description"
    
    # Read text from file and escape quotes
    local text_content=$(cat "$text_file" | tr '\n' ' ' | sed 's/"/\\"/g' | sed "s/'/\\'/g")
    
    # Generate audio via Railway TTS API
    curl -X POST https://podcast-ivr-production.up.railway.app/api/tts/generate \
        -H "Content-Type: application/json" \
        -d "{\"text\": \"$text_content\", \"filename\": \"$output_name\", \"voice\": \"en-GB-Neural2-B\"}" \
        -s -o "/tmp/${output_name}.response"
    
    # Check if generation was successful
    if grep -q "success.*true" "/tmp/${output_name}.response"; then
        echo "✅ Generated: $output_name"
        
        # Download the generated file
        curl -s "https://podcast-ivr-production.up.railway.app/audio/$output_name" \
            -o "generated_audio/$output_name"
        
        # Check file size
        local size=$(wc -c < "generated_audio/$output_name")
        echo "📁 File size: $size bytes"
        
        if [ $size -gt 100 ]; then
            echo "✅ Audio file successfully generated"
        else
            echo "⚠️  File seems small - might be demo content"
        fi
    else
        echo "❌ Failed to generate $output_name"
        cat "/tmp/${output_name}.response"
    fi
    
    echo ""
}

# Generate all audio files
echo "Starting audio generation..."
echo ""

generate_audio "audio_scripts/main-greeting.txt" "main-greeting.mp3" "Main IVR Greeting"
generate_audio "audio_scripts/tech-news-intro.txt" "tech-news-intro.mp3" "Tech News Introduction" 
generate_audio "audio_scripts/tech-news-content.txt" "tech-news-content.mp3" "Tech News Content"
generate_audio "audio_scripts/weather-intro.txt" "weather-intro.mp3" "Weather Introduction"
generate_audio "audio_scripts/weather-content.txt" "weather-content.mp3" "Weather Content"
generate_audio "audio_scripts/stories-intro.txt" "stories-intro.mp3" "Stories Introduction"
generate_audio "audio_scripts/stories-content.txt" "stories-content.mp3" "Stories Content"

echo "🎉 Audio generation complete!"
echo ""
echo "📁 Generated files in ./generated_audio/:"
ls -la generated_audio/

echo ""
echo "🔊 To test the audio files:"
echo "   - Upload main-greeting.mp3 to RingCentral Auto-Receptionist"
echo "   - Upload intro + content files to respective extensions"
echo "   - Call (904) 371-2672 to test"
echo ""
echo "🇬🇧 Your British voice podcast system is ready!"