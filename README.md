# Sweetshark Sharkord Client

# DISCLAIMER: ALL OF THIS IS AI GENERATED. I TAKE NO RESPONSIBILITY FOR ANYTHING THAT HAPPENS WHEN YOU USE THIS CLIENT.

# USE AT YOUR OWN RISK.

ps. I didn't even read this readme, so I have no idea what's in it.

A multi-server Electron client for Sharkord with Discord-inspired UI.

## Features

✨ **Multi-Server Support** - Connect to multiple Sharkord servers and switch between them instantly  
🔒 **Session Management** - Separate cookies and login sessions for each server  
💾 **Credential Saving** - Automatically saves login credentials when you check "save credentials"  
🎨 **Discord-Style UI** - Familiar sidebar navigation with server icons  
🚀 **Full Feature Support** - File uploads, voice chat, video chat, screen sharing all work seamlessly

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

## Troubleshooting

### Server won't load
- Make sure the URL includes `http://` or `https://`
- Verify the Sharkord server is running
- Check your firewall settings

### Voice/Video not working
- Ensure your Sharkord server ports are properly configured
- Check microphone/camera permissions in your system settings
- Try restarting the client

### Screen sharing shows black screen
- The client now includes screen sharing support via Electron's desktopCapturer
- It will automatically select your first available screen/window when you click share
- If you want to pick a specific window/screen, you can use Sharkord in a regular browser
- On macOS: Grant screen recording permission in System Preferences > Security & Privacy > Screen Recording
- On Linux: May need `xdg-desktop-portal` installed for screen capture

### Screen sharing shows "Not supported"
- Make sure you're using the latest version of the client
- Restart the app after adding a server
- If issues persist, try using Sharkord in Chrome/Firefox where you get a full screen picker

### Login not saving
- Make sure to check "save credentials" on the Sharkord login page
- Sessions are preserved per server partition

## Technical Details

- Built with Electron 28
- Uses BrowserView for embedded server instances
- Session partitioning for cookie isolation
- electron-store for persistent data

## License

MIT

## Credits

Built for [Sharkord](https://github.com/Sharkord/sharkord) - A lightweight, self-hosted communication platform.
