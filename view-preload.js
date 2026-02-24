const { ipcRenderer } = require('electron');

// ── Per-window audio: Web Audio player ───────────────────────────────────────
// Receives f32le PCM frames from the sidecar (via main.js IPC) and schedules
// them into an AudioContext whose output is captured as a MediaStreamTrack.
// That track is then spliced into the screenshare MediaStream so Sharkord's
// WebRTC stack sees it as real screen-share audio.

class SidecarAudioPlayer {
  constructor(sampleRate = 48000) {
    this._ctx   = new AudioContext({ sampleRate });
    this._dest  = this._ctx.createMediaStreamDestination();
    this._next  = 0; // wall-clock scheduled time for next frame
    this._session = null;

    // Resume AudioContext on user gesture if it starts suspended
    if (this._ctx.state === 'suspended') {
      this._ctx.resume().catch(() => {});
    }
  }

  // Schedule a Float32Array of mono samples into the player.
  feedSamples(float32Samples) {
    const frameLen = float32Samples.length;
    const buf = this._ctx.createBuffer(1, frameLen, this._ctx.sampleRate);
    buf.copyToChannel(float32Samples, 0);

    const src = this._ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this._dest);

    const now = this._ctx.currentTime;
    // Keep a 60ms look-ahead buffer; resync if we've drifted behind
    if (this._next < now + 0.01) this._next = now + 0.06;
    src.start(this._next);
    this._next += frameLen / this._ctx.sampleRate;
  }

  // Feed a raw ArrayBuffer/Buffer of f32le bytes (binary egress path)
  feedBinaryBuffer(arrayBuffer) {
    const float32 = new Float32Array(arrayBuffer.buffer ?? arrayBuffer,
                                      arrayBuffer.byteOffset ?? 0,
                                      arrayBuffer.byteLength / 4);
    this.feedSamples(float32);
  }

  get track() { return this._dest.stream.getAudioTracks()[0]; }

  stop() {
    try { this._ctx.close(); } catch {}
  }
}

// Active per-window audio sessions: sessionId -> SidecarAudioPlayer
const _activePlayers = new Map();

// Listen for binary PCM frames (fast path — raw f32le Buffer from TCP socket)
ipcRenderer.on('app-audio-frame-binary', (event, { sessionId, pcmBuffer }) => {
  const player = _activePlayers.get(sessionId);
  if (!player) return;
  // pcmBuffer is a Node.js Buffer; we need an ArrayBuffer view
  const buf = pcmBuffer.buffer.slice(pcmBuffer.byteOffset, pcmBuffer.byteOffset + pcmBuffer.byteLength);
  player.feedBinaryBuffer(buf);
});

