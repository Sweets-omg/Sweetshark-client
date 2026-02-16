const { contextBridge, ipcRenderer } = require('electron');

// Inject screen sharing support: show a simple picker UI inside the BrowserView page,
// then obtain a stream using the selected source id via getUserMedia with chromeMediaSourceId.
window.addEventListener('DOMContentLoaded', () => {
  if (!navigator.mediaDevices) return;
  const originalGetDisplayMedia = navigator.mediaDevices.getDisplayMedia && navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);

  navigator.mediaDevices.getDisplayMedia = async function(constraints) {
    try {
      // Ask main process for sources
      const sources = await ipcRenderer.invoke('DESKTOP_CAPTURER_GET_SOURCES', { types: ['window', 'screen'] });
      if (!sources || sources.length === 0) {
        // fallback to original
        if (originalGetDisplayMedia) return originalGetDisplayMedia(constraints);
        throw new Error('No screen sources available');
      }

      // Build simple picker overlay injected into the current page
      const overlayId = '__sharkord_screenshare_picker';
      // Remove existing if any
      const existing = document.getElementById(overlayId);
      if (existing) existing.remove();

      const overlay = document.createElement('div');
      overlay.id = overlayId;
      Object.assign(overlay.style, {
        position: 'fixed',
        zIndex: 99999999,
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
      Object.assign(title.style, { fontSize: '18px', marginBottom: '12px' });

      // ── Audio toggle ──────────────────────────────────────────────────────────
      let shareAudio = false;

      const audioToggleRow = document.createElement('div');
      Object.assign(audioToggleRow.style, {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        marginBottom: '14px',
        padding: '10px 12px',
        background: '#1a1a1a',
        borderRadius: '6px',
        border: '1px solid rgba(255,255,255,0.07)',
        userSelect: 'none'
      });

      // Toggle switch track
      const toggleTrack = document.createElement('div');
      Object.assign(toggleTrack.style, {
        position: 'relative',
        width: '40px',
        height: '22px',
        borderRadius: '11px',
        background: '#444',
        cursor: 'pointer',
        flexShrink: '0',
        transition: 'background 0.2s'
      });

      // Toggle switch thumb
      const toggleThumb = document.createElement('div');
      Object.assign(toggleThumb.style, {
        position: 'absolute',
        top: '3px',
        left: '3px',
        width: '16px',
        height: '16px',
        borderRadius: '50%',
        background: '#fff',
        transition: 'left 0.2s',
        pointerEvents: 'none'
      });
      toggleTrack.appendChild(toggleThumb);

      // Speaker icon (SVG)
      const speakerIcon = document.createElement('div');
      speakerIcon.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
        <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
        <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
      </svg>`;
      Object.assign(speakerIcon.style, { display: 'flex', alignItems: 'center', color: '#888', flexShrink: '0' });

      const audioLabel = document.createElement('div');
      Object.assign(audioLabel.style, { fontSize: '14px', color: '#ccc', flexGrow: '1' });
      audioLabel.textContent = 'Share system audio';

      const audioNote = document.createElement('div');
      Object.assign(audioNote.style, { fontSize: '11px', color: '#555' });
      audioNote.textContent = 'Windows only';

      function updateToggleVisuals() {
        toggleTrack.style.background = shareAudio ? '#4e0073' : '#444';
        toggleThumb.style.left = shareAudio ? '21px' : '3px';
        speakerIcon.style.color = shareAudio ? '#4e0073' : '#888';
        audioLabel.style.color = shareAudio ? '#fff' : '#ccc';
      }

      toggleTrack.onclick = () => {
        shareAudio = !shareAudio;
        updateToggleVisuals();
      };
      // Clicking the whole row also toggles
      audioToggleRow.onclick = (e) => {
        if (e.target === audioToggleRow || e.target === audioLabel || e.target === audioNote) {
          shareAudio = !shareAudio;
          updateToggleVisuals();
        }
      };

      audioToggleRow.appendChild(speakerIcon);
      audioToggleRow.appendChild(toggleTrack);
      audioToggleRow.appendChild(audioLabel);
      audioToggleRow.appendChild(audioNote);
      // ─────────────────────────────────────────────────────────────────────────

      const grid = document.createElement('div');
      Object.assign(grid.style, {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
        gap: '12px'
      });

      // Create items and store screenshot interval references
      let screenshotIntervals = [];
      let pickerClosed = false;
      let lastScreenshots = new Map(); // Store references to clear old data

      // Function to capture and update screenshots
      async function updateScreenshots() {
        if (pickerClosed) return;
        
        try {
          const updatedSources = await ipcRenderer.invoke('DESKTOP_CAPTURER_GET_SOURCES', { 
            types: ['window', 'screen']
          });
          
          // Clear old screenshots from memory before updating
          lastScreenshots.clear();
          
          // Update thumbnails
          updatedSources.forEach((src, index) => {
            const item = grid.children[index];
            if (item) {
              const thumb = item.querySelector('div');
              if (thumb && src.thumbnail) {
                // Clear old image data
                thumb.style.backgroundImage = '';
                // Set new image
                thumb.style.backgroundImage = `url(${src.thumbnail})`;
                // Store reference
                lastScreenshots.set(src.id, src.thumbnail);
              }
            }
          });
        } catch (error) {
          console.error('Failed to update screenshots:', error);
        }
      }

      // Function to clean up screenshot intervals and data
      function cleanupScreenshots() {
        pickerClosed = true;
        screenshotIntervals.forEach(interval => clearInterval(interval));
        screenshotIntervals = [];
        
        // Clear all screenshot data from memory
        lastScreenshots.clear();
        
        // Clear background images from DOM elements
        const thumbs = grid.querySelectorAll('div[style*="background-image"]');
        thumbs.forEach(thumb => {
          thumb.style.backgroundImage = '';
        });
      }

      // Use thumbnails if provided (source.thumbnail is a NativeImage in main, sent as dataURL)
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
          textAlign: 'left'
        });

        const thumb = document.createElement('div');
        thumb.style.height = '120px';
        thumb.style.marginBottom = '8px';
        thumb.style.background = '#333';
        thumb.style.borderRadius = '4px';
        thumb.style.backgroundSize = 'cover';
        thumb.style.backgroundPosition = 'center';

        if (src.thumbnail && typeof src.thumbnail === 'string') {
          thumb.style.backgroundImage = `url(${src.thumbnail})`;
        }

        const name = document.createElement('div');
        name.textContent = src.name || src.title || ('Source ' + src.id);
        name.style.fontSize = '13px';
        name.style.whiteSpace = 'nowrap';
        name.style.overflow = 'hidden';
        name.style.textOverflow = 'ellipsis';

        item.appendChild(thumb);
        item.appendChild(name);

        item.onclick = async (e) => {
          e.preventDefault();
          const captureAudio = shareAudio; // snapshot toggle state at click time
          cleanupScreenshots();
          // remove overlay
          overlay.remove();
          // Request stream for chosen source using chromeMediaSourceId constraint.
          // When captureAudio is true, also request desktop audio via chromeMediaSource:'desktop'.
          // This only captures system audio on Windows; on macOS/Linux the audio track will
          // either be silent or getUserMedia will ignore the audio constraint gracefully.
          try {
            const audioConstraint = captureAudio
              ? { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: src.id } }
              : false;

            const stream = await navigator.mediaDevices.getUserMedia({
              audio: audioConstraint,
              video: {
                mandatory: {
                  chromeMediaSource: 'desktop',
                  chromeMediaSourceId: src.id,
                  maxWidth: window.screen.width,
                  maxHeight: window.screen.height
                }
              }
            });
            return stream;
          } catch (err) {
            console.error('getUserMedia for desktop failed', err);
            // If audio capture failed (e.g. unsupported platform), retry without audio
            if (captureAudio) {
              console.warn('Screenshare audio capture failed, retrying without audio:', err);
              try {
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
                return stream;
              } catch (retryErr) {
                console.error('getUserMedia retry without audio also failed', retryErr);
              }
            }
            // Fallback to original getDisplayMedia if available
            if (originalGetDisplayMedia) return originalGetDisplayMedia(constraints);
            throw err;
          }
        };

        grid.appendChild(item);
      }

      // Start screenshot update interval (every 5 seconds)
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
        cursor: 'pointer'
      });
      cancel.onclick = () => { 
        cleanupScreenshots();
        overlay.remove(); 
      };

      card.appendChild(title);
      card.appendChild(audioToggleRow);
      card.appendChild(grid);
      card.appendChild(cancel);
      overlay.appendChild(card);
      document.documentElement.appendChild(overlay);

      // Return a Promise that resolves when the user picks an item.
      return new Promise((resolve, reject) => {
        // We will monkey-patch each item's onclick to resolve the promise with the stream.
        // But since the onclick above returns stream, we need to intercept when a stream is created.
        // A simple approach: wrap navigator.mediaDevices.getUserMedia to catch the next call with chromeMediaSourceId.
        const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async function(constraints) {
          // restore original
          navigator.mediaDevices.getUserMedia = originalGetUserMedia;
          try {
            const s = await originalGetUserMedia(constraints);
            resolve(s);
            return s;
          } catch (err) {
            reject(err);
            throw err;
          }
        };
        
        // Clean up if overlay is removed externally
        const observer = new MutationObserver((mutations) => {
          if (!document.contains(overlay)) {
            cleanupScreenshots();
            observer.disconnect();
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
