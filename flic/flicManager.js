/**
 * Flic Manager Module
 * Handles FlicSDK daemon lifecycle and button management
 * Supports Windows (FlicSDK.exe) and macOS/Linux (flicd)
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const EventEmitter = require('events');

// Import the Flic client library
let fliclib;
try {
    fliclib = require('./fliclibNodeJs');
} catch (err) {
    console.error('Failed to load fliclibNodeJs.js:', err.message);
    console.error('Please download fliclibNodeJs.js from:');
    console.error('https://github.com/50ButtonsEach/fliclib-linux-hci/tree/master/clientlib/nodejs');
}

// Platform detection
const platform = process.platform; // 'win32', 'darwin', 'linux'

class FlicManager extends EventEmitter {
    constructor() {
        super();
        this.daemonProcess = null;
        this.client = null;
        this.connectionChannels = new Map();
        this.scanWizard = null;
        this.isConnected = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.reconnectDelay = 1000;
    }

    /**
     * Get platform-specific daemon info
     */
    getDaemonInfo() {
        const baseDir = app.isPackaged
            ? path.join(process.resourcesPath, 'flic')
            : __dirname;

        switch (platform) {
            case 'win32':
                return {
                    path: path.join(baseDir, 'FlicSDK.exe'),
                    args: ['127.0.0.1', '5551'],
                    downloadUrl: 'https://github.com/50ButtonsEach/fliclib-windows/releases'
                };
            case 'darwin':
                return {
                    path: path.join(baseDir, 'flicd'),
                    args: ['-f', '-s', '0.0.0.0', '-p', '5551'],
                    downloadUrl: 'https://github.com/50ButtonsEach/fliclib-linux-hci (compile for macOS)'
                };
            case 'linux':
                return {
                    path: path.join(baseDir, 'flicd'),
                    args: ['-f', '-s', '0.0.0.0', '-p', '5551'],
                    downloadUrl: 'https://github.com/50ButtonsEach/fliclib-linux-hci'
                };
            default:
                return null;
        }
    }

    /**
     * Get the path to the daemon executable
     */
    getDaemonPath() {
        const info = this.getDaemonInfo();
        return info ? info.path : null;
    }

    /**
     * Check if daemon exists
     */
    daemonExists() {
        const daemonPath = this.getDaemonPath();
        return daemonPath && fs.existsSync(daemonPath);
    }

    /**
     * Get platform-specific error message
     */
    getDaemonNotFoundError() {
        const info = this.getDaemonInfo();
        if (!info) {
            return `Unsupported platform: ${platform}`;
        }

        const daemonName = platform === 'win32' ? 'FlicSDK.exe' : 'flicd';
        return `${daemonName} not found. Please download it from: ${info.downloadUrl}`;
    }

    /**
     * Start the Flic daemon
     */
    startDaemon() {
        return new Promise((resolve, reject) => {
            const info = this.getDaemonInfo();

            if (!info) {
                const error = new Error(`Unsupported platform: ${platform}`);
                this.emit('error', error);
                reject(error);
                return;
            }

            if (!this.daemonExists()) {
                const error = new Error(this.getDaemonNotFoundError());
                this.emit('error', error);
                reject(error);
                return;
            }

            const daemonPath = info.path;
            const daemonArgs = info.args;

            console.log(`Starting Flic daemon from: ${daemonPath}`);
            console.log(`Platform: ${platform}, Args: ${daemonArgs.join(' ')}`);

            const spawnOptions = {
                stdio: 'ignore',
                detached: false
            };

            // Windows-specific options
            if (platform === 'win32') {
                spawnOptions.windowsHide = true;
            }

            this.daemonProcess = spawn(daemonPath, daemonArgs, spawnOptions);

            this.daemonProcess.on('error', (err) => {
                console.error('Daemon process error:', err);
                this.emit('error', err);
                reject(err);
            });

            this.daemonProcess.on('exit', (code) => {
                console.log('Daemon exited with code:', code);
                this.emit('daemonExit', code);
            });

            // Wait for daemon to be ready, then connect
            const startupDelay = platform === 'win32' ? 2000 : 1500;
            setTimeout(() => {
                this.connectToClient()
                    .then(resolve)
                    .catch(reject);
            }, startupDelay);
        });
    }

    /**
     * Connect to the Flic daemon via TCP
     */
    connectToClient() {
        return new Promise((resolve, reject) => {
            if (!fliclib) {
                reject(new Error('fliclibNodeJs.js not loaded'));
                return;
            }

            console.log('Connecting to Flic daemon...');
            this.client = new fliclib.FlicClient('localhost', 5551);

            this.client.on('ready', () => {
                console.log('Connected to Flic daemon');
                this.isConnected = true;
                this.reconnectAttempts = 0;
                this.emit('connected');

                // Get info about connected buttons
                this.client.getInfo((info) => {
                    console.log('Bluetooth controller state:', info.bluetoothControllerState);
                    console.log('Paired buttons:', info.bdAddrOfVerifiedButtons);
                    this.emit('info', info);

                    // Listen to all paired buttons
                    info.bdAddrOfVerifiedButtons.forEach((bdAddr) => {
                        this.listenToButton(bdAddr);
                    });
                });

                resolve(this.client);
            });

            this.client.on('error', (error) => {
                console.error('Flic client error:', error);
                this.isConnected = false;
                this.emit('error', error);
                reject(error);
            });

            this.client.on('close', (hadError) => {
                console.log('Flic client disconnected, hadError:', hadError);
                this.isConnected = false;
                this.emit('disconnected', hadError);
                this.attemptReconnect();
            });

            this.client.on('newVerifiedButton', (bdAddr) => {
                console.log('New button paired:', bdAddr);
                this.emit('buttonPaired', bdAddr);
                this.listenToButton(bdAddr);
            });
        });
    }

    /**
     * Attempt to reconnect to the daemon with exponential backoff
     */
    attemptReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error('Max reconnect attempts reached');
            this.emit('reconnectFailed');
            return;
        }

        this.reconnectAttempts++;
        const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
        console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

        setTimeout(() => {
            this.connectToClient().catch((err) => {
                console.error('Reconnect failed:', err.message);
            });
        }, delay);
    }

    /**
     * Listen to button events
     */
    listenToButton(bdAddr) {
        if (!this.client || !fliclib) return;

        // Remove existing channel if any
        if (this.connectionChannels.has(bdAddr)) {
            const oldChannel = this.connectionChannels.get(bdAddr);
            this.client.removeConnectionChannel(oldChannel);
        }

        const channel = new fliclib.FlicConnectionChannel(bdAddr);

        channel.on('buttonSingleOrDoubleClickOrHold', (clickType, wasQueued, timeDiff) => {
            console.log(`Button ${bdAddr}: ${clickType}`);
            this.emit('buttonEvent', {
                bdAddr,
                clickType,
                wasQueued,
                timeDiff
            });
        });

        channel.on('connectionStatusChanged', (status, disconnectReason) => {
            console.log(`Button ${bdAddr} status: ${status}`);
            this.emit('buttonStatusChanged', {
                bdAddr,
                status,
                disconnectReason
            });
        });

        this.connectionChannels.set(bdAddr, channel);
        this.client.addConnectionChannel(channel);
    }

    /**
     * Start scanning for new buttons
     */
    startPairing() {
        return new Promise((resolve, reject) => {
            if (!this.client || !fliclib) {
                reject(new Error('Not connected to daemon'));
                return;
            }

            if (this.scanWizard) {
                this.client.removeScanWizard(this.scanWizard);
            }

            console.log('Starting button scan...');
            this.scanWizard = new fliclib.FlicScanWizard();

            this.scanWizard.on('foundPrivateButton', () => {
                console.log('Found private button - hold for 7 seconds to reset');
                this.emit('pairingStatus', {
                    status: 'foundPrivate',
                    message: 'Found private button - hold for 7 seconds to reset'
                });
            });

            this.scanWizard.on('foundPublicButton', (bdAddr, name) => {
                console.log(`Found button: ${name} (${bdAddr})`);
                this.emit('pairingStatus', {
                    status: 'foundPublic',
                    bdAddr,
                    name,
                    message: `Found button: ${name}`
                });
            });

            this.scanWizard.on('buttonConnected', (bdAddr, name) => {
                console.log(`Connecting: ${name} (${bdAddr})`);
                this.emit('pairingStatus', {
                    status: 'connecting',
                    bdAddr,
                    name,
                    message: `Connecting to ${name}...`
                });
            });

            this.scanWizard.on('completed', (result, bdAddr, name) => {
                console.log(`Pairing result: ${result}`);

                if (result === 'WizardSuccess') {
                    this.emit('pairingStatus', {
                        status: 'success',
                        bdAddr,
                        name,
                        message: `Successfully paired: ${name}`
                    });
                    resolve({ bdAddr, name });
                } else {
                    this.emit('pairingStatus', {
                        status: 'failed',
                        result,
                        message: `Pairing failed: ${result}`
                    });
                    reject(new Error(`Pairing failed: ${result}`));
                }

                this.scanWizard = null;
            });

            this.client.addScanWizard(this.scanWizard);
            this.emit('pairingStatus', {
                status: 'scanning',
                message: 'Scanning for buttons... Press and hold your Flic button.'
            });
        });
    }

    /**
     * Cancel ongoing pairing
     */
    cancelPairing() {
        if (this.scanWizard && this.client) {
            this.client.removeScanWizard(this.scanWizard);
            this.scanWizard = null;
            this.emit('pairingStatus', {
                status: 'cancelled',
                message: 'Pairing cancelled'
            });
        }
    }

    /**
     * Remove a paired button
     */
    removeButton(bdAddr) {
        return new Promise((resolve, reject) => {
            if (!this.client) {
                reject(new Error('Not connected to daemon'));
                return;
            }

            // Remove connection channel
            if (this.connectionChannels.has(bdAddr)) {
                const channel = this.connectionChannels.get(bdAddr);
                this.client.removeConnectionChannel(channel);
                this.connectionChannels.delete(bdAddr);
            }

            // Delete from daemon
            this.client.deleteButton(bdAddr);
            console.log(`Removed button: ${bdAddr}`);
            this.emit('buttonRemoved', bdAddr);
            resolve();
        });
    }

    /**
     * Get list of paired buttons
     */
    getPairedButtons() {
        return new Promise((resolve, reject) => {
            if (!this.client) {
                reject(new Error('Not connected to daemon'));
                return;
            }

            this.client.getInfo((info) => {
                resolve(info.bdAddrOfVerifiedButtons || []);
            });
        });
    }

    /**
     * Get Bluetooth controller status
     */
    getBluetoothStatus() {
        return new Promise((resolve, reject) => {
            if (!this.client) {
                resolve({ state: 'disconnected', platform });
                return;
            }

            this.client.getInfo((info) => {
                resolve({
                    state: info.bluetoothControllerState,
                    myBdAddr: info.myBdAddr,
                    myBdAddrType: info.myBdAddrType,
                    platform
                });
            });
        });
    }

    /**
     * Get current platform
     */
    getPlatform() {
        return platform;
    }

    /**
     * Stop the daemon and clean up
     */
    stop() {
        console.log('Stopping FlicManager...');

        // Cancel any ongoing pairing
        this.cancelPairing();

        // Remove all connection channels
        this.connectionChannels.forEach((channel, bdAddr) => {
            if (this.client) {
                this.client.removeConnectionChannel(channel);
            }
        });
        this.connectionChannels.clear();

        // Close client connection
        if (this.client) {
            this.client.close();
            this.client = null;
        }

        // Kill daemon process
        if (this.daemonProcess) {
            if (platform === 'win32') {
                this.daemonProcess.kill();
            } else {
                // On Unix, send SIGTERM for graceful shutdown
                this.daemonProcess.kill('SIGTERM');
            }
            this.daemonProcess = null;
        }

        this.isConnected = false;
        console.log('FlicManager stopped');
    }
}

module.exports = FlicManager;
