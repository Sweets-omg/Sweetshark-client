let servers = [];
let activeServerId = null;
let pendingServerId = null;
let draggedServerId = null;
let serverIcons = new Map();
let overlayActive = false;

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();
  window.electronAPI.getServers();
});

// Setup event listeners
function setupEventListeners() {
  window.electronAPI.onServersLoaded(async (loadedServers) => {
    servers = loadedServers;

    for (const server of servers) {
      if (server.icon && !serverIcons.has(server.id)) {
        const iconData = await window.electronAPI.loadIcon(server.icon);
        if (iconData) serverIcons.set(server.id, iconData);
      }
    }

    renderServers();

    const addBtn = document.getElementById('addServerBtn');
    if (addBtn) addBtn.onclick = openAddServerModal;

    if (servers.length > 0) {
      document.getElementById('welcomeScreen').classList.add('hidden');
      if (!activeServerId) switchServer(servers[0].id);
    } else {
      document.getElementById('welcomeScreen').classList.remove('hidden');
    }
  });

  window.electronAPI.onServerAdded((server) => {
    console.log('Server added:', server);
    switchServer(server.id);
  });

  window.electronAPI.onServerRemoved((serverId) => {
    console.log('Server removed:', serverId);
    serverIcons.delete(serverId);
    if (activeServerId === serverId) {
      activeServerId = null;
      if (servers.length > 0) switchServer(servers[0].id);
    }
  });

  // Show permissions setup on first launch
  window.electronAPI.onShowPermissionsSetup(() => {
    openPermissionsModal();
  });

  // Loading screen handlers
  window.electronAPI.onShowLoading(() => {
    document.getElementById('loadingScreen').classList.add('active');
  });
  window.electronAPI.onHideLoading(() => {
    document.getElementById('loadingScreen').classList.remove('active');
  });

  const addBtn = document.getElementById('addServerBtn');
  if (addBtn) addBtn.onclick = openAddServerModal;

  document.getElementById('addServerModal').addEventListener('click', (e) => {
    if (e.target.id === 'addServerModal') closeAddServerModal();
  });
  document.getElementById('renameServerModal').addEventListener('click', (e) => {
    if (e.target.id === 'renameServerModal') closeRenameModal();
  });
  document.getElementById('changeIconModal').addEventListener('click', (e) => {
    if (e.target.id === 'changeIconModal') closeChangeIconModal();
  });

  window.electronAPI.onCtxRenameServer((id)    => openRenameModal(id));
  window.electronAPI.onCtxChangeIconServer((id) => openChangeIconModal(id));
  window.electronAPI.onCtxRefreshServer((id)    => window.electronAPI.refreshServer(id));
  window.electronAPI.onCtxRemoveServer((id)     => {
    if (confirm('Are you sure you want to remove this server?')) {
      window.electronAPI.removeServer(id);
    }
  });
  window.electronAPI.onCtxToggleKeepLoaded((id) => {
    window.electronAPI.toggleKeepLoaded(id);
  });

  document.addEventListener('contextmenu', (e) => e.preventDefault());
}

// ── Permissions Modal ─────────────────────────────────────────────────────────

async function openPermissionsModal() {
  // Pre-fill with any previously stored values (e.g. if somehow triggered again)
  const result = await window.electronAPI.getPermissions();
  const perms = result.permissions;
  document.getElementById('perm-notifications').checked  = perms.notifications;
  document.getElementById('perm-screenCapture').checked  = perms.screenCapture;
  document.getElementById('perm-audio').checked          = perms.audio;
  document.getElementById('perm-video').checked          = perms.video;

  document.getElementById('permissionsModal').classList.add('active');
}

function savePermissions() {
  const permissions = {
    notifications:  document.getElementById('perm-notifications').checked,
    screenCapture:  document.getElementById('perm-screenCapture').checked,
    audio:          document.getElementById('perm-audio').checked,
    video:          document.getElementById('perm-video').checked
  };

  window.electronAPI.setPermissions(permissions);
  document.getElementById('permissionsModal').classList.remove('active');
}

