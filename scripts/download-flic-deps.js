#!/usr/bin/env node

/**
 * Download Flic SDK dependencies for bundling
 * Run with: node scripts/download-flic-deps.js
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const FLIC_DIR = path.join(__dirname, '..', 'flic');

// Dependency URLs
const DEPS = {
    fliclibNodeJs: {
        url: 'https://raw.githubusercontent.com/50ButtonsEach/fliclib-linux-hci/master/clientlib/nodejs/fliclibNodeJs.js',
        filename: 'fliclibNodeJs.js',
        platform: 'all'
    },
    flicSDKWindows: {
        // Note: FlicSDK.exe needs to be downloaded from GitHub releases manually
        // as it's a binary in a zip file
        url: null,
        filename: 'FlicSDK.exe',
        platform: 'win32',
        manual: true,
        instructions: `
Download FlicSDK.exe manually:
1. Go to https://github.com/50ButtonsEach/fliclib-windows/releases
2. Download the latest FlicSDK.zip
3. Extract FlicSDK.exe to flic/FlicSDK.exe
`
    },
    flicd: {
        // flicd needs to be compiled from source for macOS/Linux
        url: null,
        filename: 'flicd',
        platform: 'unix',
        manual: true,
        instructions: `
For macOS/Linux, flicd must be compiled from source:
1. git clone https://github.com/50ButtonsEach/fliclib-linux-hci.git
2. cd fliclib-linux-hci
3. make  (requires build tools: gcc, make, libbluetooth-dev on Linux)
4. Copy bin/flicd to flic/flicd
`
    }
};

// Ensure flic directory exists
if (!fs.existsSync(FLIC_DIR)) {
    fs.mkdirSync(FLIC_DIR, { recursive: true });
}

// Download a file
function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        console.log(`Downloading: ${url}`);

        const file = fs.createWriteStream(dest);

        https.get(url, (response) => {
            // Handle redirects
            if (response.statusCode === 301 || response.statusCode === 302) {
                file.close();
                fs.unlinkSync(dest);
                downloadFile(response.headers.location, dest)
                    .then(resolve)
                    .catch(reject);
                return;
            }

            if (response.statusCode !== 200) {
                file.close();
                fs.unlinkSync(dest);
                reject(new Error(`Failed to download: HTTP ${response.statusCode}`));
                return;
            }

            response.pipe(file);

            file.on('finish', () => {
                file.close();
                console.log(`  ✓ Saved to: ${dest}`);
                resolve();
            });
        }).on('error', (err) => {
            file.close();
            fs.unlinkSync(dest);
            reject(err);
        });
    });
}

// Check if file exists
function fileExists(filename) {
    return fs.existsSync(path.join(FLIC_DIR, filename));
}

async function main() {
    console.log('=== Flic SDK Dependency Downloader ===\n');

    const platform = process.platform;
    const results = { downloaded: [], skipped: [], manual: [] };

    for (const [name, dep] of Object.entries(DEPS)) {
        const destPath = path.join(FLIC_DIR, dep.filename);

        // Check platform
        if (dep.platform !== 'all') {
            if (dep.platform === 'win32' && platform !== 'win32') {
                console.log(`⊘ ${dep.filename} - Windows only (current: ${platform})`);
                continue;
            }
            if (dep.platform === 'unix' && platform === 'win32') {
                console.log(`⊘ ${dep.filename} - Unix only (current: ${platform})`);
                continue;
            }
        }

        // Check if already exists
        if (fileExists(dep.filename)) {
            console.log(`✓ ${dep.filename} - Already exists`);
            results.skipped.push(dep.filename);
            continue;
        }

        // Handle manual downloads
        if (dep.manual) {
            console.log(`⚠ ${dep.filename} - Manual download required`);
            console.log(dep.instructions);
            results.manual.push(dep.filename);
            continue;
        }

        // Download
        try {
            await downloadFile(dep.url, destPath);
            results.downloaded.push(dep.filename);
        } catch (err) {
            console.error(`✗ Failed to download ${dep.filename}: ${err.message}`);
        }
    }

    // Summary
    console.log('\n=== Summary ===');
    if (results.downloaded.length > 0) {
        console.log(`Downloaded: ${results.downloaded.join(', ')}`);
    }
    if (results.skipped.length > 0) {
        console.log(`Already present: ${results.skipped.join(', ')}`);
    }
    if (results.manual.length > 0) {
        console.log(`\n⚠ Manual action required for: ${results.manual.join(', ')}`);
        console.log('See instructions above.');
    }

    // Check what's ready for bundling
    console.log('\n=== Bundle Readiness ===');
    const ready = {
        fliclibNodeJs: fileExists('fliclibNodeJs.js'),
        flicSDK: fileExists('FlicSDK.exe'),
        flicd: fileExists('flicd')
    };

    console.log(`fliclibNodeJs.js: ${ready.fliclibNodeJs ? '✓ Ready' : '✗ Missing'}`);
    console.log(`FlicSDK.exe (Windows): ${ready.flicSDK ? '✓ Ready' : '✗ Missing'}`);
    console.log(`flicd (macOS/Linux): ${ready.flicd ? '✓ Ready' : '✗ Missing'}`);

    if (ready.fliclibNodeJs && ready.flicSDK) {
        console.log('\n✓ Ready to build for Windows: npm run build:win');
    }
    if (ready.fliclibNodeJs && ready.flicd) {
        console.log('✓ Ready to build for macOS: npm run build:mac');
        console.log('✓ Ready to build for Linux: npm run build:linux');
    }
}

main().catch(console.error);
