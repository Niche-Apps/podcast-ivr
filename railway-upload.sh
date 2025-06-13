#!/bin/bash

# Railway upload script for debate MP3 files
echo "🚂 Railway MP3 Upload Script"
echo "============================"

# Set Railway token
export RAILWAY_TOKEN=775a3b1e-37dd-46cf-aa93-46b8c2eb8ab6

# Link to your project
echo "🔗 Linking to Railway project..."
railway link 388935f6-4305-4087-be51-95ab9f14b59c

# Create debates directory on Railway
echo "📁 Creating debates directory..."
railway shell -- mkdir -p public/debates

# Upload each MP3 file using Railway volumes or direct deployment
echo "📤 Uploading MP3 files..."

cd public/debates

for file in *.mp3; do
    if [ -f "$file" ]; then
        echo "   Uploading: $file"
        # Use railway shell with proper syntax
        cat "$file" | railway shell -- sh -c "cat > public/debates/$file"
    fi
done

echo "✅ Upload complete!"
echo "🔗 Test at: https://podcast-ivr-production.up.railway.app/debates-list"