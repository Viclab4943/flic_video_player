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

// Persistent database path - stored in user data directory to survive app updates
function getDaemonDbPath() {
    const userDataPath = app.getPath('userData');
    return path.join(userDataPath, 'flicd.sqlite');
}

// Backup path for the database
function getDaemonDbBackupPath() {
    const userDataPath = app.getPath('userData');
    return path.join(userDataPath, 'flicd.sqlite.backup');
}

// Backup the daemon database after successful pairing
function backupDaemonDb() {
    const dbPath = getDaemonDbPath();
    const backupPath = getDaemonDbBackupPath();

    try {
        if (fs.existsSync(dbPath)) {
            fs.copyFileSync(dbPath, backupPath);
            console.log(`Flic database backed up to: ${backupPath}`);
            return true;
        }
    } catch (err) {
        console.error('Failed to backup Flic database:', err.message);
    }
    return false;
}

// Restore database from backup if main database is missing
function restoreDaemonDbIfNeeded() {
    const dbPath = getDaemonDbPath();
    const backupPath = getDaemonDbBackupPath();

    // If main database exists, no need to restore
    if (fs.existsSync(dbPath)) {
        const stats = fs.statSync(dbPath);
        if (stats.size > 0) {
            console.log('Flic database exists and is valid');
            return false;
        }
        console.warn('Flic database exists but is empty, will restore from backup');
    }

    // Try to restore from backup
    if (fs.existsSync(backupPath)) {
        try {
            const backupStats = fs.statSync(backupPath);
            if (backupStats.size > 0) {
                fs.copyFileSync(backupPath, dbPath);
                console.log(`Flic database restored from backup: ${backupPath}`);
                return true;
            }
        } catch (err) {
            console.error('Failed to restore Flic database from backup:', err.message);
        }
    } else {
        console.log('No Flic database backup found (this is normal for first run)');
    }

    return false;
}

