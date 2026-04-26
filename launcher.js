/**
 * Flic Video Player - Electron Main Process
 * Handles window management, Flic daemon, and IPC communication
 */

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

// Flic Manager
let FlicManager;
try {
    FlicManager = require('./flic/flicManager');
} catch (err) {
    console.error('Failed to load FlicManager:', err.message);
}

// Global references
let launcherWindow = null;
let playerWindow = null;
let serverProcess = null;
let flicManager = null;

// Config paths
const userDataPath = app.getPath('userData');
const documentsPath = app.getPath('documents');
const videoConfigPath = path.join(userDataPath, 'video-config.json');
const flicConfigPath = path.join(userDataPath, 'flic-bluetooth-config.json');
const videosPath = path.join(documentsPath, 'VideoPlayer', 'videos');
const cachePath = path.join(documentsPath, 'VideoPlayer', 'cache');

// Ensure directories exist
function ensureDirectories() {
    [userDataPath, videosPath, cachePath].forEach(dir => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    });
}

// Load video configuration
function loadVideoConfig() {
    try {
        if (fs.existsSync(videoConfigPath)) {
            return JSON.parse(fs.readFileSync(videoConfigPath, 'utf8'));
        }
    } catch (err) {
        console.error('Error loading video config:', err);
    }
    return {
        defaultVideo: '',
        videos: {}
    };
}

// Save video configuration
function saveVideoConfig(config) {
    try {
        fs.writeFileSync(videoConfigPath, JSON.stringify(config, null, 2));
        return true;
    } catch (err) {
        console.error('Error saving video config:', err);
        return false;
    }
}

// Load Flic button configuration
function loadFlicConfig() {
    try {
        if (fs.existsSync(flicConfigPath)) {
            return JSON.parse(fs.readFileSync(flicConfigPath, 'utf8'));
        }
    } catch (err) {
        console.error('Error loading Flic config:', err);
    }
    return { buttons: {} };
}

// Save Flic button configuration
function saveFlicConfig(config) {
    try {
        fs.writeFileSync(flicConfigPath, JSON.stringify(config, null, 2));
        return true;
    } catch (err) {
        console.error('Error saving Flic config:', err);
        return false;
    }
}

// Create the launcher window
function createLauncherWindow() {
    launcherWindow = new BrowserWindow({
        width: 900,
        height: 700,
        minWidth: 800,
        minHeight: 600,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        },
        title: 'Flic Video Player - Launcher',
        autoHideMenuBar: true
    });

    launcherWindow.loadFile('launcher.html');

    launcherWindow.on('closed', () => {
        launcherWindow = null;
    });
}

// Create the fullscreen player window
function createPlayerWindow() {
    playerWindow = new BrowserWindow({
        fullscreen: true,
        kiosk: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        },
        title: 'Video Player',
        autoHideMenuBar: true,
        frame: false
    });

    playerWindow.loadFile('player.html');

    playerWindow.on('closed', () => {
        playerWindow = null;
    });

    // Allow ESC to exit fullscreen in development
    playerWindow.webContents.on('before-input-event', (event, input) => {
        if (input.key === 'Escape') {
            playerWindow.close();
        }
    });
}

// Start the Express/WebSocket server
function startServer() {
    return new Promise((resolve, reject) => {
        const serverPath = path.join(__dirname, 'server.js');

        serverProcess = spawn(process.execPath, [serverPath], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {
                ...process.env,
                VIDEOS_PATH: videosPath,
                CACHE_PATH: cachePath,
                VIDEO_CONFIG_PATH: videoConfigPath
            }
        });

        serverProcess.stdout.on('data', (data) => {
            console.log(`Server: ${data}`);
            if (data.toString().includes('Server running')) {
                resolve();
            }
        });

        serverProcess.stderr.on('data', (data) => {
            console.error(`Server error: ${data}`);
        });

        serverProcess.on('error', (err) => {
            console.error('Failed to start server:', err);
            reject(err);
        });

        serverProcess.on('exit', (code) => {
            console.log(`Server exited with code ${code}`);
        });

        // Resolve after timeout if no message received
        setTimeout(resolve, 3000);
    });
}

// Stop the server
function stopServer() {
    if (serverProcess) {
        serverProcess.kill();
        serverProcess = null;
    }
}

// Initialize Flic Manager
async function initFlicManager() {
    if (!FlicManager) {
        console.log('FlicManager not available');
        return;
    }

    flicManager = new FlicManager();

    // Set up event handlers
    flicManager.on('connected', () => {
        console.log('Flic daemon connected');
        if (launcherWindow) {
            launcherWindow.webContents.send('flic-status', { status: 'connected' });
        }
    });

    flicManager.on('disconnected', () => {
        console.log('Flic daemon disconnected');
        if (launcherWindow) {
            launcherWindow.webContents.send('flic-status', { status: 'disconnected' });
        }
    });

    flicManager.on('error', (err) => {
        console.error('Flic error:', err.message);
        if (launcherWindow) {
            launcherWindow.webContents.send('flic-status', { status: 'error', message: err.message });
        }
    });

    flicManager.on('buttonEvent', (event) => {
        handleButtonEvent(event);
    });

    flicManager.on('buttonStatusChanged', (status) => {
        if (launcherWindow) {
            launcherWindow.webContents.send('button-status-changed', status);
        }
    });

    flicManager.on('pairingStatus', (status) => {
        if (launcherWindow) {
            launcherWindow.webContents.send('pairing-status', status);
        }
    });

    flicManager.on('buttonPaired', (bdAddr) => {
        if (launcherWindow) {
            launcherWindow.webContents.send('button-paired', bdAddr);
        }
    });

    flicManager.on('buttonRemoved', (bdAddr) => {
        if (launcherWindow) {
            launcherWindow.webContents.send('button-removed', bdAddr);
        }
    });

    // Start the daemon
    try {
        await flicManager.startDaemon();
        console.log('Flic daemon started successfully');
    } catch (err) {
        console.error('Failed to start Flic daemon:', err.message);
    }
}

