let servers = [];
let activeServerId = null;
let contextMenuTargetId = null;

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();
  window.electronAPI.getServers();
});

// Setup event listeners
function setupEventListeners() {
  // Listen for server updates from main process
  window.electronAPI.onServersLoaded((loadedServers) => {
    servers = loadedServers;
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
    if (activeServerId === serverId) {
      activeServerId = null;
      if (servers.length > 0) {
        switchServer(servers[0].id);
      }
    }
  });

  // Initial add server button listener
  const addBtn = document.getElementById('addServerBtn');
  if (addBtn) {
    addBtn.onclick = openAddServerModal;
  }

  // Close modal on outside click
  document.getElementById('addServerModal').addEventListener('click', (e) => {
    if (e.target.id === 'addServerModal') {
      closeAddServerModal();
    }
  });

  // Hide context menu on click outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.context-menu')) {
      closeContextMenu();
    }
  });

  // Prevent default context menu
  document.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('.server-icon:not(.add-server)')) {
      e.preventDefault();
    }
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
  
  if (server.id === activeServerId) {
    icon.classList.add('active');
  }

  // Use first letter of server name as icon
  const initial = server.name.charAt(0).toUpperCase();
  icon.textContent = initial;

  // Add tooltip
  const tooltip = document.createElement('span');
  tooltip.className = 'server-name';
  tooltip.textContent = server.name;
  icon.appendChild(tooltip);

  // Click to switch server
  icon.addEventListener('click', () => {
    switchServer(server.id);
  });

  // Right click for context menu
  icon.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showContextMenu(e, server.id);
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
  document.getElementById('addServerModal').classList.add('active');
  document.getElementById('serverName').focus();
}

function closeAddServerModal() {
  document.getElementById('addServerModal').classList.remove('active');
  document.getElementById('serverName').value = '';
  document.getElementById('serverUrl').value = '';
}

function addServer() {
  const name = document.getElementById('serverName').value.trim();
  const url = document.getElementById('serverUrl').value.trim();

  if (!name || !url) {
    alert('Please fill in all fields');
    return;
  }

  // Basic URL validation
  try {
    new URL(url);
  } catch (e) {
    alert('Please enter a valid URL (e.g., http://localhost:4991)');
    return;
  }

  window.electronAPI.addServer({ name, url });
  closeAddServerModal();
}

// Context menu functions
function showContextMenu(event, serverId) {
  const menu = document.getElementById('contextMenu');
  contextMenuTargetId = serverId;
  
  menu.style.left = event.pageX + 'px';
  menu.style.top = event.pageY + 'px';
  menu.classList.add('active');
}

function closeContextMenu() {
  document.getElementById('contextMenu').classList.remove('active');
  contextMenuTargetId = null;
}

function removeServerFromMenu() {
  if (contextMenuTargetId) {
    if (confirm('Are you sure you want to remove this server?')) {
      window.electronAPI.removeServer(contextMenuTargetId);
    }
  }
  closeContextMenu();
}

// Handle Enter key in modal
document.addEventListener('keydown', (e) => {
  const modal = document.getElementById('addServerModal');
  if (modal.classList.contains('active') && e.key === 'Enter') {
    addServer();
  } else if (modal.classList.contains('active') && e.key === 'Escape') {
    closeAddServerModal();
  }
});
