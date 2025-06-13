#!/bin/bash

# Sync audio files from local directory to Railway debates folder
# Usage: ./sync-audio.sh

LOCAL_AUDIO_DIR="/Users/josephsee/audio"
RAILWAY_DEBATES_DIR="./public/debates"

echo "🎵 Syncing audio files from $LOCAL_AUDIO_DIR to $RAILWAY_DEBATES_DIR"

# Check if local directory exists
if [ ! -d "$LOCAL_AUDIO_DIR" ]; then
    echo "❌ Local audio directory not found: $LOCAL_AUDIO_DIR"
    exit 1
fi

# Create debates directory if it doesn't exist
mkdir -p "$RAILWAY_DEBATES_DIR"

# Copy all MP3 files from local to Railway
echo "📂 Copying MP3 files..."
cp "$LOCAL_AUDIO_DIR"/*.mp3 "$RAILWAY_DEBATES_DIR/" 2>/dev/null

# Count files copied
MP3_COUNT=$(ls "$RAILWAY_DEBATES_DIR"/*.mp3 2>/dev/null | wc -l)

if [ $MP3_COUNT -gt 0 ]; then
    echo "✅ Copied $MP3_COUNT MP3 files to Railway debates folder"
    echo "📋 Files in debates folder:"
    ls -la "$RAILWAY_DEBATES_DIR"/*.mp3 2>/dev/null
    echo ""
    echo "🚀 Next steps:"
    echo "1. git add public/debates/"
    echo "2. git commit -m 'Add debate audio files'"
    echo "3. git push origin main"
    echo ""
    echo "📞 Files will be available at:"
    echo "   https://your-railway-app.com/debates/filename.mp3"
else
    echo "⚠️  No MP3 files found in $LOCAL_AUDIO_DIR"
fi