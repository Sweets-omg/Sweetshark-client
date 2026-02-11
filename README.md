# Sharkord Client

DISCLAIMER: THIS IS ALL MADE BY AI, I TAKE NO RESPONSIBILITY IF YOU DECIDE TO USE IT.

## USE AT YOUR OWN RISK.

## A multi-server Electron client for Sharkord with Discord-inspired UI.

## Prerequisites

- Node.js (v18 or higher)
- npm or yarn

## Installation & Building

### 1. Install Dependencies

```bash
npm install
```

### 2. Run in Development Mode

```bash
npm start
```

### 3. Build Executables

Build for your current platform:

**Windows:**
```bash
npm run build:win
```

**macOS:**
```bash
npm run build:mac
```

**Linux:**
```bash
npm run build:linux
```

**All platforms:**
```bash
npm run build:all
```

Builds will be located in the `dist/` folder.

## Usage

### Adding a Server

1. Click the **+** button at the bottom of the sidebar
2. Enter your server name (e.g., "My Sharkord Server")
3. Enter the server URL (e.g., `http://localhost:4991`)
4. Click "Add Server"

### Switching Between Servers

Simply click on a server icon in the sidebar to switch to it.

### Removing a Server

Right-click on a server icon and select "Remove Server"

## How It Works

- **Isolated Sessions**: Each server runs in its own isolated session/partition, so your cookies and login data don't mix
- **Persistent Storage**: Server list and credentials are stored locally using electron-store
- **Native WebRTC**: All Sharkord features (voice, video, screen sharing) work natively through embedded webviews

Built for [Sharkord](https://github.com/Sharkord/sharkord) - A lightweight, self-hosted communication platform.
