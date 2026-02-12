let servers = [];
let activeServerId = null;
let pendingServerId = null;
let draggedServerId = null;
let serverIcons = new Map();
let overlayActive = false;

// Security: Constants
const MAX_SERVER_NAME_LENGTH = 100;
const MAX_ICON_SIZE = 5 * 1024 * 1024; // 5MB
const ALLOWED_URL_PROTOCOLS = ['http:', 'https:'];

// Security: Validate URL
function isValidUrl(urlString) {
  try {
    const url = new URL(urlString);
    return ALLOWED_URL_PROTOCOLS.includes(url.protocol);
  } catch (e) {
    return false;
  }
}

// Security: Validate server name
function isValidServerName(name) {
  if (typeof name !== 'string') return false;
  if (name.length === 0 || name.length > MAX_SERVER_NAME_LENGTH) return false;
  // Prevent path traversal attempts
  if (name.includes('..') || name.includes('/') || name.includes('\\')) return false;
  return true;
}

// Security: Sanitize HTML to prevent XSS
function sanitizeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();
  window.electronAPI.getServers();
});

// Setup event listeners
function setupEventListeners() {
  // Listen for server updates from main process
  window.electronAPI.onServersLoaded(async (loadedServers) => {
    servers = loadedServers;
    
    // Load custom icons
    for (const server of servers) {
      if (server.icon && !serverIcons.has(server.id)) {
        try {
          const iconData = await window.electronAPI.loadIcon(server.icon);
          if (iconData) {
            serverIcons.set(server.id, iconData);
          }
        } catch (error) {
          console.error('Failed to load icon:', error);
        }
      }
    }
    
    renderServers();
    
    // Reattach add server button listener after render
    const addBtn = document.getElementById('addServerBtn');
    if (addBtn) {
      addBtn.onclick = openAddServerModal;
    }
    
    // Hide welcome screen if there are servers
    if (servers.length > 0) {
      document.getElementById('welcomeScreen').classList.add('hidden');
      
      // Auto-select first server if none selected
      if (!activeServerId && servers.length > 0) {
        switchServer(servers[0].id);
      }
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
      if (servers.length > 0) {
        switchServer(servers[0].id);
      }
    }
  });

  // Listen for server errors
  window.electronAPI.onServerError((errorMessage) => {
    alert(errorMessage);
  });

  // Initial add server button listener
  const addBtn = document.getElementById('addServerBtn');
  if (addBtn) {
    addBtn.onclick = openAddServerModal;
  }

  // Close modals on outside click
  document.getElementById('addServerModal').addEventListener('click', (e) => {
    if (e.target.id === 'addServerModal') {
      closeAddServerModal();
    }
  });
  
  document.getElementById('renameServerModal').addEventListener('click', (e) => {
    if (e.target.id === 'renameServerModal') {
      closeRenameModal();
    }
  });
  
  document.getElementById('changeIconModal').addEventListener('click', (e) => {
    if (e.target.id === 'changeIconModal') {
      closeChangeIconModal();
    }
  });

  // Native context menu callbacks from main process
  window.electronAPI.onCtxRenameServer((id) => openRenameModal(id));
  window.electronAPI.onCtxChangeIconServer((id) => openChangeIconModal(id));
  window.electronAPI.onCtxRefreshServer((id) => window.electronAPI.refreshServer(id));
  window.electronAPI.onCtxRemoveServer((id) => {
    if (confirm('Are you sure you want to remove this server?')) {
      window.electronAPI.removeServer(id);
    }
  });

  // Prevent default context menu on non-server areas
  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
  });
}

// Render server icons
function renderServers() {
  const serverList = document.getElementById('serverList');
  const addServerBtn = document.getElementById('addServerBtn');
  
  // Clear existing servers (except add button)
  while (serverList.firstChild && serverList.firstChild !== addServerBtn) {
    serverList.removeChild(serverList.firstChild);
  }

  // Add server icons
  servers.forEach(server => {
    const serverIcon = createServerIcon(server);
    serverList.insertBefore(serverIcon, addServerBtn);
  });
}