class FlicManager extends EventEmitter {
    constructor() {
        super();
        this.daemonProcess = null;
        this.client = null;
        this.connectionChannels = new Map();
        this.batteryListeners = new Map();
        this.scanWizard = null;
        this.isConnected = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.reconnectDelay = 1000;
        this.maxEventAgeMs = 5000; // Ignore queued events older than this

        // Health monitoring
        this.healthCheckInterval = null;
        this.healthCheckFrequency = 30000; // Check every 30 seconds
        this.lastControllerState = null;
        this.buttonStates = new Map(); // Track each button's connection state
        this.disconnectedButtons = new Set(); // Buttons that need reconnection
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
                    args: ['-f', '-d', getDaemonDbPath(), '-s', '0.0.0.0', '-p', '5551'],
                    downloadUrl: 'https://github.com/50ButtonsEach/fliclib-linux-hci (compile for macOS)'
                };
            case 'linux':
                return {
                    path: path.join(baseDir, 'flicd'),
                    args: ['-f', '-d', getDaemonDbPath(), '-s', '0.0.0.0', '-p', '5551'],
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

            // Ensure userData directory exists for the database
            const userDataPath = app.getPath('userData');
            if (!fs.existsSync(userDataPath)) {
                fs.mkdirSync(userDataPath, { recursive: true });
            }

            // Restore database from backup if main database is missing (macOS/Linux only)
            if (platform !== 'win32') {
                restoreDaemonDbIfNeeded();
            }

            const daemonPath = info.path;
            const daemonArgs = info.args;

            console.log(`Starting Flic daemon from: ${daemonPath}`);
            console.log(`Platform: ${platform}, Args: ${daemonArgs.join(' ')}`);
            if (platform !== 'win32') {
                console.log(`Flic database path: ${getDaemonDbPath()}`);
            }

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
            this.client = new fliclib.FlicClient('127.0.0.1', 5551);

            this.client.on('ready', () => {
                console.log('Connected to Flic daemon');
                this.isConnected = true;
                this.reconnectAttempts = 0;
                this.emit('connected');

                // Get info about connected buttons
                this.client.getInfo((info) => {
                    console.log('Bluetooth controller state:', info.bluetoothControllerState);
                    console.log('Paired buttons:', info.bdAddrOfVerifiedButtons);
                    this.lastControllerState = info.bluetoothControllerState;
                    this.emit('info', info);

                    // Listen to all paired buttons and emit event for each
                    // so launcher can ensure they're in the config
                    info.bdAddrOfVerifiedButtons.forEach((bdAddr) => {
                        this.listenToButton(bdAddr);
                        this.emit('existingButtonFound', bdAddr);
                    });

                    // Health monitoring disabled for now - can be re-enabled if stable
                    // this.startHealthMonitoring();
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

                // Backup database after successful pairing (macOS/Linux only)
                if (platform !== 'win32') {
                    setTimeout(() => {
                        backupDaemonDb();
                    }, 1000); // Small delay to ensure daemon has written to database
                }
            });

            // Monitor Bluetooth controller state changes
            // States: Detached (lost connection), Resetting (reinitializing), Attached (ready)
            this.client.on('bluetoothControllerStateChange', (state) => {
                console.log('Bluetooth controller state changed:', state);
                const previousState = this.lastControllerState;
                this.lastControllerState = state;
                this.emit('bluetoothStateChanged', state);

                if (state === 'Detached') {
                    console.warn('Bluetooth controller detached - check USB adapter');
                    this.emit('error', new Error('Bluetooth controller detached'));
                    // Mark all buttons as needing reconnection
                    this.connectionChannels.forEach((channel, bdAddr) => {
                        this.disconnectedButtons.add(bdAddr);
                    });
                } else if (state === 'Attached') {
                    console.log('Bluetooth controller attached and ready');
                    // Auto-recover: reconnect buttons that were disconnected
                    if (previousState === 'Detached' || previousState === 'Resetting') {
                        console.log('Controller recovered - reconnecting buttons...');
                        this.recoverButtonConnections();
                    }
                }
            });

            // Handle connection space limits (max 8 concurrent connections)
            this.client.on('noSpaceForNewConnection', (maxConcurrentlyConnectedButtons) => {
                console.warn(`Connection limit reached (max ${maxConcurrentlyConnectedButtons} buttons)`);
                this.emit('connectionLimitReached', maxConcurrentlyConnectedButtons);
            });

            this.client.on('gotSpaceForNewConnection', (maxConcurrentlyConnectedButtons) => {
                console.log('Connection slot available');
                this.emit('connectionSlotAvailable', maxConcurrentlyConnectedButtons);
            });
        });
    }

    /**
     * Start health monitoring
     */
    startHealthMonitoring() {
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
        }

