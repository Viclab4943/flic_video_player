/**
 * Flic Video Player - Electron Main Process
 * Handles window management, Flic daemon, and IPC communication
 */

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

// Server ports
const HTTP_PORT = 5555;
const WS_PORT = 8765;

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

// Check if a port is available
function checkPortAvailable(port) {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.once('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                resolve(false);
            } else {
                resolve(false);
            }
        });
        server.once('listening', () => {
            server.close();
            resolve(true);
        });
        server.listen(port, '127.0.0.1');
    });
}

// Check all required ports are available
async function checkRequiredPorts() {
    const ports = [
        { port: HTTP_PORT, name: 'HTTP Server' },
        { port: WS_PORT, name: 'WebSocket Server' }
    ];

    const unavailable = [];
    for (const { port, name } of ports) {
        const available = await checkPortAvailable(port);
        if (!available) {
            unavailable.push({ port, name });
        }
    }

    return unavailable;
}

// Wait for server to be ready via health check
function waitForServerReady(maxAttempts = 20, interval = 250) {
    return new Promise((resolve, reject) => {
        let attempts = 0;

        const checkHealth = () => {
            attempts++;

            const req = http.request({
                hostname: 'localhost',
                port: HTTP_PORT,
                path: '/health',
                method: 'GET',
                timeout: 1000
            }, (res) => {
                if (res.statusCode === 200) {
                    resolve();
                } else if (attempts < maxAttempts) {
                    setTimeout(checkHealth, interval);
                } else {
                    reject(new Error('Server health check failed'));
                }
            });

            req.on('error', () => {
                if (attempts < maxAttempts) {
                    setTimeout(checkHealth, interval);
                } else {
                    reject(new Error('Server failed to start - connection refused'));
                }
            });

            req.on('timeout', () => {
                req.destroy();
                if (attempts < maxAttempts) {
                    setTimeout(checkHealth, interval);
                } else {
                    reject(new Error('Server failed to start - timeout'));
                }
            });

            req.end();
        };

        // Start checking after a brief delay for server to initialize
        setTimeout(checkHealth, 500);
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

// Validate video files exist and return list of missing files
function validateVideoFiles(config) {
    const missing = [];

    if (config.defaultVideo && !fs.existsSync(config.defaultVideo)) {
        missing.push({ slot: 'default', path: config.defaultVideo });
    }

    if (config.videos) {
        for (const [key, videoPath] of Object.entries(config.videos)) {
            if (videoPath && !fs.existsSync(videoPath)) {
                const slotNum = key.replace('video', '');
                missing.push({ slot: slotNum, path: videoPath });
            }
        }
    }

    return missing;
}

// Load video config with validation
function loadVideoConfigWithValidation() {
    const config = loadVideoConfig();
    const missingFiles = validateVideoFiles(config);
    return { config, missingFiles };
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
async function startServer() {
    // Check if ports are available first
    const unavailablePorts = await checkRequiredPorts();
    if (unavailablePorts.length > 0) {
        const portList = unavailablePorts.map(p => `${p.name} (port ${p.port})`).join(', ');
        throw new Error(`Ports already in use: ${portList}. Please close any other instances or applications using these ports.`);
    }

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

        let serverError = null;

        serverProcess.stdout.on('data', (data) => {
            console.log(`Server: ${data}`);
        });

        serverProcess.stderr.on('data', (data) => {
            console.error(`Server error: ${data}`);
            serverError = data.toString();
        });

        serverProcess.on('error', (err) => {
            console.error('Failed to start server:', err);
            reject(err);
        });

        serverProcess.on('exit', (code) => {
            console.log(`Server exited with code ${code}`);
            if (code !== 0 && code !== null) {
                reject(new Error(`Server exited unexpectedly with code ${code}: ${serverError || 'Unknown error'}`));
            }
        });

        // Use health check polling instead of timeout fallback
        waitForServerReady()
            .then(resolve)
            .catch((err) => {
                // Kill the server process if it failed to become ready
                if (serverProcess) {
                    serverProcess.kill();
                    serverProcess = null;
                }
                reject(err);
            });
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
ipcMain.handle('get-video-config-validated', () => loadVideoConfigWithValidation());
ipcMain.handle('save-video-config', (event, config) => saveVideoConfig(config));
ipcMain.handle('validate-video-files', (event, config) => validateVideoFiles(config));
ipcMain.handle('get-videos-path', () => videosPath);
ipcMain.handle('get-cache-path', () => cachePath);
ipcMain.handle('check-ports', async () => {
    const unavailable = await checkRequiredPorts();
    return { available: unavailable.length === 0, unavailable };
});

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

ipcMain.handle('get-flic-availability', () => {
    // Check if FlicManager module loaded
    if (!FlicManager) {
        return {
            available: false,
            reason: 'FlicManager module failed to load',
            details: 'Check that all dependencies are installed correctly.'
        };
    }

    // Check if fliclibNodeJs.js exists
    const fliclibPath = app.isPackaged
        ? path.join(process.resourcesPath, 'flic', 'fliclibNodeJs.js')
        : path.join(__dirname, 'flic', 'fliclibNodeJs.js');

    if (!fs.existsSync(fliclibPath)) {
        return {
            available: false,
            reason: 'Flic client library not found',
            details: 'Download fliclibNodeJs.js from: https://github.com/50ButtonsEach/fliclib-linux-hci/tree/master/clientlib/nodejs',
            missingFile: 'fliclibNodeJs.js'
        };
    }

    // Check if daemon binary exists
    const platform = process.platform;
    let daemonName, daemonPath, downloadUrl;

    if (platform === 'win32') {
        daemonName = 'FlicSDK.exe';
        downloadUrl = 'https://github.com/50ButtonsEach/fliclib-windows/releases';
    } else {
        daemonName = 'flicd';
        downloadUrl = 'https://github.com/50ButtonsEach/fliclib-linux-hci';
    }

    daemonPath = app.isPackaged
        ? path.join(process.resourcesPath, 'flic', daemonName)
        : path.join(__dirname, 'flic', daemonName);

    if (!fs.existsSync(daemonPath)) {
        return {
            available: false,
            reason: `Flic daemon not found: ${daemonName}`,
            details: `Download from: ${downloadUrl}`,
            missingFile: daemonName
        };
    }

    return { available: true };
});

// Player control handlers
ipcMain.handle('launch-player', async () => {
    try {
        await startServer();
        createPlayerWindow();
        return { success: true };
    } catch (err) {
        console.error('Error launching player:', err);
        return { success: false, error: err.message };
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
