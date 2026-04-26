# Flic Video Player

Fullscreen video player triggered by Flic Bluetooth buttons. Connects directly to Flic buttons via USB Bluetooth adapter - no Flic Hub required.

## Platform Support

| Platform | Daemon | Status |
|----------|--------|--------|
| Windows 10/11 | FlicSDK.exe | Fully supported (pre-built binary) |
| macOS | flicd | Requires compilation |
| Linux | flicd | Requires compilation |

## Requirements

- Node.js 18+
- USB Bluetooth adapter (or built-in Bluetooth)
- **Windows only:** Visual Studio 2017 C++ Redistributable

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Download Flic SDK files

#### Node.js Client (all platforms)

1. Go to: https://github.com/50ButtonsEach/fliclib-linux-hci/blob/master/clientlib/nodejs/fliclibNodeJs.js
2. Click "Raw" to view the raw file
3. Save as `flic/fliclibNodeJs.js` (replacing the placeholder)

#### Platform-specific daemon

**Windows:**
1. Go to: https://github.com/50ButtonsEach/fliclib-windows/releases
2. Download the latest `FlicSDK.exe`
3. Place it in the `flic/` folder

**macOS / Linux:**
1. Clone: https://github.com/50ButtonsEach/fliclib-linux-hci
2. Follow the compilation instructions in that repo
3. Copy the compiled `flicd` binary to the `flic/` folder

##### Compiling flicd for macOS

```bash
# Clone the repo
git clone https://github.com/50ButtonsEach/fliclib-linux-hci.git
cd fliclib-linux-hci

# Install dependencies (macOS)
brew install boost

# Compile
cd flicd/src
make

# Copy to your project
cp flicd /path/to/flic_video_player/flic/
```

**Note:** macOS may require modifications to the Makefile for compatibility with the macOS Bluetooth stack. See the repo's issues for community patches.

### 3. Run the app

```bash
npm start
```

## Usage

### Launcher Window

1. **Configure Videos**: Set a default video (loops when idle) and assign videos to slots 1-15
2. **Pair Buttons**: Click "Pair New Button" and hold your Flic button until it connects
3. **Map Buttons**: Assign each button to a video slot using the dropdown
4. **Launch Player**: Click to open the fullscreen video player

### Button Actions

| Action | Result |
|--------|--------|
| Single click | Play video WITH sound |
| Double click | Play video MUTED |
| Hold | Return to default video |

### Keyboard Shortcuts (in player)

| Key | Action |
|-----|--------|
| 1-9 | Play video 1-9 |
| 0 | Return to default |
| Space | Pause/Resume |
| ESC | Exit player |

## Project Structure

```
flic_video_player/
├── launcher.js      # Electron main process
├── launcher.html    # Configuration UI
├── player.html      # Fullscreen video player
├── server.js        # HTTP API + WebSocket server
├── preload.js       # IPC bridge
├── styles.css       # Launcher styles
├── package.json
└── flic/
    ├── flicManager.js     # Cross-platform daemon manager
    ├── fliclibNodeJs.js   # Flic client library (download)
    ├── FlicSDK.exe        # Windows daemon (download)
    └── flicd              # macOS/Linux daemon (compile)
```

## API Endpoints

The server runs on `http://localhost:5555`:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/changeVideo` | POST | Play a video `{video: 1-15, click_type: "click"\|"double_click"}` |
| `/close` | POST | Return to default video |
| `/pause` | POST | Toggle pause |
| `/health` | GET | Server health check |
| `/config` | GET | Get video configuration |

WebSocket server runs on `ws://localhost:8765`.

## Building for Distribution

```bash
# Windows
npm run build:win

# macOS
npm run build:mac

# Linux
npm run build:linux

# All platforms (requires appropriate OS or cross-compilation setup)
npm run build:all
```

Output will be in the `dist/` folder.

## Troubleshooting

### "FlicSDK.exe not found" (Windows)
Download FlicSDK.exe from the releases page and place it in the `flic/` folder.

### "flicd not found" (macOS/Linux)
You need to compile flicd from source. See the compilation instructions above.

### "fliclibNodeJs.js is a placeholder"
Download the real library from GitHub and replace the placeholder file.

### Button won't pair
- Hold the button for 7 seconds to reset it if previously paired to another device
- Ensure Bluetooth is enabled on your system
- On Linux, you may need to run with `sudo` or configure Bluetooth permissions

### Videos won't play
- Ensure video files exist at the configured paths
- Supported formats: MP4, WebM, MOV, AVI, MKV
- Check browser console for errors (Ctrl+Shift+I / Cmd+Shift+I in player)

### macOS Bluetooth permissions
On macOS, you may need to grant Bluetooth permissions to the app in System Preferences > Security & Privacy > Privacy > Bluetooth.

### Linux Bluetooth permissions
On Linux, ensure your user is in the `bluetooth` group:
```bash
sudo usermod -a -G bluetooth $USER
```
Then log out and back in.