// ── Render ────────────────────────────────────────────────────────────────────

function renderServers() {
  const serverList = document.getElementById('serverList');
  const addServerBtn = document.getElementById('addServerBtn');

  while (serverList.firstChild && serverList.firstChild !== addServerBtn) {
    serverList.removeChild(serverList.firstChild);
  }

  servers.forEach(server => {
    serverList.insertBefore(createServerIcon(server), addServerBtn);
  });
}

function createServerIcon(server) {
  const icon = document.createElement('div');
  icon.className = 'server-icon';
  icon.dataset.serverId = server.id;
  icon.draggable = true;

  if (server.id === activeServerId) icon.classList.add('active');

  if (serverIcons.has(server.id)) {
    const img = document.createElement('img');
    img.src = serverIcons.get(server.id);
    img.alt = server.name;
    icon.appendChild(img);
  } else {
    // Create a text node for the letter instead of using textContent
    const letter = document.createElement('span');
    letter.textContent = server.name.charAt(0).toUpperCase();
    letter.style.pointerEvents = 'none'; // Make sure it doesn't block hover
    icon.appendChild(letter);
  }

  // Always add tooltip after content
  const tooltip = document.createElement('span');
  tooltip.className = 'server-name';
  tooltip.textContent = server.name;
  icon.appendChild(tooltip);

  icon.addEventListener('click',       () => switchServer(server.id));
  icon.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    window.electronAPI.showContextMenu(server.id);
  });

  icon.addEventListener('dragstart', (e) => {
    draggedServerId = server.id;
    icon.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  icon.addEventListener('dragend',   () => { icon.classList.remove('dragging'); draggedServerId = null; });
  icon.addEventListener('dragover',  (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (draggedServerId && draggedServerId !== server.id) icon.classList.add('drag-over');
  });
  icon.addEventListener('dragleave', () => icon.classList.remove('drag-over'));
  icon.addEventListener('drop',      (e) => {
    e.preventDefault();
    icon.classList.remove('drag-over');
    if (draggedServerId && draggedServerId !== server.id) reorderServers(draggedServerId, server.id);
  });

  return icon;
}

// ── Server switching ──────────────────────────────────────────────────────────

function switchServer(serverId) {
  activeServerId = serverId;

  document.querySelectorAll('.server-icon').forEach(i => i.classList.remove('active'));
  const activeIcon = document.querySelector(`[data-server-id="${serverId}"]`);
  if (activeIcon) activeIcon.classList.add('active');

  document.getElementById('welcomeScreen').classList.add('hidden');
  window.electronAPI.switchServer(serverId);
}

// ── Add Server Modal ──────────────────────────────────────────────────────────

function openAddServerModal() {
  if (!overlayActive) { overlayActive = true; try { window.electronAPI.hideView(); } catch(e) {} }
  document.getElementById('addServerModal').classList.add('active');
  document.getElementById('serverName').focus();
}

function closeAddServerModal() {
  document.getElementById('addServerModal').classList.remove('active');
  document.getElementById('serverName').value  = '';
  document.getElementById('serverUrl').value   = '';
  document.getElementById('serverIcon').value  = '';
  if (overlayActive && !isAnyOverlayOpen()) { overlayActive = false; try { window.electronAPI.showView(); } catch(e) {} }
}

async function addServer() {
  const name = document.getElementById('serverName').value.trim();
  let url  = document.getElementById('serverUrl').value.trim();
  const iconInput = document.getElementById('serverIcon');

  if (!name || !url) { alert('Please fill in all required fields'); return; }

  try { new URL(url); } catch (e) {
    alert('Please enter a valid URL (e.g., http://localhost:4991)');
    return;
  }

  // Strip invite parameter from URL for storage
  // The initial load will use the full URL with invite, but stored URL won't have it
  const urlObj = new URL(url);
  const inviteParam = urlObj.searchParams.get('invite');
  const cleanUrl = url.split('?')[0]; // Remove all query parameters for storage

  const serverData = { name, url: cleanUrl, initialUrl: url };

  if (iconInput.files && iconInput.files[0]) {
    const reader = new FileReader();
    reader.onload = (e) => {
      serverData.iconData = e.target.result;
      window.electronAPI.addServer(serverData);
      closeAddServerModal();
    };
    reader.readAsDataURL(iconInput.files[0]);
  } else {
    window.electronAPI.addServer(serverData);
    closeAddServerModal();
  }
}

// ── Rename Modal ──────────────────────────────────────────────────────────────

function openRenameModal(serverId) {
  const server = servers.find(s => s.id === serverId);
  if (!server) return;
  pendingServerId = serverId;
  if (!overlayActive) { overlayActive = true; try { window.electronAPI.hideView(); } catch(e) {} }
  document.getElementById('renameServerModal').classList.add('active');
  const input = document.getElementById('newServerName');
  input.value = server.name;
  input.focus();
  input.select();
}

function closeRenameModal() {
  document.getElementById('renameServerModal').classList.remove('active');
  document.getElementById('newServerName').value = '';
  pendingServerId = null;
  if (overlayActive && !isAnyOverlayOpen()) { overlayActive = false; try { window.electronAPI.showView(); } catch(e) {} }
}

function renameServer() {
  const newName = document.getElementById('newServerName').value.trim();
  if (!newName) { alert('Please enter a server name'); return; }
  if (pendingServerId) window.electronAPI.updateServer(pendingServerId, { name: newName });
  closeRenameModal();
}

// ── Change Icon Modal ─────────────────────────────────────────────────────────

function openChangeIconModal(serverId) {
  pendingServerId = serverId;
  if (!overlayActive) { overlayActive = true; try { window.electronAPI.hideView(); } catch(e) {} }
  document.getElementById('changeIconModal').classList.add('active');
  document.getElementById('newServerIcon').value = '';
}

function closeChangeIconModal() {
  document.getElementById('changeIconModal').classList.remove('active');
  document.getElementById('newServerIcon').value = '';
  pendingServerId = null;
  if (overlayActive && !isAnyOverlayOpen()) { overlayActive = false; try { window.electronAPI.showView(); } catch(e) {} }
}

async function changeIcon() {
  const iconInput = document.getElementById('newServerIcon');
  const targetId  = pendingServerId;

  if (!iconInput.files || !iconInput.files[0]) {
    if (targetId) {
      serverIcons.delete(targetId);
      window.electronAPI.updateServer(targetId, { removeIcon: true });
    }
    closeChangeIconModal();
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    if (targetId) {
      serverIcons.set(targetId, e.target.result);
      window.electronAPI.updateServer(targetId, { iconData: e.target.result });
    }
    closeChangeIconModal();
  };
  reader.readAsDataURL(iconInput.files[0]);
}

// ── Reorder ───────────────────────────────────────────────────────────────────

function reorderServers(draggedId, targetId) {
  const draggedIndex = servers.findIndex(s => s.id === draggedId);
  const targetIndex  = servers.findIndex(s => s.id === targetId);
  if (draggedIndex === -1 || targetIndex === -1) return;

  const newOrder = [...servers];
  const [removed] = newOrder.splice(draggedIndex, 1);
  newOrder.splice(targetIndex, 0, removed);
  window.electronAPI.reorderServers(newOrder);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isAnyOverlayOpen() {
  return document.getElementById('addServerModal').classList.contains('active')    ||
         document.getElementById('renameServerModal').classList.contains('active') ||
         document.getElementById('changeIconModal').classList.contains('active');
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  const addModal    = document.getElementById('addServerModal');
  const renameModal = document.getElementById('renameServerModal');
  const iconModal   = document.getElementById('changeIconModal');

  if      (addModal.classList.contains('active')    && e.key === 'Enter')  addServer();
  else if (addModal.classList.contains('active')    && e.key === 'Escape') closeAddServerModal();
  else if (renameModal.classList.contains('active') && e.key === 'Enter')  renameServer();
  else if (renameModal.classList.contains('active') && e.key === 'Escape') closeRenameModal();
  else if (iconModal.classList.contains('active')   && e.key === 'Escape') closeChangeIconModal();
});
