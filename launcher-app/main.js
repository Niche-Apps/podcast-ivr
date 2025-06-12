const { app, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const path = require('path');

// Path to the actual project
const PROJECT_PATH = '/Users/josephsee/podcast-ivr';

class LauncherApp {
  constructor() {
    this.mainWindow = null;
  }

  async createWindow() {
    // Create a simple loading window
    this.mainWindow = new BrowserWindow({
      width: 400,
      height: 300,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      },
      titleBarStyle: 'hiddenInset',
      resizable: false,
      show: true
    });

    // Show loading page
    this.mainWindow.loadURL('data:text/html,' + encodeURIComponent(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Podcast IVR Manager</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            margin: 0;
            padding: 40px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            text-align: center;
          }
          h1 { margin: 0 0 20px 0; }
          .loading { font-size: 18px; margin: 20px 0; }
          .spinner {
            width: 40px;
            height: 40px;
            border: 4px solid rgba(255,255,255,0.3);
            border-top: 4px solid white;
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin: 20px auto;
          }
          @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
          }
        </style>
      </head>
      <body>
        <h1>🎙️ Podcast IVR Manager</h1>
        <div class="spinner"></div>
        <div class="loading">Starting application...</div>
      </body>
      </html>
    `));

    // Start the actual GUI
    this.startGUI();
  }

  startGUI() {
    console.log('Starting GUI from project path:', PROJECT_PATH);
    
    // Use the bulletproof shell script
    const scriptProcess = spawn('/bin/bash', [PROJECT_PATH + '/launch-gui.sh'], {
      stdio: 'ignore',
      detached: true,
      env: {
        ...process.env,
        PATH: '/usr/local/bin:/usr/bin:/bin'
      }
    });

    scriptProcess.on('error', (error) => {
      console.error('Failed to start GUI script:', error);
      this.showError('Failed to start GUI: ' + error.message + '\\n\\nTry running from Terminal:\\ncd /Users/josephsee/podcast-ivr && npm run gui');
    });

    scriptProcess.on('spawn', () => {
      console.log('GUI script started successfully');
      // Close launcher window quickly since GUI should open
      setTimeout(() => {
        if (this.mainWindow) {
          this.mainWindow.close();
        }
      }, 1000);
    });

    // Completely detach the process
    scriptProcess.unref();
  }

  showError(message) {
    if (this.mainWindow) {
      this.mainWindow.loadURL('data:text/html,' + encodeURIComponent(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Error</title>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              margin: 0;
              padding: 40px;
              background: #f44336;
              color: white;
              text-align: center;
            }
            h1 { margin: 0 0 20px 0; }
            .error { font-size: 16px; margin: 20px 0; }
          </style>
        </head>
        <body>
          <h1>❌ Error</h1>
          <div class="error">${message}</div>
        </body>
        </html>
      `));
    }
  }
}

const launcher = new LauncherApp();

app.whenReady().then(() => {
  launcher.createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    launcher.createWindow();
  }
});