// Create server icon element
function createServerIcon(server) {
  const icon = document.createElement('div');
  icon.className = 'server-icon';
  icon.dataset.serverId = server.id;
  icon.draggable = true;
  
  if (server.id === activeServerId) {
    icon.classList.add('active');
  }

  // Use custom icon if available, otherwise use first letter
  if (serverIcons.has(server.id)) {
    const img = document.createElement('img');
    img.src = serverIcons.get(server.id);
    img.alt = sanitizeHTML(server.name);
    icon.appendChild(img);
  } else {
    // Security: Sanitize text content
    const initial = sanitizeHTML(server.name.charAt(0).toUpperCase());
    icon.textContent = initial;
  }

  // Add tooltip
  const tooltip = document.createElement('span');
  tooltip.className = 'server-name';
  // Security: Sanitize tooltip text
  tooltip.textContent = server.name;
  icon.appendChild(tooltip);

  // Click to switch server
  icon.addEventListener('click', () => {
    switchServer(server.id);
  });

  // Right click for native context menu
  icon.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    window.electronAPI.showContextMenu(server.id);
  });
  
  // Drag and drop events
  icon.addEventListener('dragstart', (e) => {
    draggedServerId = server.id;
    icon.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  
  icon.addEventListener('dragend', (e) => {
    icon.classList.remove('dragging');
    draggedServerId = null;
  });
  
  icon.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (draggedServerId && draggedServerId !== server.id) {
      icon.classList.add('drag-over');
    }
  });
  
  icon.addEventListener('dragleave', (e) => {
    icon.classList.remove('drag-over');
  });
  
  icon.addEventListener('drop', (e) => {
    e.preventDefault();
    icon.classList.remove('drag-over');
    
    if (draggedServerId && draggedServerId !== server.id) {
      reorderServers(draggedServerId, server.id);
    }
  });

  return icon;
}

// Switch to a server
function switchServer(serverId) {
  activeServerId = serverId;
  
  // Update UI
  document.querySelectorAll('.server-icon').forEach(icon => {
    icon.classList.remove('active');
  });
  
  const activeIcon = document.querySelector(`[data-server-id="${serverId}"]`);
  if (activeIcon) {
    activeIcon.classList.add('active');
  }

  // Hide welcome screen
  document.getElementById('welcomeScreen').classList.add('hidden');

  // Tell main process to switch
  window.electronAPI.switchServer(serverId);
}

// Modal functions
function openAddServerModal() {
  if (!overlayActive) {
    overlayActive = true;
    try { window.electronAPI.hideView(); } catch(e) {}
  }
  document.getElementById('addServerModal').classList.add('active');
  document.getElementById('serverName').focus();
}

function closeAddServerModal() {
  document.getElementById('addServerModal').classList.remove('active');
  document.getElementById('serverName').value = '';
  document.getElementById('serverUrl').value = '';
  document.getElementById('serverIcon').value = '';
  
  // Only restore view if no other overlays are open
  if (overlayActive && !isAnyOverlayOpen()) {
    overlayActive = false;
    try { window.electronAPI.showView(); } catch(e) {}
  }
}

async function addServer() {
  const name = document.getElementById('serverName').value.trim();
  const url = document.getElementById('serverUrl').value.trim();
  const iconInput = document.getElementById('serverIcon');

  // Security: Client-side validation
  if (!name || !url) {
    alert('Please fill in all required fields');
    return;
  }

  if (!isValidServerName(name)) {
    alert('Invalid server name. Name must be 1-100 characters and cannot contain special path characters.');
    return;
  }

  if (!isValidUrl(url)) {
    alert('Please enter a valid HTTP or HTTPS URL (e.g., http://localhost:4991)');
    return;
  }

  const serverData = { name, url };
  
  // Handle custom icon if provided
  if (iconInput.files && iconInput.files[0]) {
    const file = iconInput.files[0];
    
    // Security: Validate file size
    if (file.size > MAX_ICON_SIZE) {
      alert('Icon file is too large. Maximum size is 5MB.');
      return;
    }

    // Security: Validate file type
    if (!file.type.startsWith('image/')) {
      alert('Please select a valid image file.');
      return;
    }
    
    const reader = new FileReader();
    
    reader.onload = (e) => {
      serverData.iconData = e.target.result;
      window.electronAPI.addServer(serverData);
      closeAddServerModal();
    };
    
    reader.onerror = () => {
      alert('Failed to read icon file.');
    };
    
    reader.readAsDataURL(file);
  } else {
    window.electronAPI.addServer(serverData);
    closeAddServerModal();
  }
}

// Helper function to check if any overlay is currently open
function isAnyOverlayOpen() {
  return document.getElementById('addServerModal').classList.contains('active') ||
         document.getElementById('renameServerModal').classList.contains('active') ||
         document.getElementById('changeIconModal').classList.contains('active');
}

