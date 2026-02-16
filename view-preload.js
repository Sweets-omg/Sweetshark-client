const { ipcRenderer } = require('electron');

// Intercept getDisplayMedia to show a custom source picker, then hand off to
// Electron's setDisplayMediaRequestHandler (in main.js) which supplies the
// correct source + audio mode.  Using getUserMedia with chromeMediaSource audio
// crashes the renderer in modern Electron (Error 263), so we use the proper
// getDisplayMedia → setDisplayMediaRequestHandler pipeline instead.
window.addEventListener('DOMContentLoaded', () => {
  if (!navigator.mediaDevices) return;

  const originalGetDisplayMedia = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);

  navigator.mediaDevices.getDisplayMedia = async function (constraints) {
    try {
      const sources = await ipcRenderer.invoke('DESKTOP_CAPTURER_GET_SOURCES', {
        types: ['window', 'screen']
      });

      if (!sources || sources.length === 0) {
        return originalGetDisplayMedia(constraints);
      }

      // ── Build overlay ────────────────────────────────────────────────────────
      const overlayId = '__sharkord_screenshare_picker';
      const existing = document.getElementById(overlayId);
      if (existing) existing.remove();

      const overlay = document.createElement('div');
      overlay.id = overlayId;
      Object.assign(overlay.style, {
        position: 'fixed',
        zIndex: '99999999',
        inset: '0',
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
        maxHeight: '85vh',
        overflowY: 'auto',
        background: '#111',
        borderRadius: '8px',
        padding: '14px',
        boxSizing: 'border-box',
        border: '1px solid rgba(255,255,255,0.06)'
      });

      // ── Title ────────────────────────────────────────────────────────────────
      const title = document.createElement('div');
      title.textContent = 'Choose a screen or window to share';
      Object.assign(title.style, { fontSize: '18px', marginBottom: '12px' });

      // ── Audio toggle ─────────────────────────────────────────────────────────
      const AUDIO_PREF_KEY = '__sharkord_screenshare_audio';
      let shareAudio = localStorage.getItem(AUDIO_PREF_KEY) === 'true';

      const audioRow = document.createElement('div');
      Object.assign(audioRow.style, {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        marginBottom: '14px',
        padding: '10px 12px',
        background: '#1a1a1a',
        borderRadius: '6px',
        border: '1px solid rgba(255,255,255,0.07)',
        cursor: 'pointer',
        userSelect: 'none'
      });

      const speakerIcon = document.createElement('div');
      speakerIcon.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
        <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
        <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
      </svg>`;
      Object.assign(speakerIcon.style, {
        display: 'flex',
        alignItems: 'center',
        color: '#888',
        flexShrink: '0',
        pointerEvents: 'none'
      });

      const toggleTrack = document.createElement('div');
      Object.assign(toggleTrack.style, {
        position: 'relative',
        width: '40px',
        height: '22px',
        borderRadius: '11px',
        background: '#444',
        flexShrink: '0',
        transition: 'background 0.2s',
        pointerEvents: 'none'
      });

      const toggleThumb = document.createElement('div');
      Object.assign(toggleThumb.style, {
        position: 'absolute',
        top: '3px',
        left: '3px',
        width: '16px',
        height: '16px',
        borderRadius: '50%',
        background: '#fff',
        transition: 'left 0.2s'
      });
      toggleTrack.appendChild(toggleThumb);

      const audioLabel = document.createElement('div');
      Object.assign(audioLabel.style, {
        fontSize: '14px',
        color: '#ccc',
        flexGrow: '1',
        pointerEvents: 'none'
      });
      audioLabel.textContent = 'Share system audio';

      const audioNote = document.createElement('div');
      Object.assign(audioNote.style, {
        fontSize: '11px',
        color: '#555',
        pointerEvents: 'none'
      });
      audioNote.textContent = 'Windows only';

      function updateToggle () {
        toggleTrack.style.background = shareAudio ? '#4e0073' : '#444';
        toggleThumb.style.left      = shareAudio ? '21px'    : '3px';
        speakerIcon.style.color     = shareAudio ? '#4e0073' : '#888';
        audioLabel.style.color      = shareAudio ? '#fff'    : '#ccc';
      }

      audioRow.onclick = () => { shareAudio = !shareAudio; localStorage.setItem(AUDIO_PREF_KEY, shareAudio); updateToggle(); };

      audioRow.appendChild(speakerIcon);
      audioRow.appendChild(toggleTrack);
      audioRow.appendChild(audioLabel);
      audioRow.appendChild(audioNote);
      updateToggle(); // reflect persisted state on first render

      // ── Source grid ──────────────────────────────────────────────────────────
      const grid = document.createElement('div');
      Object.assign(grid.style, {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
        gap: '12px'
      });

      let pickerClosed = false;
      const thumbIntervals = [];
      const lastThumbs = new Map();

      async function refreshThumbnails () {
        if (pickerClosed) return;
        try {
          const updated = await ipcRenderer.invoke('DESKTOP_CAPTURER_GET_SOURCES', {
            types: ['window', 'screen']
          });
          lastThumbs.clear();
          updated.forEach((src, i) => {
            const item = grid.children[i];
            if (!item) return;
            const thumb = item.querySelector('.src-thumb');
            if (thumb && src.thumbnail) {
              thumb.style.backgroundImage = '';
              thumb.style.backgroundImage = `url(${src.thumbnail})`;
              lastThumbs.set(src.id, src.thumbnail);
            }
          });
        } catch (e) { /* ignore */ }
      }

      function cleanupPicker () {
        pickerClosed = true;
        thumbIntervals.forEach(clearInterval);
        thumbIntervals.length = 0;
        lastThumbs.clear();
        grid.querySelectorAll('.src-thumb').forEach(t => { t.style.backgroundImage = ''; });
      }

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
        thumb.className = 'src-thumb';
        Object.assign(thumb.style, {
          height: '120px',
          marginBottom: '8px',
          background: '#333',
          borderRadius: '4px',
          backgroundSize: 'cover',
          backgroundPosition: 'center'
        });
        if (src.thumbnail) thumb.style.backgroundImage = `url(${src.thumbnail})`;

        const name = document.createElement('div');
        name.textContent = src.name || src.title || `Source ${src.id}`;
        Object.assign(name.style, {
          fontSize: '13px',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis'
        });

        item.appendChild(thumb);
        item.appendChild(name);
        grid.appendChild(item);
      }

      thumbIntervals.push(setInterval(refreshThumbnails, 5000));

      // ── Cancel button ────────────────────────────────────────────────────────
      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = 'Cancel';
      Object.assign(cancelBtn.style, {
        marginTop: '12px',
        padding: '8px 12px',
        background: '#333',
        border: '1px solid rgba(255,255,255,0.06)',
        color: '#fff',
        borderRadius: '6px',
        cursor: 'pointer'
      });

      card.appendChild(title);
      card.appendChild(audioRow);
      card.appendChild(grid);
      card.appendChild(cancelBtn);
      overlay.appendChild(card);
      document.documentElement.appendChild(overlay);

      // ── Promise that resolves when user picks a source ───────────────────────
      return new Promise((resolve, reject) => {

        // Attach click handlers to each source button now that we have resolve/reject
        Array.from(grid.children).forEach((item, i) => {
          const src = sources[i];
          item.onclick = async () => {
            const captureAudio = shareAudio;
            const isScreen = src.id.startsWith('screen:');
            cleanupPicker();
            overlay.remove();

            try {
              // Tell main process which source + audio mode to use.
              // setDisplayMediaRequestHandler in main.js reads this and
              // supplies the correct DesktopCapturerSource + loopback audio.
              await ipcRenderer.invoke('SCREENSHARE_SET_PENDING', {
                sourceId: src.id,
                shareAudio: captureAudio,
                isScreen
              });

              // Call the real getDisplayMedia — Electron's handler takes over.
              // Pass audio:true when the user toggled it on so the browser
              // signals that an audio track is wanted.
              const stream = await originalGetDisplayMedia({
                video: true,
                audio: captureAudio
              });

              resolve(stream);
            } catch (err) {
              // If audio capture failed, retry video-only so screenshare still works.
              if (captureAudio) {
                try {
                  await ipcRenderer.invoke('SCREENSHARE_SET_PENDING', {
                    sourceId: src.id,
                    shareAudio: false,
                    isScreen
                  });
                  const stream = await originalGetDisplayMedia({ video: true, audio: false });
                  resolve(stream);
                } catch (retryErr) {
                  reject(retryErr);
                }
              } else {
                reject(err);
              }
            }
          };
        });

        cancelBtn.onclick = () => {
          cleanupPicker();
          overlay.remove();
          reject(new DOMException('The user cancelled the screen-sharing request.', 'AbortError'));
        };

        // Clean up if the overlay is removed externally
        const mo = new MutationObserver(() => {
          if (!document.contains(overlay)) {
            cleanupPicker();
            mo.disconnect();
          }
        });
        mo.observe(document.documentElement, { childList: true, subtree: true });
      });

    } catch (err) {
      return originalGetDisplayMedia(constraints);
    }
  };
});
