/**
 * Video Player Server
 * Express HTTP API + WebSocket server for video control
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

// Configuration from environment
const VIDEOS_PATH = process.env.VIDEOS_PATH || path.join(__dirname, 'videos');
const CACHE_PATH = process.env.CACHE_PATH || path.join(__dirname, 'cache');
const VIDEO_CONFIG_PATH = process.env.VIDEO_CONFIG_PATH || path.join(__dirname, 'video-config.json');

const HTTP_PORT = 5555;
const WS_PORT = 8765;

// Express app setup
const app = express();
app.use(express.json());

// WebSocket server setup
const wsServer = new WebSocket.Server({ port: WS_PORT });
const clients = new Set();

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

// Broadcast message to all WebSocket clients
function broadcast(message) {
    const data = JSON.stringify(message);
    clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(data);
        }
    });
}

// Load video configuration
function loadVideoConfig() {
    try {
        if (fs.existsSync(VIDEO_CONFIG_PATH)) {
            return JSON.parse(fs.readFileSync(VIDEO_CONFIG_PATH, 'utf8'));
        }
    } catch (err) {
        console.error('Error loading video config:', err);
    }
    return { defaultVideo: '', videos: {} };
}

// Get video path for a video number
function getVideoPath(videoNumber) {
    const config = loadVideoConfig();

    if (videoNumber === 0 || videoNumber === 'default') {
        return config.defaultVideo || null;
    }

    const videoKey = `video${videoNumber}`;
    return config.videos[videoKey] || null;
}

// API Routes

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
    const config = loadVideoConfig();
    res.json(config);
});

// List available videos
app.get('/videos', (req, res) => {
    try {
        if (!fs.existsSync(VIDEOS_PATH)) {
            return res.json({ videos: [] });
        }

        const files = fs.readdirSync(VIDEOS_PATH)
            .filter(file => {
                const ext = path.extname(file).toLowerCase();
                return ['.mp4', '.webm', '.mov', '.avi', '.mkv'].includes(ext);
            })
            .map(file => ({
                name: file,
                path: path.join(VIDEOS_PATH, file)
            }));

        res.json({ videos: files });
    } catch (err) {
        console.error('Error listing videos:', err);
        res.status(500).json({ error: 'Failed to list videos' });
    }
});

// Serve video files statically
app.use('/video-files', express.static(VIDEOS_PATH));
app.use('/cache-files', express.static(CACHE_PATH));

// Start HTTP server
const server = http.createServer(app);
server.listen(HTTP_PORT, () => {
    console.log(`Server running on http://localhost:${HTTP_PORT}`);
    console.log(`WebSocket server running on ws://localhost:${WS_PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('Shutting down server...');
    wsServer.close();
    server.close();
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('Shutting down server...');
    wsServer.close();
    server.close();
    process.exit(0);
});
