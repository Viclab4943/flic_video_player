/**
 * Video Player Server
 * Express HTTP API + WebSocket server for video control
 * Can run standalone or be imported as a module
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const HTTP_PORT = 5555;
const WS_PORT = 8765;

let app = null;
let server = null;
let wsServer = null;
let clients = new Set();
let config = {
    videosPath: '',
    cachePath: '',
    videoConfigPath: ''
};

// Load video configuration
function loadVideoConfig() {
    try {
        if (fs.existsSync(config.videoConfigPath)) {
            return JSON.parse(fs.readFileSync(config.videoConfigPath, 'utf8'));
        }
    } catch (err) {
        console.error('Error loading video config:', err);
    }
    return { defaultVideo: '', videos: {} };
}

// Get video path for a video number
function getVideoPath(videoNumber) {
    const videoConfig = loadVideoConfig();

    if (videoNumber === 0 || videoNumber === 'default') {
        return videoConfig.defaultVideo || null;
    }

    const videoKey = `video${videoNumber}`;
    return videoConfig.videos[videoKey] || null;
}

// Broadcast message to all WebSocket clients
function broadcast(message) {
    const data = JSON.stringify(message);
    clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(data);
        }
    });
}

// Setup Express routes
function setupRoutes() {
    app.use(express.json());

    // Health check
    app.get('/health', (req, res) => {
        res.json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            wsClients: clients.size
        });
    });

    // Change video
    app.post('/changeVideo', (req, res) => {
        const { video, click_type } = req.body;

        if (video === undefined) {
            return res.status(400).json({ error: 'Missing video parameter' });
        }

        const videoPath = getVideoPath(video);

        if (!videoPath) {
            console.log(`No video configured for slot ${video}`);
            return res.status(404).json({ error: `No video configured for slot ${video}` });
        }

        // Check if file exists
        if (!fs.existsSync(videoPath)) {
            console.log(`Video file not found: ${videoPath}`);
            return res.status(404).json({ error: 'Video file not found' });
        }

        console.log(`Playing video ${video}: ${videoPath} (${click_type})`);

        // Broadcast to all WebSocket clients
        broadcast({
            type: 'changeVideo',
            video: video,
            videoPath: videoPath,
            clickType: click_type || 'click',
            muted: click_type === 'double_click'
        });

        res.json({ success: true, video, videoPath });
    });

    // Return to default video
    app.post('/close', (req, res) => {
        const videoPath = getVideoPath(0);

        console.log('Returning to default video');

        broadcast({
            type: 'returnToDefault',
            videoPath: videoPath
        });

        res.json({ success: true });
    });

    // Pause/Resume video
    app.post('/pause', (req, res) => {
        console.log('Toggle pause');

        broadcast({
            type: 'togglePause'
        });

        res.json({ success: true });
    });

    // Get current configuration
    app.get('/config', (req, res) => {
        const videoConfig = loadVideoConfig();
        res.json(videoConfig);
    });

    // List available videos
    app.get('/videos', (req, res) => {
        try {
            if (!fs.existsSync(config.videosPath)) {
                return res.json({ videos: [] });
            }

            const files = fs.readdirSync(config.videosPath)
                .filter(file => {
                    const ext = path.extname(file).toLowerCase();
                    return ['.mp4', '.webm', '.mov', '.avi', '.mkv'].includes(ext);
                })
                .map(file => ({
                    name: file,
                    path: path.join(config.videosPath, file)
                }));

            res.json({ videos: files });
        } catch (err) {
            console.error('Error listing videos:', err);
            res.status(500).json({ error: 'Failed to list videos' });
        }
    });

    // Serve video files statically
    if (config.videosPath) {
        app.use('/video-files', express.static(config.videosPath));
    }
    if (config.cachePath) {
        app.use('/cache-files', express.static(config.cachePath));
    }
}

// Start the server
function start(options = {}) {
    return new Promise((resolve, reject) => {
        // Store config
        config.videosPath = options.videosPath || path.join(__dirname, 'videos');
        config.cachePath = options.cachePath || path.join(__dirname, 'cache');
        config.videoConfigPath = options.videoConfigPath || path.join(__dirname, 'video-config.json');

        // Create Express app
        app = express();
        setupRoutes();

        // Create HTTP server
        server = http.createServer(app);

        // Create WebSocket server
        wsServer = new WebSocket.Server({ port: WS_PORT });

        wsServer.on('connection', (ws) => {
            console.log('WebSocket client connected');
            clients.add(ws);

            ws.on('close', () => {
                console.log('WebSocket client disconnected');
                clients.delete(ws);
            });

            ws.on('error', (err) => {
                console.error('WebSocket error:', err);
                clients.delete(ws);
            });
        });

        wsServer.on('error', (err) => {
            console.error('WebSocket server error:', err);
            reject(err);
        });

        // Start HTTP server
        server.on('error', (err) => {
            console.error('HTTP server error:', err);
            reject(err);
        });

        server.listen(HTTP_PORT, '127.0.0.1', () => {
            console.log(`Server running on http://127.0.0.1:${HTTP_PORT}`);
            console.log(`WebSocket server running on ws://127.0.0.1:${WS_PORT}`);
            resolve();
        });
    });
}

// Stop the server
function stop() {
    return new Promise((resolve) => {
        console.log('Shutting down server...');

        // Close all WebSocket connections
        clients.forEach((client) => {
            client.close();
        });
        clients.clear();

        // Close WebSocket server
        if (wsServer) {
            wsServer.close(() => {
                console.log('WebSocket server closed');
            });
            wsServer = null;
        }

        // Close HTTP server
        if (server) {
            server.close(() => {
                console.log('HTTP server closed');
                resolve();
            });
            server = null;
        } else {
            resolve();
        }

        app = null;
    });
}

// Check if server is running
function isRunning() {
    return server !== null && server.listening;
}

// Export for use as module
module.exports = { start, stop, isRunning, HTTP_PORT, WS_PORT };

// Run standalone if executed directly
if (require.main === module) {
    const VIDEOS_PATH = process.env.VIDEOS_PATH || path.join(__dirname, 'videos');
    const CACHE_PATH = process.env.CACHE_PATH || path.join(__dirname, 'cache');
    const VIDEO_CONFIG_PATH = process.env.VIDEO_CONFIG_PATH || path.join(__dirname, 'video-config.json');

    start({
        videosPath: VIDEOS_PATH,
        cachePath: CACHE_PATH,
        videoConfigPath: VIDEO_CONFIG_PATH
    }).then(() => {
        console.log('Server started successfully');
    }).catch((err) => {
        console.error('Failed to start server:', err);
        process.exit(1);
    });

    // Graceful shutdown
    process.on('SIGTERM', () => stop().then(() => process.exit(0)));
    process.on('SIGINT', () => stop().then(() => process.exit(0)));
}