// Rename server functions
function openRenameModal(serverId) {
  const server = servers.find(s => s.id === serverId);
  if (!server) return;
  
  pendingServerId = serverId;
  
  if (!overlayActive) {
    overlayActive = true;
    try { window.electronAPI.hideView(); } catch(e) {}
  }
  document.getElementById('renameServerModal').classList.add('active');
  document.getElementById('newServerName').value = server.name;
  document.getElementById('newServerName').focus();
  document.getElementById('newServerName').select();
}

function closeRenameModal() {
  document.getElementById('renameServerModal').classList.remove('active');
  document.getElementById('newServerName').value = '';
  pendingServerId = null;
  
  // Only restore view if no other overlays are open
  if (overlayActive && !isAnyOverlayOpen()) {
    overlayActive = false;
    try { window.electronAPI.showView(); } catch(e) {}
  }
}

function renameServer() {
  const newName = document.getElementById('newServerName').value.trim();
  
  // Security: Client-side validation
  if (!newName) {
    alert('Please enter a server name');
    return;
  }

  if (!isValidServerName(newName)) {
    alert('Invalid server name. Name must be 1-100 characters and cannot contain special path characters.');
    return;
  }
  
  if (pendingServerId) {
    window.electronAPI.updateServer(pendingServerId, { name: newName });
  }
  
  closeRenameModal();
}

// Change icon functions
function openChangeIconModal(serverId) {
  pendingServerId = serverId;
  
  if (!overlayActive) {
    overlayActive = true;
    try { window.electronAPI.hideView(); } catch(e) {}
  }
  document.getElementById('changeIconModal').classList.add('active');
  document.getElementById('newServerIcon').value = '';
}

function closeChangeIconModal() {
  document.getElementById('changeIconModal').classList.remove('active');
  document.getElementById('newServerIcon').value = '';
  pendingServerId = null;
  
  // Only restore view if no other overlays are open
  if (overlayActive && !isAnyOverlayOpen()) {
    overlayActive = false;
    try { window.electronAPI.showView(); } catch(e) {}
  }
}

async function changeIcon() {
  const iconInput = document.getElementById('newServerIcon');
  const targetId = pendingServerId;

  if (!iconInput.files || !iconInput.files[0]) {
    // No file selected - remove the existing icon
    if (targetId) {
      serverIcons.delete(targetId);
      window.electronAPI.updateServer(targetId, { removeIcon: true });
    }
    closeChangeIconModal();
    return;
  }
  
  const file = iconInput.files[0];
  
  // Security: Validate file size
  if (file.size > MAX_ICON_SIZE) {
    alert('Icon file is too large. Maximum size is 5MB.');
    return;
  }

  // Security: Validate file type
  if (!file.type.startsWith('image/')) {
    alert('Please select a valid image file.');
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

  reader.onerror = () => {
    alert('Failed to read icon file.');
  };
  
  reader.readAsDataURL(file);
}

// Reorder servers
function reorderServers(draggedId, targetId) {
  const draggedIndex = servers.findIndex(s => s.id === draggedId);
  const targetIndex = servers.findIndex(s => s.id === targetId);
  
  if (draggedIndex === -1 || targetIndex === -1) return;
  
  const newOrder = [...servers];
  const [removed] = newOrder.splice(draggedIndex, 1);
  newOrder.splice(targetIndex, 0, removed);
  
  window.electronAPI.reorderServers(newOrder);
}

// Handle Enter key in modals
document.addEventListener('keydown', (e) => {
  const addModal = document.getElementById('addServerModal');
  const renameModal = document.getElementById('renameServerModal');
  const iconModal = document.getElementById('changeIconModal');
  
  if (addModal.classList.contains('active') && e.key === 'Enter') {
    e.preventDefault();
    addServer();
  } else if (addModal.classList.contains('active') && e.key === 'Escape') {
    e.preventDefault();
    closeAddServerModal();
  } else if (renameModal.classList.contains('active') && e.key === 'Enter') {
    e.preventDefault();
    renameServer();
  } else if (renameModal.classList.contains('active') && e.key === 'Escape') {
    e.preventDefault();
    closeRenameModal();
  } else if (iconModal.classList.contains('active') && e.key === 'Escape') {
    e.preventDefault();
    closeChangeIconModal();
  }
});
