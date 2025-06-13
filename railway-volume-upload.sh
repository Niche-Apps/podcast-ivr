#!/bin/bash

# Railway volume upload script for debate MP3 files
echo "🚂 Railway Volume Upload Script"
echo "==============================="

# Set Railway token
export RAILWAY_TOKEN=775a3b1e-37dd-46cf-aa93-46b8c2eb8ab6

# Link to your project
echo "🔗 Linking to Railway project..."
railway link 388935f6-4305-4087-be51-95ab9f14b59c

# Create debates directory on Railway
echo "📁 Creating debates directory..."
railway shell
# Inside shell, run: mkdir -p public/debates

echo ""
echo "📋 Manual Upload Instructions:"
echo "1. Run: railway shell"
echo "2. Inside Railway shell run: mkdir -p public/debates"
echo "3. Exit Railway shell"
echo "4. Upload files one by one:"
echo ""

cd public/debates

for file in *.mp3; do
    if [ -f "$file" ]; then
        echo "   railway run -- curl -X PUT --data-binary '@$file' http://localhost:3000/upload-debate"
    fi
done

echo ""
echo "Or try Railway's file transfer method:"
echo "railway run -- ls -la public/debates/"