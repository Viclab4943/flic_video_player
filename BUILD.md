# Building Flic Video Player for Windows

This guide explains how to package the app as a Windows `.exe` installer.

## Prerequisites

### On Windows (recommended)
- Node.js 18+
- npm

### On macOS/Linux (cross-compilation)
- Node.js 18+
- npm
- Wine (for building Windows apps from non-Windows)
  ```bash
  # macOS
  brew install --cask wine-stable
  ```

## Setup

### 1. Install dependencies

```bash
cd flic_video_player
npm install
```

### 2. Ensure required files are in place

Before building, verify these files exist:

```
flic_video_player/
├── flic/
│   ├── FlicSDK.exe        # Download from GitHub
│   └── fliclibNodeJs.js   # Download from GitHub
└── assets/
    └── icon.ico           # Optional: app icon (256x256)
```

**Download FlicSDK.exe:**
https://github.com/50ButtonsEach/fliclib-windows/releases

**Download fliclibNodeJs.js:**
https://github.com/50ButtonsEach/fliclib-linux-hci/blob/master/clientlib/nodejs/fliclibNodeJs.js

### 3. (Optional) Add an app icon

Create or place a `icon.ico` file in the `assets/` folder. The icon should be 256x256 pixels.

You can convert a PNG to ICO online or use ImageMagick:
```bash
magick icon.png -define icon:auto-resize=256,128,64,48,32,16 assets/icon.ico
```

## Building

### Build for Windows

```bash
npm run build:win
```

This creates two outputs in the `dist/` folder:

| File | Description |
|------|-------------|
| `Flic Video Player Setup X.X.X.exe` | NSIS installer (recommended) |
| `Flic Video Player X.X.X.exe` | Portable executable |

### Build options

The `package.json` includes these build scripts:

```bash
npm run build:win    # Windows only
npm run build:mac    # macOS only
npm run build:linux  # Linux only
npm run build:all    # All platforms
```

## Installer Options

The NSIS installer (configured in `package.json`):
- Allows user to choose installation directory
- Creates Start Menu shortcuts
- Creates desktop shortcut (optional)
- Includes uninstaller

## Distribution

### What to distribute

For most users, distribute the **NSIS installer**:
```
dist/Flic Video Player Setup 1.0.0.exe
```

For users who can't install software (restricted PCs), distribute the **portable version**:
```
dist/Flic Video Player 1.0.0.exe
```

### System requirements for end users

- Windows 10 or 11 (64-bit)
- Bluetooth adapter (built-in or USB)
- Visual Studio 2017 C++ Redistributable
  - Usually already installed
  - If not: https://aka.ms/vs/17/release/vc_redist.x64.exe

## Troubleshooting

### "Wine is required to build Windows apps"
Install Wine if building on macOS/Linux:
```bash
brew install --cask wine-stable
```

### Build fails with missing icon
Either add an `assets/icon.ico` file or remove the icon line from `package.json`:
```json
"win": {
  "target": ["nsis", "portable"]
  // Remove: "icon": "assets/icon.ico"
}
```

### FlicSDK.exe not included in build
Ensure `FlicSDK.exe` is in the `flic/` folder before building. The `extraResources` config in `package.json` copies it into the build.

### App works in dev but not in production
Check paths - in production, resources are in a different location:
```javascript
// Dev: __dirname
// Production: process.resourcesPath
```

The `flicManager.js` already handles this with `app.isPackaged`.

## Code Signing (Optional)

For distribution without Windows SmartScreen warnings, you need a code signing certificate:

1. Purchase a code signing certificate from a CA (DigiCert, Sectigo, etc.)
2. Add to `package.json`:
```json
"win": {
  "certificateFile": "path/to/cert.pfx",
  "certificatePassword": "your-password"
}
```

Or use environment variables:
```bash
CSC_LINK=path/to/cert.pfx CSC_KEY_PASSWORD=your-password npm run build:win
```

Without code signing, users will see a SmartScreen warning on first run (they can click "More info" → "Run anyway").

## Updating the Version

Before building a new release, update the version in `package.json`:

```json
{
  "version": "1.0.1"
}
```

The version number appears in:
- Installer filename
- App properties
- About dialogs (if implemented)
