#!/bin/bash

echo "🚀 Deploying Podcast IVR to Railway..."

# Check if Railway CLI is installed
if ! command -v railway &> /dev/null; then
    echo "❌ Railway CLI not found. Installing..."
    npm install -g @railway/cli
fi

# Login to Railway (if not already logged in)
echo "🔐 Checking Railway authentication..."
railway login

# Link to existing project (if not already linked)
echo "🔗 Linking to Railway project..."
railway link

# Set environment variables
echo "📝 Setting environment variables..."
railway variables set TWILIO_ACCOUNT_SID=$TWILIO_ACCOUNT_SID
railway variables set TWILIO_AUTH_TOKEN=$TWILIO_AUTH_TOKEN
railway variables set TWILIO_PHONE_NUMBER=$TWILIO_PHONE_NUMBER
railway variables set PORT=3000

# Deploy the application
echo "🚀 Deploying application..."
railway up

echo "✅ Deployment complete!"
echo "📞 Your Twilio webhook URL should be: https://your-railway-app.railway.app/webhook/ivr-main"