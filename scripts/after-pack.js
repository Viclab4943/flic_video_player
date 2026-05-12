/**
 * After-pack hook for electron-builder
 * Ensures flicd has executable permissions on macOS/Linux
 */

const fs = require('fs');
const path = require('path');

exports.default = async function(context) {
    const platform = context.electronPlatformName;

    // Only needed for macOS and Linux
    if (platform === 'win32') {
        return;
    }

    const resourcesPath = path.join(context.appOutDir,
        platform === 'darwin'
            ? `${context.packager.appInfo.productFilename}.app/Contents/Resources`
            : 'resources'
    );

    const flicdPath = path.join(resourcesPath, 'flic', 'flicd');

    if (fs.existsSync(flicdPath)) {
        console.log(`Setting executable permission on: ${flicdPath}`);
        fs.chmodSync(flicdPath, 0o755);
        console.log('✓ flicd is now executable');
    } else {
        console.warn(`⚠ flicd not found at: ${flicdPath}`);
    }
};
