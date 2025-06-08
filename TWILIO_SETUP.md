# Twilio Podcast IVR Setup Guide

## Overview
This guide will help you deploy your podcast IVR system to Railway and connect it with Twilio for phone-based podcast playback.

## Prerequisites
- Twilio account
- Railway account
- GitHub repository

## Step 1: Railway Deployment

1. **Connect to Railway**
   ```bash
   # Push your code to GitHub
   git add .
   git commit -m "Add Twilio integration for podcast IVR"
   git push origin main
   ```

2. **Deploy to Railway**
   - Go to [Railway.app](https://railway.app)
   - Click "Start a New Project"
   - Connect your GitHub repository
   - Railway will automatically detect and deploy your Node.js app

3. **Set Environment Variables in Railway**
   ```
   TWILIO_ACCOUNT_SID=your_twilio_account_sid
   TWILIO_AUTH_TOKEN=your_twilio_auth_token
   PORT=3000
   GOOGLE_APPLICATION_CREDENTIALS=path/to/service-account.json
   TTS_VOICE_NAME=en-GB-Neural2-B
   BASE_URL=https://your-railway-deployment.railway.app
   ```

## Step 2: Twilio Configuration

### Option A: Using Twilio Functions (Recommended)

1. **Create a Twilio Function**
   - Go to Twilio Console > Functions
   - Create a new Function
   - Copy the code from `twilio-function.js`
   - Set environment variable: `RAILWAY_URL=https://your-railway-deployment.railway.app`

2. **Configure Phone Number**
   - Go to Phone Numbers > Manage > Active Numbers
   - Click on your Twilio phone number
   - Set webhook URL to your Twilio Function URL
   - Method: POST

### Option B: Direct Webhook (Alternative)

1. **Configure Phone Number Webhook**
   - Go to Phone Numbers > Manage > Active Numbers
   - Click on your Twilio phone number
   - Set webhook URL: `https://your-railway-deployment.railway.app/webhook/ivr-main`
   - Method: POST

## Step 3: Podcast Audio Setup

The system expects audio files in this format:
- `podcast-1-latest.mp3` (NPR News Now)
- `podcast-2-latest.mp3` (This American Life)
- `podcast-3-latest.mp3` (The Daily)
- etc.

Place these files in the `podcast_audio/` directory.

## Step 4: Test Your Setup

1. **Test Railway Deployment**
   ```bash
   curl https://your-railway-deployment.railway.app/
   ```

2. **Test Twilio Integration**
   - Call your Twilio phone number
   - You should hear the main menu

3. **Test Podcast Playback**
   - Press a number during the IVR
   - The system should play the corresponding podcast

## Available Endpoints

### IVR Endpoints
- `POST /webhook/ivr-main` - Main IVR menu
- `POST /webhook/ivr-response` - Single digit responses
- `POST /webhook/ivr-response-extended` - Two digit responses
- `POST /webhook/post-podcast` - Post-podcast menu

### API Endpoints
- `GET /` - System status
- `GET /api/status` - Detailed system status
- `GET /analytics` - Call analytics and revenue tracking
- `GET /audio/:filename` - Serve audio files

### Management Endpoints
- `POST /update-podcast/:id` - Update specific podcast
- `POST /update-all-podcasts` - Update all podcasts
- `GET /podcast-status` - Podcast pipeline status

## Podcast Menu Structure

### Main Menu (Single Digits)
- 1: NPR News Now
- 2: This American Life  
- 3: The Daily
- 4: Serial
- 5: Matt Walsh Show
- 6: Ben Shapiro Show
- 7: Michael Knowles Show
- 8: Andrew Klavan Show
- 9: Pints with Aquinas
- 0: Joe Rogan
- *: More options

### Extended Menu (Two Digits - after pressing *)
- 10: TimCast IRL
- 11: Louder with Crowder
- 12: Lex Fridman
- 13: Matt Walsh 2
- 20: Morning Wire

## Troubleshooting

1. **Audio Not Playing**
   - Check that audio files exist in `podcast_audio/`
   - Verify file permissions
   - Check Railway logs

2. **Webhook Not Working**
   - Verify Twilio webhook URL is correct
   - Check Railway deployment status
   - Review Twilio debugger logs

3. **TTS Not Working**
   - Verify Google Cloud credentials
   - Check TTS voice name setting
   - Review Railway environment variables

## Revenue Tracking

The system automatically tracks:
- Call duration
- Podcast selections
- Caller location (by area code)
- Revenue attribution per sponsor

View analytics at: `https://your-railway-deployment.railway.app/analytics`

## Environment Variables Reference

```bash
# Required
TWILIO_ACCOUNT_SID=your_account_sid
TWILIO_AUTH_TOKEN=your_auth_token

# Optional
PORT=3000
BASE_URL=https://your-railway-deployment.railway.app
TTS_VOICE_NAME=en-GB-Neural2-B
GOOGLE_APPLICATION_CREDENTIALS=path/to/service-account.json
MAIN_PHONE_NUMBER=+1234567890
```