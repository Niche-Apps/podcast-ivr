const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

class AudioProcessor {
  constructor() {
    this.processedDir = path.join(__dirname, 'processed_audio');
    this.chunksDir = path.join(__dirname, 'audio_chunks');
    this.ensureDirectories();
    
    // Common speed presets for caching
    this.speedPresets = [0.75, 1.0, 1.25, 1.5, 2.0];
    this.chunkDuration = 30; // 30-second chunks for seeking
    
    // Configure FFmpeg paths
    this.setupFFmpeg();
  }
  
  setupFFmpeg() {
    try {
      // Set FFmpeg paths from environment or defaults
      const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
      const ffprobePath = process.env.FFPROBE_PATH || 'ffprobe';
      
      ffmpeg.setFfmpegPath(ffmpegPath);
      ffmpeg.setFfprobePath(ffprobePath);
      
      console.log(`🎵 FFmpeg configured: ${ffmpegPath}`);
    } catch (error) {
      console.warn(`⚠️ FFmpeg setup warning:`, error.message);
    }
  }

  ensureDirectories() {
    [this.processedDir, this.chunksDir].forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`📁 Created directory: ${dir}`);
      }
    });
  }

  // Check if FFmpeg is available
  async checkFFmpegAvailable() {
    return new Promise((resolve) => {
      const { exec } = require('child_process');
      exec('ffmpeg -version', (error) => {
        resolve(!error);
      });
    });
  }

  // Generate speed-adjusted version of audio file
  async processAudioSpeed(inputPath, outputPath, speed) {
    const ffmpegAvailable = await this.checkFFmpegAvailable();
    if (!ffmpegAvailable) {
      console.warn(`⚠️ FFmpeg not available - skipping audio processing`);
      throw new Error('FFmpeg not available');
    }
    
    return new Promise((resolve, reject) => {
      console.log(`🎵 Processing audio: ${speed}x speed`);
      
      ffmpeg(inputPath)
        .audioFilters(`atempo=${speed}`)
        .audioBitrate(128) // Consistent bitrate for phone compatibility
        .audioChannels(1)  // Mono for better phone compatibility
        .audioFrequency(22050) // Lower sample rate for smaller files
        .format('mp3')
        .on('start', (commandLine) => {
          console.log(`🚀 FFmpeg started: ${commandLine}`);
        })
        .on('progress', (progress) => {
          if (progress.percent) {
            console.log(`📊 Processing: ${Math.round(progress.percent)}%`);
          }
        })
        .on('end', () => {
          console.log(`✅ Speed processing complete: ${speed}x`);
          resolve(outputPath);
        })
        .on('error', (err) => {
          console.error(`❌ FFmpeg error:`, err.message);
          reject(err);
        })
        .save(outputPath);
    });
  }

  // Create time-indexed chunks for precise seeking
  async createSeekChunks(inputPath, baseOutputPath) {
    return new Promise((resolve, reject) => {
      console.log(`🔪 Creating seek chunks: ${this.chunkDuration}s intervals`);
      
      // First, get duration
      ffmpeg.ffprobe(inputPath, (err, metadata) => {
        if (err) {
          console.error(`❌ FFprobe error:`, err.message);
          return reject(err);
        }
        
        const duration = metadata.format.duration;
        const chunks = Math.ceil(duration / this.chunkDuration);
        console.log(`📏 Audio duration: ${Math.round(duration)}s, creating ${chunks} chunks`);
        
        // Create chunks directory for this file
        const chunksPath = path.join(this.chunksDir, path.basename(baseOutputPath, '.mp3'));
        if (!fs.existsSync(chunksPath)) {
          fs.mkdirSync(chunksPath, { recursive: true });
        }
        
        let processedChunks = 0;
        const chunkPromises = [];
        
        for (let i = 0; i < chunks; i++) {
          const startTime = i * this.chunkDuration;
          const chunkPath = path.join(chunksPath, `chunk_${i.toString().padStart(3, '0')}.mp3`);
          
          const chunkPromise = new Promise((resolveChunk) => {
            ffmpeg(inputPath)
              .seekInput(startTime)
              .duration(this.chunkDuration)
              .audioBitrate(128)
              .audioChannels(1)
              .audioFrequency(22050)
              .format('mp3')
              .on('end', () => {
                processedChunks++;
                console.log(`📦 Chunk ${i + 1}/${chunks} complete`);
                resolveChunk(chunkPath);
              })
              .on('error', (err) => {
                console.warn(`⚠️ Chunk ${i} failed:`, err.message);
                resolveChunk(null); // Continue even if one chunk fails
              })
              .save(chunkPath);
          });
          
          chunkPromises.push(chunkPromise);
        }
        
        Promise.all(chunkPromises).then((chunkPaths) => {
          console.log(`✅ Created ${processedChunks} seek chunks`);
          resolve({
            chunksPath,
            chunkPaths: chunkPaths.filter(p => p !== null),
            chunkDuration: this.chunkDuration,
            totalChunks: processedChunks
          });
        });
      });
    });
  }

  // Process cached episode with multiple speeds and seek chunks
  async processEpisodeComplete(inputPath, episodeId) {
    try {
      console.log(`🎬 Starting complete processing for episode: ${episodeId}`);
      
      const results = {
        episodeId,
        originalPath: inputPath,
        speedVersions: {},
        seekChunks: null,
        processedAt: Date.now()
      };

      // Create speed versions for common presets
      for (const speed of this.speedPresets) {
        try {
          const speedPath = path.join(this.processedDir, `${episodeId}_${speed}x.mp3`);
          
          if (!fs.existsSync(speedPath)) {
            await this.processAudioSpeed(inputPath, speedPath, speed);
          } else {
            console.log(`⏭️ Speed version ${speed}x already exists`);
          }
          
          results.speedVersions[speed] = speedPath;
        } catch (speedError) {
          console.warn(`⚠️ Failed to create ${speed}x version:`, speedError.message);
        }
      }

      // Create seek chunks from 1x version
      try {
        const normalSpeedPath = results.speedVersions[1.0];
        if (normalSpeedPath && fs.existsSync(normalSpeedPath)) {
          results.seekChunks = await this.createSeekChunks(normalSpeedPath, normalSpeedPath);
        }
      } catch (chunkError) {
        console.warn(`⚠️ Failed to create seek chunks:`, chunkError.message);
      }

      console.log(`✅ Complete processing finished for episode: ${episodeId}`);
      return results;
      
    } catch (error) {
      console.error(`❌ Complete processing failed:`, error.message);
      throw error;
    }
  }

  // Real-time audio processing for on-demand speed changes
  createSpeedStream(inputPath, speed, seekTime = 0) {
    console.log(`🎵 Creating real-time speed stream: ${speed}x speed, seek: ${seekTime}s`);
    
    const ffmpegArgs = [
      '-i', inputPath,
      '-ss', seekTime.toString(),
      '-af', `atempo=${speed}`,
      '-acodec', 'mp3',
      '-ab', '128k',
      '-ac', '1',
      '-ar', '22050',
      '-f', 'mp3',
      'pipe:1'
    ];

    const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);
    
    ffmpegProcess.stderr.on('data', (data) => {
      // Log FFmpeg progress/errors
      const message = data.toString();
      if (message.includes('time=')) {
        const timeMatch = message.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
        if (timeMatch) {
          console.log(`🎵 Streaming progress: ${timeMatch[1]}`);
        }
      }
    });

    ffmpegProcess.on('error', (error) => {
      console.error(`❌ FFmpeg stream error:`, error.message);
    });

    return ffmpegProcess.stdout;
  }

  // Get seek chunk for precise seeking
  getSeekChunk(episodeId, seekTime) {
    const chunksPath = path.join(this.chunksDir, episodeId);
    if (!fs.existsSync(chunksPath)) {
      return null;
    }

    const chunkIndex = Math.floor(seekTime / this.chunkDuration);
    const chunkPath = path.join(chunksPath, `chunk_${chunkIndex.toString().padStart(3, '0')}.mp3`);
    
    if (fs.existsSync(chunkPath)) {
      const remainderTime = seekTime % this.chunkDuration;
      return {
        chunkPath,
        remainderTime,
        chunkIndex
      };
    }

    return null;
  }

  // Check if episode has processed versions available
  hasProcessedVersions(episodeId) {
    const versions = {};
    
    for (const speed of this.speedPresets) {
      const speedPath = path.join(this.processedDir, `${episodeId}_${speed}x.mp3`);
      versions[speed] = fs.existsSync(speedPath);
    }

    const chunksPath = path.join(this.chunksDir, episodeId);
    const hasChunks = fs.existsSync(chunksPath);

    return {
      speedVersions: versions,
      seekChunks: hasChunks,
      hasAny: Object.values(versions).some(v => v) || hasChunks
    };
  }

  // Get processed file path for specific speed
  getProcessedPath(episodeId, speed) {
    const speedPath = path.join(this.processedDir, `${episodeId}_${speed}x.mp3`);
    return fs.existsSync(speedPath) ? speedPath : null;
  }

  // Clean up old processed files (for storage management)
  async cleanup(maxAgeHours = 168) { // 7 days default
    const cutoffTime = Date.now() - (maxAgeHours * 60 * 60 * 1000);
    let cleanedCount = 0;

    console.log(`🧹 Starting audio processing cleanup (older than ${maxAgeHours} hours)`);

    // Clean processed files
    try {
      const processedFiles = fs.readdirSync(this.processedDir);
      for (const file of processedFiles) {
        const filePath = path.join(this.processedDir, file);
        const stats = fs.statSync(filePath);
        
        if (stats.mtime.getTime() < cutoffTime) {
          fs.unlinkSync(filePath);
          cleanedCount++;
        }
      }
    } catch (error) {
      console.warn(`⚠️ Cleanup processed files error:`, error.message);
    }

    // Clean chunk directories
    try {
      const chunkDirs = fs.readdirSync(this.chunksDir);
      for (const dir of chunkDirs) {
        const dirPath = path.join(this.chunksDir, dir);
        const stats = fs.statSync(dirPath);
        
        if (stats.mtime.getTime() < cutoffTime) {
          fs.rmSync(dirPath, { recursive: true, force: true });
          cleanedCount++;
        }
      }
    } catch (error) {
      console.warn(`⚠️ Cleanup chunk directories error:`, error.message);
    }

    console.log(`🧹 Cleanup complete: removed ${cleanedCount} old files/directories`);
    return cleanedCount;
  }

  // Get processing statistics
  getStats() {
    const stats = {
      processedFiles: 0,
      chunkDirectories: 0,
      totalSizeMB: 0,
      speedVersions: {},
      lastCleanup: null
    };

    try {
      // Count processed files
      const processedFiles = fs.readdirSync(this.processedDir);
      stats.processedFiles = processedFiles.length;
      
      // Calculate total size
      let totalSize = 0;
      for (const file of processedFiles) {
        const filePath = path.join(this.processedDir, file);
        const fileStats = fs.statSync(filePath);
        totalSize += fileStats.size;
        
        // Count by speed
        const speedMatch = file.match(/_(\d+(?:\.\d+)?)x\.mp3$/);
        if (speedMatch) {
          const speed = speedMatch[1];
          stats.speedVersions[speed] = (stats.speedVersions[speed] || 0) + 1;
        }
      }
      
      stats.totalSizeMB = Math.round(totalSize / 1024 / 1024);

      // Count chunk directories
      const chunkDirs = fs.readdirSync(this.chunksDir);
      stats.chunkDirectories = chunkDirs.length;
      
    } catch (error) {
      console.warn(`⚠️ Stats calculation error:`, error.message);
    }

    return stats;
  }
}

module.exports = AudioProcessor;