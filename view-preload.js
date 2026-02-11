const { contextBridge, ipcRenderer } = require('electron');

// Inject screen sharing support
window.addEventListener('DOMContentLoaded', () => {
  // Override navigator.mediaDevices.getDisplayMedia
  if (navigator.mediaDevices) {
    const originalGetDisplayMedia = navigator.mediaDevices.getDisplayMedia;
    
    navigator.mediaDevices.getDisplayMedia = async function(constraints) {
      try {
        // Get available sources from Electron
        const sources = await ipcRenderer.invoke('DESKTOP_CAPTURER_GET_SOURCES', {
          types: ['window', 'screen']
        });

        if (!sources || sources.length === 0) {
          throw new Error('No screen sources available');
        }

        // For now, automatically select the first screen
        // In a production app, you'd show a picker UI
        const selectedSource = sources.find(s => s.id.startsWith('screen')) || sources[0];

        // Get the stream using getUserMedia with the chromeMediaSourceId
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: selectedSource.id
            }
          }
        });

        return stream;
      } catch (error) {
        console.error('Screen sharing error:', error);
        // Fallback to original method
        if (originalGetDisplayMedia) {
          return originalGetDisplayMedia.call(navigator.mediaDevices, constraints);
        }
        throw error;
      }
    };
  }
});
