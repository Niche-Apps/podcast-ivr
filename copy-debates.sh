#!/bin/bash

echo "🎙️  Copying debate MP3 files for Railway deployment..."

# Ensure public/debates directory exists
mkdir -p public/debates

# Copy MP3 files from your audio directory to public/debates
echo "📁 Copying files from /Users/josephsee/audio/ to public/debates/"

# List files being copied
ls -la /Users/josephsee/audio/*.mp3 2>/dev/null || echo "No MP3 files found in /Users/josephsee/audio/"

# Copy files
cp /Users/josephsee/audio/*.mp3 public/debates/ 2>/dev/null

# Show what was copied
echo ""
echo "📊 Files in public/debates/:"
ls -la public/debates/*.mp3 2>/dev/null || echo "No MP3 files copied"

echo ""
echo "✅ Files ready for Railway deployment"
echo "💡 Now run: git add public/debates/*.mp3 && git commit -m 'Add debate MP3 files' && git push"
echo "⚠️  Note: These are large files - deployment may take time"