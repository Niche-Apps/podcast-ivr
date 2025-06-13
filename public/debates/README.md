# Debates Audio Files

This folder contains MP3 files for Extension 50 (Debates).

**Note: MP3 files are excluded from git due to large file sizes**

## Local Development:

1. **Copy files locally for testing:**
   ```bash
   cp /Users/josephsee/audio/*.mp3 /Users/josephsee/podcast-ivr/public/debates/
   ```

2. **Files are ignored by git** (see .gitignore)

## Railway Deployment:

For production, upload MP3 files directly to Railway using:

1. **Railway CLI:**
   ```bash
   railway shell "mkdir -p public/debates"
   # Upload files through Railway dashboard or CLI
   ```

2. **Railway Dashboard:**
   - Go to your Railway project
   - Upload files to `public/debates/` folder

## URLs:
- **Local:** http://localhost:3000/debates/filename.mp3
- **Production:** https://podcast-ivr-production.up.railway.app/debates/filename.mp3
- **Debug:** https://podcast-ivr-production.up.railway.app/debates-list

## Extension 50:
- Automatically detects all MP3 files in this folder
- Plays them in alphabetical order
- Navigate with *1 (next), *2 (previous), ** (main menu)