// Listen for JSON base64 frames (fallback path when TCP isn't connected yet)
ipcRenderer.on('app-audio-frame', (event, { sessionId, pcmBase64 }) => {
  const player = _activePlayers.get(sessionId);
  if (!player) return;
  const binaryStr = atob(pcmBase64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
  const float32 = new Float32Array(bytes.buffer);
  player.feedSamples(float32);
});

// Capture session ended unexpectedly (app closed, error, etc.)
ipcRenderer.on('app-audio-ended', (event, { sessionId }) => {
  const player = _activePlayers.get(sessionId);
  if (player) { player.stop(); _activePlayers.delete(sessionId); }
});

// ── getDisplayMedia intercept ────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', () => {
  if (!navigator.mediaDevices) return;

  const originalGetDisplayMedia = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);

  // Cache sidecar capability so we only query once per page load
  let _capabilityPromise = null;
  function getSidecarCapability() {
    if (!_capabilityPromise) {
      _capabilityPromise = ipcRenderer.invoke('sidecar-capabilities').catch(() => ({ perAppAudio: 'unsupported', available: false }));
    }
    return _capabilityPromise;
  }

  // Cache app PID once — used for exclude-mode screen captures
  let _appPidPromise = null;
  function getAppPid() {
    if (!_appPidPromise) {
      _appPidPromise = ipcRenderer.invoke('get-app-pid').catch(() => null);
    }
    return _appPidPromise;
  }

  navigator.mediaDevices.getDisplayMedia = async function (constraints) {
    try {
      const sources = await ipcRenderer.invoke('DESKTOP_CAPTURER_GET_SOURCES', { types: ['window', 'screen'] });
      if (!sources || sources.length === 0) return originalGetDisplayMedia(constraints);

      // ── Build picker overlay ──────────────────────────────────────────────
      const overlayId = '__sharkord_screenshare_picker';
      document.getElementById(overlayId)?.remove();

      const overlay = document.createElement('div');
      overlay.id = overlayId;
      Object.assign(overlay.style, {
        position: 'fixed', zIndex: '99999999', inset: '0',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.6)', color: '#fff', fontFamily: 'sans-serif'
      });

      const card = document.createElement('div');
      Object.assign(card.style, {
        width: '900px', maxWidth: '95%', maxHeight: '85vh', overflowY: 'auto',
        background: '#111', borderRadius: '8px', padding: '14px',
        boxSizing: 'border-box', border: '1px solid rgba(255,255,255,0.06)'
      });

      const title = document.createElement('div');
      title.textContent = 'Choose a screen or window to share';
      Object.assign(title.style, { fontSize: '18px', marginBottom: '12px' });

      // ── Audio toggle ──────────────────────────────────────────────────────
      const AUDIO_PREF_KEY = '__sharkord_screenshare_audio';
      let shareAudio = localStorage.getItem(AUDIO_PREF_KEY) === 'true';

      const audioRow = document.createElement('div');
      Object.assign(audioRow.style, {
        display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px',
        padding: '10px 12px', background: '#1a1a1a', borderRadius: '6px',
        border: '1px solid rgba(255,255,255,0.07)', cursor: 'pointer', userSelect: 'none'
      });

      const speakerIcon = document.createElement('div');
      speakerIcon.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
        <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
      </svg>`;
      Object.assign(speakerIcon.style, { display: 'flex', alignItems: 'center', color: '#888', flexShrink: '0', pointerEvents: 'none' });

      const toggleTrack = document.createElement('div');
      Object.assign(toggleTrack.style, {
        position: 'relative', width: '40px', height: '22px', borderRadius: '11px',
        background: '#444', flexShrink: '0', transition: 'background 0.2s', pointerEvents: 'none'
      });
      const toggleThumb = document.createElement('div');
      Object.assign(toggleThumb.style, {
        position: 'absolute', top: '3px', left: '3px', width: '16px', height: '16px',
        borderRadius: '50%', background: '#fff', transition: 'left 0.2s'
      });
      toggleTrack.appendChild(toggleThumb);

      const audioLabel = document.createElement('div');
      Object.assign(audioLabel.style, { fontSize: '14px', color: '#ccc', flexGrow: '1', pointerEvents: 'none' });
      audioLabel.textContent = 'Share audio';

      // Subtitle: describes which audio mode will be used depending on source type
      const audioNote = document.createElement('div');
      Object.assign(audioNote.style, { fontSize: '11px', color: '#666', pointerEvents: 'none' });
      audioNote.textContent = 'Per-window on Windows · System audio on full screen';

      function updateToggle() {
        toggleTrack.style.background = shareAudio ? '#4e0073' : '#444';
        toggleThumb.style.left       = shareAudio ? '21px'   : '3px';
        speakerIcon.style.color      = shareAudio ? '#4e0073' : '#888';
        audioLabel.style.color       = shareAudio ? '#fff'   : '#ccc';
      }
      audioRow.onclick = () => { shareAudio = !shareAudio; localStorage.setItem(AUDIO_PREF_KEY, shareAudio); updateToggle(); };
      audioRow.append(speakerIcon, toggleTrack, audioLabel, audioNote);
      updateToggle();

      // ── Source grid ───────────────────────────────────────────────────────
      const grid = document.createElement('div');
      Object.assign(grid.style, {
        display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '12px'
      });

      let pickerClosed = false;
      const thumbIntervals = [];

      async function refreshThumbnails() {
        if (pickerClosed) return;
        try {
          const updated = await ipcRenderer.invoke('DESKTOP_CAPTURER_GET_SOURCES', { types: ['window', 'screen'] });
          updated.forEach((src, i) => {
            const item = grid.children[i];
            const thumb = item?.querySelector('.src-thumb');
            if (thumb && src.thumbnail) thumb.style.backgroundImage = `url(${src.thumbnail})`;
          });
        } catch {}
      }

      function cleanupPicker() {
        pickerClosed = true;
        thumbIntervals.forEach(clearInterval);
        thumbIntervals.length = 0;
        grid.querySelectorAll('.src-thumb').forEach(t => { t.style.backgroundImage = ''; });
      }

      for (const src of sources) {
        const isScreen = src.id.startsWith('screen:');

        const item = document.createElement('button');
        item.type = 'button';
        Object.assign(item.style, {
          display: 'flex', flexDirection: 'column', alignItems: 'stretch',
          background: '#222', border: '1px solid rgba(255,255,255,0.05)',
          padding: '8px', borderRadius: '6px', cursor: 'pointer', color: '#fff', textAlign: 'left'
        });

        const thumb = document.createElement('div');
        thumb.className = 'src-thumb';
        Object.assign(thumb.style, {
          height: '120px', marginBottom: '8px', background: '#333', borderRadius: '4px',
          backgroundSize: 'cover', backgroundPosition: 'center'
        });
        if (src.thumbnail) thumb.style.backgroundImage = `url(${src.thumbnail})`;

        const name = document.createElement('div');
        name.textContent = src.name || `Source ${src.id}`;
        Object.assign(name.style, { fontSize: '13px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' });

        // Badge for window vs screen
        const badge = document.createElement('div');
        badge.textContent = isScreen ? '🖥 Screen' : '🪟 Window';
        Object.assign(badge.style, { fontSize: '10px', color: '#888', marginTop: '3px' });

        item.append(thumb, name, badge);
        grid.appendChild(item);
      }

      thumbIntervals.push(setInterval(refreshThumbnails, 5000));

      // ── Cancel button ─────────────────────────────────────────────────────
      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = 'Cancel';
      Object.assign(cancelBtn.style, {
        marginTop: '12px', padding: '8px 12px', background: '#333',
        border: '1px solid rgba(255,255,255,0.06)', color: '#fff', borderRadius: '6px', cursor: 'pointer'
      });

      card.append(title, audioRow, grid, cancelBtn);
      overlay.appendChild(card);
      document.documentElement.appendChild(overlay);

      // ── Pick resolution ───────────────────────────────────────────────────
      return new Promise((resolve, reject) => {

        Array.from(grid.children).forEach((item, i) => {
          const src = sources[i];
          const isScreen = src.id.startsWith('screen:');

          item.onclick = async () => {
            cleanupPicker();
            overlay.remove();

            const captureAudio = shareAudio;

            try {
              // For both window and screen sources: Electron provides video only,
              // we attach audio separately via the sidecar.
              await ipcRenderer.invoke('SCREENSHARE_SET_PENDING', {
                sourceId: src.id,
                shareAudio: false, // sidecar always handles audio now
                isScreen
              });

              const stream = await originalGetDisplayMedia({ video: true, audio: false });

              if (captureAudio) {
                // ── Audio via sidecar ─────────────────────────────────────
                const caps = await getSidecarCapability();
                if (caps.perAppAudio === 'supported') {
                  try {
                    // Screen share: exclude the client process from capture
                    // Window share: include only the target window's process
                    const sidecarParams = isScreen
                      ? { excludePid: await getAppPid() }
                      : { sourceId: src.id };

                    const session = await ipcRenderer.invoke('sidecar-audio-start', sidecarParams);
                    const player = new SidecarAudioPlayer(session.sampleRate || 48000);
                    _activePlayers.set(session.sessionId, player);

                    const combinedStream = new MediaStream([
                      ...stream.getVideoTracks(),
                      player.track
                    ]);

                    stream.getVideoTracks()[0]?.addEventListener('ended', () => {
                      ipcRenderer.invoke('sidecar-audio-stop', session.sessionId).catch(() => {});
                      player.stop();
                      _activePlayers.delete(session.sessionId);
                    });

                    resolve(combinedStream);
                    return;
                  } catch (sidecarErr) {
                    console.warn('[sweetshark] sidecar audio failed, falling back to video-only:', sidecarErr);
                  }
                }
              }

              resolve(stream);

            } catch (err) {
              // If audio capture failed, retry video-only so screenshare still works
              if (captureAudio) {
                try {
                  await ipcRenderer.invoke('SCREENSHARE_SET_PENDING', { sourceId: src.id, shareAudio: false, isScreen });
                  const fallbackStream = await originalGetDisplayMedia({ video: true, audio: false });
                  resolve(fallbackStream);
                } catch (retryErr) { reject(retryErr); }
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

        const mo = new MutationObserver(() => {
          if (!document.contains(overlay)) { cleanupPicker(); mo.disconnect(); }
        });
        mo.observe(document.documentElement, { childList: true, subtree: true });
      });

    } catch (err) {
      return originalGetDisplayMedia(constraints);
    }
  };
});
