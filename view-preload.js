const { contextBridge, ipcRenderer } = require('electron');

// Security: Use contextBridge to safely expose IPC to the isolated context
contextBridge.exposeInMainWorld('__electronScreenShare', {
  getSources: (opts) => ipcRenderer.invoke('DESKTOP_CAPTURER_GET_SOURCES', opts)
});

// Inject screen sharing support with proper security isolation
window.addEventListener('DOMContentLoaded', () => {
  if (!navigator.mediaDevices) return;
  
  const originalGetDisplayMedia = navigator.mediaDevices.getDisplayMedia && 
                                  navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);

  navigator.mediaDevices.getDisplayMedia = async function(constraints) {
    try {
      // Ask main process for sources via the secure bridge
      const sources = await window.__electronScreenShare.getSources({ types: ['window', 'screen'] });
      
      if (!sources || sources.length === 0) {
        // Fallback to original if available
        if (originalGetDisplayMedia) return originalGetDisplayMedia(constraints);
        throw new Error('No screen sources available');
      }

      // Build simple picker overlay
      const overlayId = '__sharkord_screenshare_picker';
      const existing = document.getElementById(overlayId);
      if (existing) existing.remove();

      const overlay = document.createElement('div');
      overlay.id = overlayId;
      Object.assign(overlay.style, {
        position: 'fixed',
        zIndex: '99999999',
        inset: '0px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.6)',
        color: '#fff',
        fontFamily: 'sans-serif'
      });

      const card = document.createElement('div');
      Object.assign(card.style, {
        width: '900px',
        maxWidth: '95%',
        maxHeight: '85%',
        overflowY: 'auto',
        background: '#111',
        borderRadius: '8px',
        padding: '14px',
        boxSizing: 'border-box',
        border: '1px solid rgba(255,255,255,0.06)'
      });

      const title = document.createElement('div');
      title.textContent = 'Choose a screen or window to share';
      Object.assign(title.style, { 
        fontSize: '18px', 
        marginBottom: '8px',
        fontWeight: '600'
      });

      const grid = document.createElement('div');
      Object.assign(grid.style, {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
        gap: '12px'
      });

      // Track screenshot intervals and data
      let screenshotIntervals = [];
      let pickerClosed = false;
      let lastScreenshots = new Map();

      // Function to update screenshots
      async function updateScreenshots() {
        if (pickerClosed) return;
        
        try {
          const updatedSources = await window.__electronScreenShare.getSources({ 
            types: ['window', 'screen']
          });
          
          // Clear old screenshots from memory
          lastScreenshots.clear();
          
          // Update thumbnails
          updatedSources.forEach((src, index) => {
            const item = grid.children[index];
            if (item) {
              const thumb = item.querySelector('div');
              if (thumb && src.thumbnail) {
                thumb.style.backgroundImage = '';
                thumb.style.backgroundImage = `url(${src.thumbnail})`;
                lastScreenshots.set(src.id, src.thumbnail);
              }
            }
          });
        } catch (error) {
          console.error('Failed to update screenshots:', error);
        }
      }

      // Function to clean up
      function cleanupScreenshots() {
        pickerClosed = true;
        screenshotIntervals.forEach(interval => clearInterval(interval));
        screenshotIntervals = [];
        lastScreenshots.clear();
        
        const thumbs = grid.querySelectorAll('div[style*="background-image"]');
        thumbs.forEach(thumb => {
          thumb.style.backgroundImage = '';
        });
      }

      // Create picker items
      for (const src of sources) {
        const item = document.createElement('button');
        item.type = 'button';
        Object.assign(item.style, {
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'stretch',
          background: '#222',
          border: '1px solid rgba(255,255,255,0.05)',
          padding: '8px',
          borderRadius: '6px',
          cursor: 'pointer',
          color: '#fff',
          textAlign: 'left',
          transition: 'all 0.2s'
        });

        item.addEventListener('mouseenter', () => {
          item.style.background = '#333';
          item.style.borderColor = 'rgba(255,255,255,0.15)';
        });

        item.addEventListener('mouseleave', () => {
          item.style.background = '#222';
          item.style.borderColor = 'rgba(255,255,255,0.05)';
        });

        const thumb = document.createElement('div');
        Object.assign(thumb.style, {
          height: '120px',
          marginBottom: '8px',
          background: '#333',
          borderRadius: '4px',
          backgroundSize: 'cover',
          backgroundPosition: 'center'
        });

        if (src.thumbnail && typeof src.thumbnail === 'string') {
          thumb.style.backgroundImage = `url(${src.thumbnail})`;
        }

        const name = document.createElement('div');
        name.textContent = src.name || src.title || ('Source ' + src.id);
        Object.assign(name.style, {
          fontSize: '13px',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis'
        });

        item.appendChild(thumb);
        item.appendChild(name);

        // Handle selection
        item.onclick = async (e) => {
          e.preventDefault();
          cleanupScreenshots();
          overlay.remove();
          
          try {
            // Request stream using chromeMediaSourceId
            const stream = await navigator.mediaDevices.getUserMedia({
              audio: false,
              video: {
                mandatory: {
                  chromeMediaSource: 'desktop',
                  chromeMediaSourceId: src.id,
                  maxWidth: window.screen.width,
                  maxHeight: window.screen.height
                }
              }
            });
            
            // Resolve the promise with the stream
            if (typeof item.__resolveStream === 'function') {
              item.__resolveStream(stream);
            }
            
            return stream;
          } catch (err) {
            console.error('getUserMedia for desktop failed', err);
            
            if (typeof item.__rejectStream === 'function') {
              item.__rejectStream(err);
            }
            
            // Fallback to original if available
            if (originalGetDisplayMedia) return originalGetDisplayMedia(constraints);
            throw err;
          }
        };

        grid.appendChild(item);
      }

      // Start screenshot updates (every 5 seconds)
      const interval = setInterval(updateScreenshots, 5000);
      screenshotIntervals.push(interval);

      const cancel = document.createElement('button');
      cancel.textContent = 'Cancel';
      Object.assign(cancel.style, {
        marginTop: '12px',
        padding: '8px 12px',
        background: '#333',
        border: '1px solid rgba(255,255,255,0.06)',
        color: '#fff',
        borderRadius: '6px',
        cursor: 'pointer',
        transition: 'all 0.2s'
      });

      cancel.addEventListener('mouseenter', () => {
        cancel.style.background = '#444';
      });

      cancel.addEventListener('mouseleave', () => {
        cancel.style.background = '#333';
      });

      cancel.onclick = () => { 
        cleanupScreenshots();
        overlay.remove();
        
        // Reject all pending promises
        Array.from(grid.children).forEach(item => {
          if (typeof item.__rejectStream === 'function') {
            item.__rejectStream(new Error('User cancelled screen share'));
          }
        });
      };

      card.appendChild(title);
      card.appendChild(grid);
      card.appendChild(cancel);
      overlay.appendChild(card);
      document.documentElement.appendChild(overlay);

      // Return a promise that resolves when user picks a source
      return new Promise((resolve, reject) => {
        // Store resolve/reject on each item
        Array.from(grid.children).forEach(item => {
          item.__resolveStream = resolve;
          item.__rejectStream = reject;
        });
        
        // Clean up if overlay is removed externally
        const observer = new MutationObserver((mutations) => {
          if (!document.contains(overlay)) {
            cleanupScreenshots();
            observer.disconnect();
            reject(new Error('Picker overlay removed'));
          }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
      });
      
    } catch (error) {
      console.error('Screen sharing error in preload picker:', error);
      if (originalGetDisplayMedia) {
        return originalGetDisplayMedia(constraints);
      }
      throw error;
    }
  };
});
