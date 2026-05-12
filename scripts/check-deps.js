#!/usr/bin/env node

/**
 * Pre-build check to verify Flic dependencies are present
 */

const fs = require('fs');
const path = require('path');

const FLIC_DIR = path.join(__dirname, '..', 'flic');
const platform = process.platform;

// Determine target platform from command line args
const args = process.argv.slice(2).join(' ');
let targetPlatform = platform;

if (args.includes('--win') || args.includes('-w')) {
    targetPlatform = 'win32';
} else if (args.includes('--mac') || args.includes('-m')) {
    targetPlatform = 'darwin';
} else if (args.includes('--linux') || args.includes('-l')) {
    targetPlatform = 'linux';
}

console.log('=== Pre-build Dependency Check ===\n');

const errors = [];
const warnings = [];

// Check fliclibNodeJs.js (required for all platforms)
const fliclibPath = path.join(FLIC_DIR, 'fliclibNodeJs.js');
if (!fs.existsSync(fliclibPath)) {
    errors.push({
        file: 'fliclibNodeJs.js',
        message: 'Flic client library not found',
        fix: 'Run: npm run setup\nOr download from: https://github.com/50ButtonsEach/fliclib-linux-hci/tree/master/clientlib/nodejs'
    });
} else {
    console.log('✓ fliclibNodeJs.js');
}

// Check platform-specific daemon
if (targetPlatform === 'win32') {
    const sdkPath = path.join(FLIC_DIR, 'FlicSDK.exe');
    if (!fs.existsSync(sdkPath)) {
        errors.push({
            file: 'FlicSDK.exe',
            message: 'Windows Flic SDK not found',
            fix: 'Download from: https://github.com/50ButtonsEach/fliclib-windows/releases\nExtract FlicSDK.exe to flic/FlicSDK.exe'
        });
    } else {
        console.log('✓ FlicSDK.exe');
    }
} else {
    const flicdPath = path.join(FLIC_DIR, 'flicd');
    if (!fs.existsSync(flicdPath)) {
        errors.push({
            file: 'flicd',
            message: `Flic daemon for ${targetPlatform} not found`,
            fix: `Compile from source:
1. git clone https://github.com/50ButtonsEach/fliclib-linux-hci.git
2. cd fliclib-linux-hci && make
3. cp bin/flicd ${FLIC_DIR}/flicd`
        });
    } else {
        // Check if executable
        try {
            fs.accessSync(flicdPath, fs.constants.X_OK);
            console.log('✓ flicd');
        } catch {
            warnings.push({
                file: 'flicd',
                message: 'flicd exists but is not executable',
                fix: `Run: chmod +x ${flicdPath}`
            });
            console.log('⚠ flicd (not executable)');
        }
    }
}

// Report results
if (warnings.length > 0) {
    console.log('\n⚠ Warnings:');
    warnings.forEach(w => {
        console.log(`  ${w.file}: ${w.message}`);
        console.log(`  Fix: ${w.fix}\n`);
    });
}

if (errors.length > 0) {
    console.log('\n✗ Missing dependencies:');
    errors.forEach(e => {
        console.log(`\n  ${e.file}: ${e.message}`);
        console.log(`  ${e.fix}`);
    });
    console.log('\n');
    process.exit(1);
}

console.log('\n✓ All dependencies present. Ready to build!');