// Handle button events
function handleButtonEvent(event) {
    const { bdAddr, clickType } = event;
    const config = loadFlicConfig();
    const button = config.buttons[bdAddr];

    if (!button) {
        console.log(`Unknown button: ${bdAddr}`);
        return;
    }

    const videoNumber = button.videoNumber;

    switch (clickType) {
        case 'ButtonSingleClick':
            console.log(`Button ${bdAddr} → Video ${videoNumber} (with sound)`);
            triggerVideo(videoNumber, 'click');
            break;

        case 'ButtonDoubleClick':
            console.log(`Button ${bdAddr} → Video ${videoNumber} (muted)`);
            triggerVideo(videoNumber, 'double_click');
            break;

        case 'ButtonHold':
            console.log(`Button ${bdAddr} → Return to default`);
            returnToDefault();
            break;
    }
}

// Trigger video via HTTP request to server
function triggerVideo(videoNumber, clickType) {
    const postData = JSON.stringify({
        video: videoNumber,
        click_type: clickType
    });

    const req = http.request({
        hostname: 'localhost',
        port: 5555,
        path: '/changeVideo',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': postData.length
        }
    });

    req.on('error', (err) => {
        console.error('Error triggering video:', err);
    });

    req.write(postData);
    req.end();
}

// Return to default video
function returnToDefault() {
    const req = http.request({
        hostname: 'localhost',
        port: 5555,
        path: '/close',
        method: 'POST'
    });
    req.on('error', (err) => console.error('Error:', err));
    req.end();
}

// IPC Handlers

// Video config handlers
ipcMain.handle('get-video-config', () => loadVideoConfig());
ipcMain.handle('save-video-config', (event, config) => saveVideoConfig(config));
ipcMain.handle('get-videos-path', () => videosPath);
ipcMain.handle('get-cache-path', () => cachePath);

// File dialog handlers
ipcMain.handle('select-video-file', async () => {
    const result = await dialog.showOpenDialog(launcherWindow, {
        title: 'Select Video File',
        defaultPath: videosPath,
        filters: [
            { name: 'Videos', extensions: ['mp4', 'webm', 'mov', 'avi', 'mkv'] }
        ],
        properties: ['openFile']
    });

    if (!result.canceled && result.filePaths.length > 0) {
        return result.filePaths[0];
    }
    return null;
});

// Flic button handlers
ipcMain.handle('get-flic-config', () => loadFlicConfig());
ipcMain.handle('save-flic-config', (event, config) => saveFlicConfig(config));

ipcMain.handle('get-paired-buttons', async () => {
    if (!flicManager) return [];
    try {
        return await flicManager.getPairedButtons();
    } catch (err) {
        console.error('Error getting paired buttons:', err);
        return [];
    }
});

ipcMain.handle('start-button-pairing', async () => {
    if (!flicManager) throw new Error('Flic manager not initialized');
    return flicManager.startPairing();
});

ipcMain.handle('cancel-button-pairing', () => {
    if (flicManager) {
        flicManager.cancelPairing();
    }
});

ipcMain.handle('remove-button', async (event, bdAddr) => {
    if (!flicManager) throw new Error('Flic manager not initialized');

    // Remove from daemon
    await flicManager.removeButton(bdAddr);

    // Remove from config
    const config = loadFlicConfig();
    delete config.buttons[bdAddr];
    saveFlicConfig(config);

    return true;
});

ipcMain.handle('set-button-mapping', (event, bdAddr, videoNumber, name) => {
    const config = loadFlicConfig();
    config.buttons[bdAddr] = {
        name: name || `Button ${Object.keys(config.buttons).length + 1}`,
        videoNumber: videoNumber
    };
    return saveFlicConfig(config);
});

ipcMain.handle('get-bluetooth-status', async () => {
    if (!flicManager) {
        return { state: 'unavailable' };
    }
    try {
        return await flicManager.getBluetoothStatus();
    } catch (err) {
        return { state: 'error', message: err.message };
    }
});

// Player control handlers
ipcMain.handle('launch-player', async () => {
    try {
        await startServer();
        createPlayerWindow();
        return true;
    } catch (err) {
        console.error('Error launching player:', err);
        return false;
    }
});

ipcMain.handle('close-player', () => {
    if (playerWindow) {
        playerWindow.close();
    }
    stopServer();
    return true;
});

// App lifecycle
app.whenReady().then(async () => {
    ensureDirectories();
    createLauncherWindow();

    // Initialize Flic manager (will fail gracefully if not available)
    await initFlicManager();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createLauncherWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', () => {
    stopServer();
    if (flicManager) {
        flicManager.stop();
    }
});
