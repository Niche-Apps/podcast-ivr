# Podcast IVR System

A comprehensive Interactive Voice Response (IVR) system for serving podcast content via phone calls, deployed on Railway.

## Features

### Core Functionality
- **Multi-Channel Support**: 90+ channels for different podcast feeds
- **Episode Navigation**: Browse, play, skip, and control playback speed
- **Caller Analytics**: Track caller sessions, listening time, and preferences
- **Ad System**: Dynamic ad insertion with pre-roll and mid-roll support
- **Episode Caching**: Intelligent caching system for faster playback
- **Weather Updates**: Get local weather information via channel 99

### Storage Management (NEW)
The Podcast IVR Manager GUI now includes comprehensive storage volume management capabilities:

#### Storage Features
- **File Browser**: View and manage files across multiple storage directories
  - Cached episodes directory
  - Debates directory
  - Audio directory
- **File Operations**:
  - Upload audio files (MP3, WAV, M4A) to debates or audio directories
  - Delete unwanted files to free up space
  - View file metadata (size, creation date, modification date)
- **Cache Management**:
  - View cache statistics (total episodes, size, last cleanup)
  - Clear expired cache entries
  - Clear cache for specific channels
- **Real-time Statistics**:
  - Total files count
  - Total storage used
  - Cached episodes count
  - Debate files count

#### API Endpoints
- `GET /api/storage/list` - List all files and directories
- `DELETE /api/storage/delete` - Delete a specific file
- `POST /api/storage/upload` - Upload new audio files
- `POST /api/storage/clear-cache` - Clear cache (all or by channel)

## GUI Management Interface

Access the management interface to control your podcast IVR system:

### Launch GUI
```bash
cd gui
npm install
npm run dev
```

Then open http://localhost:5173 in your browser.

### GUI Features
- **Podcast Management**: Add/remove podcast feeds, configure channels
- **Analytics Dashboard**: View caller data, listening patterns, call duration
- **Server Control**: Start/stop server, view logs, restart services
- **Storage Management**: Browse files, upload content, manage cache
- **Call Testing**: Test IVR channels and functionality

## Deployment

The system is deployed on Railway with automatic deployments from the main branch.

### Environment Variables Required
- `SIGNALWIRE_ACCOUNT_SID` or `TWILIO_ACCOUNT_SID`
- `SIGNALWIRE_AUTH_TOKEN` or `TWILIO_AUTH_TOKEN`
- `SIGNALWIRE_PHONE_NUMBER` or `TWILIO_PHONE_NUMBER`
- `WEATHER_API_KEY` (optional, for weather feature)

### Railway Configuration
- **Build**: Uses Nixpacks
- **Health Check**: Root endpoint `/`
- **Storage Volume**: Mounted at `/app/public/debates` for persistent file storage

## Technical Details

### Architecture
- **Server**: Node.js/Express server (server.js)
- **Voice Provider**: SignalWire or Twilio
- **Caching**: Local file-based episode cache
- **Analytics**: In-memory storage with JSON persistence
- **GUI**: Vanilla JavaScript with Vite build system

### Key Components
- `server.js` - Main server application
- `episode-cache.js` - Episode caching system
- `caller-analytics.js` - Analytics tracking
- `ad-system.js` - Advertisement management
- `gui/` - Web management interface

## Recent Updates

### Dynamic Feed Configuration (NEW)
- Edit podcast feeds without redeploying server
- All configuration stored in `podcast-feeds.json` file
- Real-time updates through GUI or API
- Separate active and extension feeds management
- Protected system channels (0, 1, 90, 99)

### Storage Volume Management
- Browse and manage Railway storage volumes
- Upload/delete audio files
- View cache statistics
- Clear expired cache entries

### API Endpoints for Feed Management
- `GET /api/feeds/list` - List all configured feeds
- `GET /api/feeds/config` - Get full configuration
- `PUT /api/feeds/update/:channel` - Update feed details
- `DELETE /api/feeds/delete/:channel` - Remove feed
- `POST /api/feeds/activate/:channel` - Activate extension feed
- `POST /api/feeds/reload` - Reload configuration from file

## License

MIT