        console.log('Starting health monitoring...');
        this.healthCheckInterval = setInterval(() => {
            this.performHealthCheck();
        }, this.healthCheckFrequency);
    }

    /**
     * Stop health monitoring
     */
    stopHealthMonitoring() {
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = null;
        }
    }

    /**
     * Perform health check on daemon and buttons
     */
    performHealthCheck() {
        if (!this.client || !this.isConnected) {
            console.log('Health check: Not connected to daemon');
            return;
        }

        // Check daemon is responsive
        this.client.getInfo((info) => {
            console.log(`Health check: Controller=${info.bluetoothControllerState}, Buttons=${info.bdAddrOfVerifiedButtons.length}`);

            // Check for buttons that are verified but not being listened to
            info.bdAddrOfVerifiedButtons.forEach((bdAddr) => {
                if (!this.connectionChannels.has(bdAddr)) {
                    console.log(`Health check: Button ${bdAddr} not connected, reconnecting...`);
                    this.listenToButton(bdAddr);
                }
            });

            // Check for buttons stuck in non-Ready state
            this.buttonStates.forEach((state, bdAddr) => {
                if (state === 'Disconnected' && this.connectionChannels.has(bdAddr)) {
                    console.log(`Health check: Button ${bdAddr} disconnected, refreshing channel...`);
                    this.disconnectedButtons.add(bdAddr);
                }
            });

            // Recover any disconnected buttons
            if (this.disconnectedButtons.size > 0) {
                this.recoverButtonConnections();
            }
        });
    }

    /**
     * Recover button connections after Bluetooth adapter comes back
     */
    recoverButtonConnections() {
        if (this.disconnectedButtons.size === 0) {
            return;
        }

        console.log(`Recovering ${this.disconnectedButtons.size} button connection(s)...`);

        const buttonsToRecover = Array.from(this.disconnectedButtons);
        this.disconnectedButtons.clear();

        // Stagger reconnections
        buttonsToRecover.forEach((bdAddr, index) => {
            setTimeout(() => {
                console.log(`Recovering button: ${bdAddr}`);
                // Remove old channel if exists
                if (this.connectionChannels.has(bdAddr)) {
                    const oldChannel = this.connectionChannels.get(bdAddr);
                    this.client.removeConnectionChannel(oldChannel);
                    this.connectionChannels.delete(bdAddr);
                }
                // Create fresh channel
                this.listenToButton(bdAddr);
            }, index * 500);
        });

        this.emit('buttonsRecovered', buttonsToRecover);
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
     * Force disconnect and reconnect all buttons for a clean state
     * Use this manually when buttons become unresponsive
     */
    reconnectAllButtons(buttonAddresses) {
        if (!this.client || !buttonAddresses || buttonAddresses.length === 0) {
            console.log('No buttons to reconnect');
            return;
        }

        console.log(`Reconnecting ${buttonAddresses.length} button(s)...`);

        // Remove all existing connection channels
        let removedCount = 0;
        buttonAddresses.forEach((bdAddr) => {
            if (this.connectionChannels.has(bdAddr)) {
                console.log(`Removing channel: ${bdAddr}`);
                const channel = this.connectionChannels.get(bdAddr);
                this.client.removeConnectionChannel(channel);
                this.connectionChannels.delete(bdAddr);
                removedCount++;
            }
        });

        // Wait longer if we actually removed channels
        const waitTime = removedCount > 0 ? 2000 : 500;

        setTimeout(() => {
            console.log('Creating connection channels...');
            buttonAddresses.forEach((bdAddr, index) => {
                // Stagger the connections slightly to avoid overwhelming the adapter
                setTimeout(() => {
                    console.log(`Connecting to button: ${bdAddr}`);
                    this.listenToButton(bdAddr);
                }, index * 300);
            });

            // Emit event after all buttons have been queued
            setTimeout(() => {
                console.log('All buttons reconnection initiated');
                this.emit('buttonsReconnected', buttonAddresses);
            }, buttonAddresses.length * 300 + 100);
        }, waitTime);
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
            // Filter stale queued events (older than maxEventAgeMs)
            // Buttons queue presses when disconnected - we don't want old presses
            if (wasQueued && timeDiff > this.maxEventAgeMs) {
                console.log(`Button ${bdAddr}: ${clickType} (IGNORED - stale event, ${timeDiff}ms old)`);
                return;
            }

            console.log(`Button ${bdAddr}: ${clickType}${wasQueued ? ` (queued, ${timeDiff}ms ago)` : ''}`);
            this.emit('buttonEvent', {
                bdAddr,
                clickType,
                wasQueued,
                timeDiff
            });
        });

        channel.on('connectionStatusChanged', (status, disconnectReason) => {
            console.log(`Button ${bdAddr} status: ${status}${disconnectReason ? ` (reason: ${disconnectReason})` : ''}`);

            // Track button state for health monitoring
            this.buttonStates.set(bdAddr, status);

            // Log specific issues that might help debugging
            if (disconnectReason === 'BondingKeysMismatch') {
                console.warn(`Button ${bdAddr}: Bonding keys mismatch - try holding button for 7 seconds to reset`);
            } else if (disconnectReason === 'ConnectionEstablishmentFailed') {
                console.warn(`Button ${bdAddr}: Connection failed - button may be out of range`);
            }

            // If button disconnected unexpectedly, mark for recovery
            if (status === 'Disconnected' && disconnectReason && disconnectReason !== 'Unspecified') {
                console.log(`Button ${bdAddr} will be recovered on next health check`);
                this.disconnectedButtons.add(bdAddr);
            }

            // If button reached Ready state, remove from recovery list
            if (status === 'Ready') {
                this.disconnectedButtons.delete(bdAddr);
            }

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

            // Pause health monitoring during pairing to avoid interference
            this.stopHealthMonitoring();

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

                // Resume health monitoring
                this.startHealthMonitoring();

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
            // Resume health monitoring
            this.startHealthMonitoring();
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

            // Delete from daemon - this tells the button it's been unpaired
            this.client.deleteButton(bdAddr);
            console.log(`Removed button: ${bdAddr}`);
            this.emit('buttonRemoved', bdAddr);
            resolve();
        });
    }

    /**
     * Forget ALL buttons - removes them from daemon so they know they're unpaired
     * Buttons will need to be re-paired after this
     */
    forgetAllButtons() {
        return new Promise((resolve, reject) => {
            if (!this.client) {
                reject(new Error('Not connected to daemon'));
                return;
            }

            this.client.getInfo((info) => {
                const buttons = info.bdAddrOfVerifiedButtons || [];
                console.log(`Forgetting ${buttons.length} button(s)...`);

                buttons.forEach((bdAddr) => {
                    // Remove connection channel
                    if (this.connectionChannels.has(bdAddr)) {
                        const channel = this.connectionChannels.get(bdAddr);
                        this.client.removeConnectionChannel(channel);
                        this.connectionChannels.delete(bdAddr);
                    }

                    // Delete from daemon
                    this.client.deleteButton(bdAddr);
                    console.log(`Forgot button: ${bdAddr}`);
                    this.emit('buttonRemoved', bdAddr);
                });

                resolve(buttons.length);
            });
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
     * Force reconnect all paired buttons
     * Useful when buttons become unresponsive
     */
    forceReconnectAll() {
        return new Promise((resolve, reject) => {
            if (!this.client) {
                reject(new Error('Not connected to daemon'));
                return;
            }

            this.client.getInfo((info) => {
                const buttons = info.bdAddrOfVerifiedButtons || [];
                if (buttons.length === 0) {
                    resolve([]);
                    return;
                }

                this.reconnectAllButtons(buttons);
                resolve(buttons);
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
     * Get button info (name, color, serial number, battery status, etc.)
     */
    getButtonInfo(bdAddr) {
        return new Promise((resolve, reject) => {
            if (!this.client) {
                reject(new Error('Not connected to daemon'));
                return;
            }

            this.client.getButtonInfo(bdAddr, (info) => {
                resolve({
                    bdAddr: info.bdAddr,
                    uuid: info.uuid,
                    color: info.color,
                    serialNumber: info.serialNumber,
                    name: info.name,
                    batteryStatus: info.batteryStatus, // Percentage or -1 if unknown
                    firmwareVersion: info.firmwareVersion,
                    flicVersion: info.flicVersion // 1 or 2
                });
            });
        });
    }

    /**
     * Start monitoring battery status for a button
     * Note: Battery updates only arrive when button is connected
     */
    startBatteryListener(bdAddr) {
        if (!this.client || !fliclib) return;

        const listener = new fliclib.FlicBatteryStatusListener(bdAddr);
        listener.on('batteryStatus', (batteryPercentage, timestamp) => {
            console.log(`Button ${bdAddr} battery: ${batteryPercentage}%`);
            this.emit('batteryStatus', {
                bdAddr,
                percentage: batteryPercentage,
                timestamp
            });
        });

        this.client.addBatteryStatusListener(listener);
        return listener;
    }

    /**
     * Restart the daemon completely
     * This clears all connection state and starts fresh
     */
    async restart() {
        console.log('Restarting Flic daemon...');

        // Stop everything
        this.stop();

        // Wait for cleanup
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Start fresh
        await this.startDaemon();

        console.log('Flic daemon restarted');
        return true;
    }

    /**
     * Stop the daemon and clean up
     */
    stop() {
        console.log('Stopping FlicManager...');

        // Stop health monitoring
        this.stopHealthMonitoring();

        // Clear state tracking
        this.buttonStates.clear();
        this.disconnectedButtons.clear();

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
