/**
 * Preload Script - IPC Bridge
 * Exposes secure IPC methods to renderer processes
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // Video configuration
    getVideoConfig: () => ipcRenderer.invoke('get-video-config'),
    getVideoConfigValidated: () => ipcRenderer.invoke('get-video-config-validated'),
    saveVideoConfig: (config) => ipcRenderer.invoke('save-video-config', config),
    validateVideoFiles: (config) => ipcRenderer.invoke('validate-video-files', config),
    getVideosPath: () => ipcRenderer.invoke('get-videos-path'),
    getCachePath: () => ipcRenderer.invoke('get-cache-path'),
    selectVideoFile: () => ipcRenderer.invoke('select-video-file'),

    // Port and server checks
    checkPorts: () => ipcRenderer.invoke('check-ports'),

    // Flic button configuration
    getFlicConfig: () => ipcRenderer.invoke('get-flic-config'),
    saveFlicConfig: (config) => ipcRenderer.invoke('save-flic-config', config),

    // Flic button management
    getPairedButtons: () => ipcRenderer.invoke('get-paired-buttons'),
    startButtonPairing: () => ipcRenderer.invoke('start-button-pairing'),
    cancelButtonPairing: () => ipcRenderer.invoke('cancel-button-pairing'),
    removeButton: (bdAddr) => ipcRenderer.invoke('remove-button', bdAddr),
    setButtonMapping: (bdAddr, videoNumber, name) =>
        ipcRenderer.invoke('set-button-mapping', bdAddr, videoNumber, name),
    getBluetoothStatus: () => ipcRenderer.invoke('get-bluetooth-status'),
    getFlicAvailability: () => ipcRenderer.invoke('get-flic-availability'),

    // Player control
    launchPlayer: () => ipcRenderer.invoke('launch-player'),
    closePlayer: () => ipcRenderer.invoke('close-player'),

    // Event listeners
    onFlicStatus: (callback) => {
        ipcRenderer.on('flic-status', (event, data) => callback(data));
    },
    onButtonStatusChanged: (callback) => {
        ipcRenderer.on('button-status-changed', (event, data) => callback(data));
    },
    onPairingStatus: (callback) => {
        ipcRenderer.on('pairing-status', (event, data) => callback(data));
    },
    onButtonPaired: (callback) => {
        ipcRenderer.on('button-paired', (event, bdAddr) => callback(bdAddr));
    },
    onButtonRemoved: (callback) => {
        ipcRenderer.on('button-removed', (event, bdAddr) => callback(bdAddr));
    },

    // Remove listeners (cleanup)
    removeAllListeners: (channel) => {
        ipcRenderer.removeAllListeners(channel);
    }
});
