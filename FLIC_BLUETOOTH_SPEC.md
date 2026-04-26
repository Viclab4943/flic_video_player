# Flic Bluetooth Direct Connection Specification

This document describes an alternative approach to connect Flic buttons to a Windows application **without using the Flic Hub** and **without network dependencies**. Instead, buttons connect directly to the PC via a USB Bluetooth adapter.

This spec is designed to integrate with **VideoPlayerApp** - an Electron-based fullscreen video player.

---

## Table of Contents

1. [Current VideoPlayerApp Architecture](#current-videoplayerapp-architecture)
2. [Target Architecture with Bluetooth](#target-architecture-with-bluetooth)
3. [Components](#components)
4. [Performance Comparison](#performance-comparison)
5. [FlicSDK Daemon](#flicsdk-daemon)
6. [Node.js Client Library](#nodejs-client-library)
7. [Button Discovery & Pairing](#button-discovery--pairing)
8. [Listening to Button Events](#listening-to-button-events)
9. [Integration with Electron](#integration-with-electron)
10. [Implementation Checklist](#implementation-checklist)
11. [Resources & Links](#resources--links)

---

## Current VideoPlayerApp Architecture

### Overview

VideoPlayerApp is an Electron desktop application that plays fullscreen videos triggered by external inputs.

```
┌─────────────────────────────────────────────────────────────┐
│              LAUNCHER WINDOW (launcher.html)                │
├─────────────────────────────────────────────────────────────┤
│ • Configure video slots (default, video1-15)                │
│ • Flic Hub settings (IP, credentials, auto-sync)            │
│ • Launch player button                                      │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼ starts server + opens player
┌─────────────────────────────────────────────────────────────┐
│              SERVER (server.js - child process)             │
├─────────────────────────────────────────────────────────────┤
│ • Express HTTP API on port 5555                             │
│ • WebSocket server on port 8765                             │
│ • FFmpeg video conversion & caching                         │
│ • Endpoints:                                                │
│   - POST /changeVideo {video: 1-15, click_type: "click"}    │
│   - POST /close (return to default)                         │
│   - POST /pause                                             │
│   - GET /health                                             │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼ WebSocket messages
┌─────────────────────────────────────────────────────────────┐
│              PLAYER WINDOW (player.html)                    │
├─────────────────────────────────────────────────────────────┤
│ • Fullscreen kiosk mode                                     │
│ • Two video elements for crossfade transitions              │
│ • Default video loops muted when idle                       │
│ • Action videos play with/without sound based on click_type │
│ • Keyboard shortcuts: 1-5 for videos, 0 for default         │
└─────────────────────────────────────────────────────────────┘
```

### Key Files

| File | Purpose |
|------|---------|
| `launcher.js` | Electron main process - window management, IPC, server spawning |
| `launcher.html` | Configuration UI - video slots, Flic Hub settings |
| `server.js` | Express API + WebSocket server (runs as child process) |
| `player.html` | Fullscreen video player with WebSocket client |
| `preload.js` | IPC bridge for secure renderer communication |

### Video Triggering Flow (Current - Flic Hub)

```
[Flic Button]
    → [Flic Hub] (WiFi/Network)
    → HTTP POST to localhost:5555/changeVideo
    → [server.js] broadcasts via WebSocket
    → [player.html] plays the video
```

### Video Behavior

| Trigger | Behavior |
|---------|----------|
| Single click (`click_type: "click"`) | Play video WITH sound |
| Double click (`click_type: "double_click"`) | Play video MUTED |
| Hold / API `/close` | Return to default video (loops muted) |

### Configuration Storage

| Config | Location |
|--------|----------|
| Video slot mappings | `~/Library/Application Support/videoplayer/video-config.json` (or Windows equivalent) |
| Flic Hub settings | `~/Library/Application Support/videoplayer/flic-config.json` |
| Cached videos | `~/Documents/VideoPlayer/cache/` |
| Source videos | `~/Documents/VideoPlayer/videos/` |

---

## Target Architecture with Bluetooth

### Changes from Current Architecture

The Bluetooth approach **replaces the Flic Hub network communication** with direct Bluetooth connection. The rest of the app (server, player, video handling) stays the same.

```
┌─────────────────────────────────────────────────────────────┐
│              LAUNCHER WINDOW (launcher.html)                │
├─────────────────────────────────────────────────────────────┤
│ • Configure video slots (default, video1-15)                │
│ • NEW: Flic Bluetooth settings (pair/remove buttons)        │
│ • NEW: Button-to-video mapping UI                           │
│ • Launch player button                                      │
└─────────────────────────────────────────────────────────────┘
                            │
            ┌───────────────┴───────────────┐
            ▼                               ▼
┌───────────────────────┐       ┌───────────────────────────┐
│  FlicSDK.exe daemon   │       │  SERVER (server.js)       │
│  (Bluetooth handler)  │       │  (same as before)         │
│  Port 5551 TCP        │       │  Port 5555 HTTP           │
└───────────┬───────────┘       └───────────────────────────┘
            │                               ▲
            │ button events                 │ HTTP POST /changeVideo
            ▼                               │
┌───────────────────────────────────────────┴───────────────┐
│              ELECTRON MAIN PROCESS (launcher.js)           │
├────────────────────────────────────────────────────────────┤
│ • Connects to FlicSDK.exe via Node.js client               │
│ • Listens for button events                                │
│ • Translates button press → HTTP request to server         │
│ • Manages button pairing via scan wizard                   │
└────────────────────────────────────────────────────────────┘
                            │
                            ▼ WebSocket
┌─────────────────────────────────────────────────────────────┐
│              PLAYER WINDOW (player.html - unchanged)        │
└─────────────────────────────────────────────────────────────┘
```

### Video Triggering Flow (New - Bluetooth)

```
[Flic Button]
    → [USB Bluetooth Adapter]
    → [FlicSDK.exe daemon]
    → [launcher.js via Node.js client]
    → HTTP POST to localhost:5555/changeVideo
    → [server.js] broadcasts via WebSocket
    → [player.html] plays the video
```

### What Stays the Same

- `server.js` - No changes needed
- `player.html` - No changes needed
- Video caching/conversion - No changes needed
- API endpoints - No changes needed

### What Changes

| Component | Changes |
|-----------|---------|
| `launcher.js` | Add FlicSDK daemon management, Node.js client connection, button event handling |
| `launcher.html` | Replace Flic Hub settings with Bluetooth pairing UI |
| `preload.js` | Add IPC handlers for button pairing, listing, removal |
| New: `flic/` folder | FlicSDK.exe, fliclibNodeJs.js, flicManager.js |

---

---

## Components

| Component | Description | Source |
|-----------|-------------|--------|
| **FlicSDK.exe** | Windows daemon that handles Bluetooth communication | [fliclib-windows](https://github.com/50ButtonsEach/fliclib-windows) |
| **Node.js Client** | Client library to communicate with the daemon | [fliclib-linux-hci/clientlib/nodejs](https://github.com/50ButtonsEach/fliclib-linux-hci/tree/master/clientlib/nodejs) |
| **USB Bluetooth Adapter** | Any BLE-capable Bluetooth adapter | Built-in or USB dongle |

---

## Performance Comparison

### vs Flic Hub (Network Approach)

| Aspect | Flic Hub (Network) | USB Bluetooth (Direct) |
|--------|-------------------|------------------------|
| **Range** | ~50m (Hub to button) + unlimited (Hub to PC) | ~10-30m (depends on adapter) |
| **Latency** | ~50-150ms | ~20-50ms |
| **Network Required** | Yes (WiFi/Ethernet) | No |
| **Firewall Rules** | Yes (ports 5555, 9999) | No |
| **IT Approval** | Often required | Usually not needed |
| **Extra Hardware** | Flic Hub LR (~$100) | USB Bluetooth dongle (~$15) |
| **Button Pairing** | Via Flic phone app | Via your app or simpleclient |
| **Setup Complexity** | Lower | Higher |
| **Hub Placement** | Can optimize for range | Limited to PC location |

### Latency Breakdown

**Flic Hub (Network):**
```
Button → Hub (BLE: ~20ms) → Network (WiFi: ~10-50ms) → PC → App
Total: ~50-150ms
```

**USB Bluetooth (Direct):**
```
Button → USB Adapter (BLE: ~20ms) → Daemon → App
Total: ~20-50ms
```

---

## FlicSDK Daemon

### Requirements

- Windows 10/11 (x86_64 only, no ARM/IoT)
- Bluetooth Low Energy hardware (built-in or USB dongle)
- Visual Studio 2017 C++ Redistributable

### Download

Download `FlicSDK.exe` from: https://github.com/50ButtonsEach/fliclib-windows/releases

### Running the Daemon

```bash
# Local-only access (recommended for single-app use)
.\FlicSDK.exe 127.0.0.1 5551

# Network access (if other machines need to connect)
.\FlicSDK.exe 0.0.0.0 5551
```

### Data Storage

Paired buttons are stored in Windows Registry:
```
HKEY_CURRENT_USER\Software\Shortcut Labs\Flicd
```

### Supported Buttons

- Flic 1 (original)
- Flic 2
- **NOT supported:** Flic Twist

---

## Node.js Client Library

### Files Required

From [fliclib-linux-hci/clientlib/nodejs](https://github.com/50ButtonsEach/fliclib-linux-hci/tree/master/clientlib/nodejs):

```
fliclibNodeJs.js    # Main client library
```

### Basic Connection

```javascript
const fliclib = require('./fliclibNodeJs');

// Connect to the daemon
const client = new fliclib.FlicClient("localhost", 5551);

client.on("ready", () => {
    console.log("Connected to Flic daemon");

    // Get info about connected buttons
    client.getInfo((info) => {
        console.log("Bluetooth controller:", info.bluetoothControllerState);
        console.log("Paired buttons:", info.bdAddrOfVerifiedButtons);
    });
});

client.on("error", (error) => {
    console.error("Connection error:", error);
});

client.on("close", (hadError) => {
    console.log("Disconnected from daemon");
});
```

---

## Button Discovery & Pairing

### Scan Wizard

The scan wizard discovers nearby Flic buttons and pairs them:

```javascript
const fliclib = require('./fliclibNodeJs');
const client = new fliclib.FlicClient("localhost", 5551);

client.on("ready", () => {
    console.log("Starting button scan...");
    console.log("Press and hold your Flic button to pair");

    const wizard = new fliclib.FlicScanWizard();

    wizard.on("foundPrivateButton", () => {
        // Button is paired to another device
        console.log("Found private button - hold for 7 seconds to make public");
    });

    wizard.on("foundPublicButton", (bdAddr, name) => {
        console.log(`Found button: ${name} (${bdAddr})`);
        console.log("Pairing...");
    });

    wizard.on("buttonConnected", (bdAddr, name) => {
        console.log(`Connected: ${name} (${bdAddr})`);
    });

    wizard.on("completed", (result, bdAddr, name) => {
        if (result === "WizardSuccess") {
            console.log(`Successfully paired: ${name} (${bdAddr})`);
            // Button is now remembered by the daemon
        } else {
            console.log(`Pairing failed: ${result}`);
        }

        // Remove wizard when done
        client.removeScanWizard(wizard);
    });

    client.addScanWizard(wizard);
});
```

### Pairing Notes

- **Private buttons:** If a button is paired to a phone/hub, hold it for 7 seconds to make it public
- **Verification:** Once paired, the button is "verified" and stored in the daemon's registry
- **Auto-reconnect:** The daemon will automatically reconnect to verified buttons

---

## Listening to Button Events

### Listen to All Paired Buttons

```javascript
const fliclib = require('./fliclibNodeJs');
const client = new fliclib.FlicClient("localhost", 5551);

function listenToButton(bdAddr) {
    const channel = new fliclib.FlicConnectionChannel(bdAddr);

    channel.on("buttonUpOrDown", (clickType, wasQueued, timeDiff) => {
        console.log(`Button ${bdAddr}: ${clickType}`);
        // clickType: "ButtonUp" or "ButtonDown"
    });

    channel.on("buttonSingleOrDoubleClickOrHold", (clickType, wasQueued, timeDiff) => {
        console.log(`Button ${bdAddr}: ${clickType}`);
        // clickType: "ButtonSingleClick", "ButtonDoubleClick", or "ButtonHold"

        switch (clickType) {
            case "ButtonSingleClick":
                // Handle single click
                break;
            case "ButtonDoubleClick":
                // Handle double click
                break;
            case "ButtonHold":
                // Handle hold
                break;
        }
    });

    channel.on("connectionStatusChanged", (status, disconnectReason) => {
        console.log(`Button ${bdAddr} status: ${status}`);
        // status: "Disconnected", "Connected", "Ready"
    });

    client.addConnectionChannel(channel);
}

client.on("ready", () => {
    // Listen to all previously paired buttons
    client.getInfo((info) => {
        info.bdAddrOfVerifiedButtons.forEach((bdAddr) => {
            console.log(`Reconnecting to: ${bdAddr}`);
            listenToButton(bdAddr);
        });
    });
});

// Listen for newly paired buttons
client.on("newVerifiedButton", (bdAddr) => {
    console.log(`New button paired: ${bdAddr}`);
    listenToButton(bdAddr);
});
```

### Click Types

| Event | Values |
|-------|--------|
| `buttonUpOrDown` | `ButtonUp`, `ButtonDown` |
| `buttonSingleOrDoubleClickOrHold` | `ButtonSingleClick`, `ButtonDoubleClick`, `ButtonHold` |
| `buttonSingleOrDoubleClick` | `ButtonSingleClick`, `ButtonDoubleClick` |
| `buttonClickOrHold` | `ButtonClick`, `ButtonHold` |

---

## Button Event to Video Mapping

### How Button Presses Trigger Videos

When a button is pressed, the flow is:

1. **FlicSDK.exe** detects the Bluetooth event
2. **Node.js client** receives the event in `launcher.js`
3. **launcher.js** looks up the button-to-video mapping
4. **launcher.js** sends HTTP POST to the local server (same as Flic Hub did)
5. **server.js** broadcasts via WebSocket
6. **player.html** plays the video

### Button Mapping Config

Store button-to-video mappings in `flic-bluetooth-config.json`:

```json
{
  "buttons": {
    "80:E4:DA:AA:BB:CC": {
      "name": "Button 1",
      "videoNumber": 1
    },
    "80:E4:DA:DD:EE:FF": {
      "name": "Button 2",
      "videoNumber": 2
    }
  }
}
```

### Event Handler Code

```javascript
// In launcher.js - handling button events

const http = require('http');

// Load button mappings
function loadButtonMappings() {
    const configPath = path.join(app.getPath('userData'), 'flic-bluetooth-config.json');
    try {
        if (fs.existsSync(configPath)) {
            return JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
    } catch (err) {
        console.error('Error loading button mappings:', err);
    }
    return { buttons: {} };
}

// Send video change request to local server
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

// Handle button events from Flic client
function handleButtonEvent(bdAddr, clickType) {
    const config = loadButtonMappings();
    const button = config.buttons[bdAddr];

    if (!button) {
        console.log(`Unknown button: ${bdAddr}`);
        return;
    }

    const videoNumber = button.videoNumber;

    switch (clickType) {
        case "ButtonSingleClick":
            console.log(`Button ${bdAddr} → Video ${videoNumber} (with sound)`);
            triggerVideo(videoNumber, "click");
            break;

        case "ButtonDoubleClick":
            console.log(`Button ${bdAddr} → Video ${videoNumber} (muted)`);
            triggerVideo(videoNumber, "double_click");
            break;

        case "ButtonHold":
            console.log(`Button ${bdAddr} → Return to default`);
            returnToDefault();
            break;
    }
}

// Set up listener for each button
function listenToButton(bdAddr) {
    const channel = new fliclib.FlicConnectionChannel(bdAddr);

    channel.on("buttonSingleOrDoubleClickOrHold", (clickType, wasQueued, timeDiff) => {
        handleButtonEvent(bdAddr, clickType);
    });

    channel.on("connectionStatusChanged", (status, disconnectReason) => {
        // Notify renderer of connection status change
        if (launcherWindow) {
            launcherWindow.webContents.send('button-status-changed', {
                bdAddr,
                status
            });
        }
    });

    flicClient.addConnectionChannel(channel);
}
```

---

## Launcher UI Changes

### Current Flic Hub Settings (to be replaced)

```
┌─────────────────────────────────┐
│ FLIC HUB                        │
├─────────────────────────────────┤
│ Hub IP Address                  │
│ [192.168.1.x          ]         │
│                                 │
│ SDK Username                    │
│ [Optional             ]         │
│                                 │
│ SDK Password                    │
│ [••••••••             ]         │
│                                 │
│ [x] Auto-sync IP on launch      │
│                                 │
│ [Test]  [Save]                  │
└─────────────────────────────────┘
```

### New Bluetooth Settings

```
┌─────────────────────────────────┐
│ FLIC BUTTONS (Bluetooth)        │
├─────────────────────────────────┤
│ Status: ● Ready (3 buttons)     │
│                                 │
│ ┌─────────────────────────────┐ │
│ │ ● Button 1     [Video 1 ▼] │ │
│ │   80:E4:DA:AA:BB:CC    [x] │ │
│ ├─────────────────────────────┤ │
│ │ ● Button 2     [Video 2 ▼] │ │
│ │   80:E4:DA:DD:EE:FF    [x] │ │
│ ├─────────────────────────────┤ │
│ │ ○ Button 3     [Video 3 ▼] │ │
│ │   80:E4:DA:11:22:33    [x] │ │
│ │   (disconnected)           │ │
│ └─────────────────────────────┘ │
│                                 │
│ [+ Pair New Button]             │
└─────────────────────────────────┘
```

### Pairing Mode UI

```
┌─────────────────────────────────┐
│ PAIRING NEW BUTTON              │
├─────────────────────────────────┤
│                                 │
│   🔍 Scanning for buttons...    │
│                                 │
│   Press and hold your Flic      │
│   button until it connects.     │
│                                 │
│   If previously paired to       │
│   another device, hold for      │
│   7 seconds to reset.           │
│                                 │
│ [Cancel]                        │
└─────────────────────────────────┘
```

---

## Integration with Electron

### Project Structure

```
your-electron-app/
├── main.js                 # Electron main process
├── flic/
│   ├── fliclibNodeJs.js    # Flic client library
│   ├── flicManager.js      # Your wrapper module
│   └── FlicSDK.exe         # Windows daemon (bundled)
├── renderer/
│   └── ...
└── package.json
```

### Daemon Management

```javascript
// flic/flicManager.js
const { spawn } = require('child_process');
const path = require('path');
const fliclib = require('./fliclibNodeJs');

let daemonProcess = null;
let client = null;

function startDaemon() {
    return new Promise((resolve, reject) => {
        const daemonPath = path.join(__dirname, 'FlicSDK.exe');

        daemonProcess = spawn(daemonPath, ['127.0.0.1', '5551'], {
            stdio: 'ignore',
            detached: false
        });

        daemonProcess.on('error', reject);

        // Wait for daemon to be ready
        setTimeout(() => {
            connectToClient()
                .then(resolve)
                .catch(reject);
        }, 2000);
    });
}

function connectToClient() {
    return new Promise((resolve, reject) => {
        client = new fliclib.FlicClient("localhost", 5551);

        client.on("ready", () => resolve(client));
        client.on("error", reject);
    });
}

function stopDaemon() {
    if (client) {
        client.close();
        client = null;
    }
    if (daemonProcess) {
        daemonProcess.kill();
        daemonProcess = null;
    }
}

module.exports = { startDaemon, stopDaemon, getClient: () => client };
```

### Electron Main Process

```javascript
// main.js
const { app, BrowserWindow } = require('electron');
const flicManager = require('./flic/flicManager');

app.whenReady().then(async () => {
    // Start Flic daemon
    try {
        await flicManager.startDaemon();
        console.log("Flic daemon started");
    } catch (err) {
        console.error("Failed to start Flic daemon:", err);
    }

    // Create window...
});

app.on('before-quit', () => {
    flicManager.stopDaemon();
});
```

### Bundling FlicSDK.exe

In `package.json` (electron-builder):

```json
{
  "build": {
    "extraResources": [
      {
        "from": "flic/FlicSDK.exe",
        "to": "flic/FlicSDK.exe"
      }
    ],
    "win": {
      "target": ["nsis", "portable"]
    }
  }
}
```

Then in your code, resolve the path:

```javascript
const { app } = require('electron');
const path = require('path');

function getDaemonPath() {
    if (app.isPackaged) {
        return path.join(process.resourcesPath, 'flic', 'FlicSDK.exe');
    }
    return path.join(__dirname, 'FlicSDK.exe');
}
```

---

## Implementation Checklist

### Setup

- [ ] Download FlicSDK.exe from GitHub releases
- [ ] Download fliclibNodeJs.js client library
- [ ] Create `flic/` folder in project root
- [ ] Obtain USB Bluetooth adapter (if no built-in Bluetooth)
- [ ] Install Visual Studio 2017 C++ Redistributable on target machine

### Backend (launcher.js)

- [ ] Create `flic/flicManager.js` wrapper module
- [ ] Add daemon lifecycle management (start on app launch, stop on quit)
- [ ] Connect to FlicSDK.exe via Node.js client
- [ ] Implement button event handlers:
  - [ ] Single click → `POST /changeVideo {video: X, click_type: "click"}`
  - [ ] Double click → `POST /changeVideo {video: X, click_type: "double_click"}`
  - [ ] Hold → `POST /close`
- [ ] Add IPC handlers for button management:
  - [ ] `get-paired-buttons` - List all paired buttons
  - [ ] `start-button-pairing` - Start scan wizard
  - [ ] `cancel-button-pairing` - Cancel scan wizard
  - [ ] `remove-button` - Remove a paired button
  - [ ] `set-button-mapping` - Map button address to video number
- [ ] Store button-to-video mappings in config file
- [ ] Add connection retry logic with exponential backoff

### Frontend (launcher.html)

- [ ] Replace Flic Hub settings section with Bluetooth section
- [ ] Add "Pair New Button" button that starts scan wizard
- [ ] Show pairing status/instructions during scan
- [ ] Display list of paired buttons with:
  - [ ] Button name/address
  - [ ] Connection status indicator
  - [ ] Video slot dropdown (1-15)
  - [ ] Remove button
- [ ] Show Bluetooth adapter status
- [ ] Add error messages for common issues

### Preload (preload.js)

- [ ] Add IPC exposures for button management:
  - [ ] `getPairedButtons()`
  - [ ] `startButtonPairing()`
  - [ ] `cancelButtonPairing()`
  - [ ] `removeButton(bdAddr)`
  - [ ] `setButtonMapping(bdAddr, videoNumber)`
  - [ ] `getBluetoothStatus()`

### Packaging (package.json)

- [ ] Add FlicSDK.exe to extraResources:
  ```json
  "extraResources": [
    { "from": "flic/FlicSDK.exe", "to": "flic/FlicSDK.exe" }
  ]
  ```
- [ ] Update asarUnpack if needed
- [ ] Test packaged app on clean Windows machine

### Testing

- [ ] Test daemon startup from packaged path
- [ ] Test button pairing flow end-to-end
- [ ] Test all click types trigger correct videos
- [ ] Test button removal
- [ ] Test button-to-video mapping changes
- [ ] Test auto-reconnect after button goes out of range
- [ ] Test app restart (buttons should reconnect automatically)
- [ ] Test with multiple buttons simultaneously
- [ ] Test range at various distances
- [ ] Test on machine without Bluetooth (graceful error)

---

## Resources & Links

### Official Repositories

| Resource | URL |
|----------|-----|
| Windows Daemon (FlicSDK.exe) | https://github.com/50ButtonsEach/fliclib-windows |
| Client Libraries (incl. Node.js) | https://github.com/50ButtonsEach/fliclib-linux-hci |
| Protocol Documentation | https://github.com/50ButtonsEach/fliclib-linux-hci/blob/master/ProtocolDocumentation.md |

### Downloads

| File | URL |
|------|-----|
| FlicSDK.exe (Windows) | https://github.com/50ButtonsEach/fliclib-windows/releases |
| Node.js Client | https://github.com/50ButtonsEach/fliclib-linux-hci/tree/master/clientlib/nodejs |

### Flic Developer Resources

| Resource | URL |
|----------|-----|
| Flic Developer Portal | https://developers.flic.io/ |
| Flic Hub SDK | https://hubsdk.flic.io/ |

---

## Notes

- This approach eliminates all network dependencies - ideal for restricted IT environments
- The FlicSDK.exe daemon must be running for the app to receive button events
- Buttons paired via this method will NOT work with the Flic phone app simultaneously
- Consider adding a "fallback" to Flic Hub for users who prefer that approach

---

*Document created: 2026-04-23*
*For use with: VideoPlayerApp or similar Electron projects*
