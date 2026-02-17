# Sweetshark Client

<img width="1419" height="929" alt="{83BB376E-B8CE-4FA8-82BB-85720CD0835D}" src="https://github.com/user-attachments/assets/e094fd04-922a-46a2-a820-d08e74387a8a" />

# DISCLAIMER: ALL OF THIS IS AI GENERATED. I TAKE NO RESPONSIBILITY FOR ANYTHING THAT HAPPENS WHEN YOU USE THIS CLIENT.
# USE AT YOUR OWN RISK.

**ps. I only tested this on windows, I have no idea if it works on any other platform.**

# A multi-server desktop client for [Sharkord](https://github.com/Sharkord/sharkord) built with Electron. Manage and connect to multiple Sharkord servers simultaneously with a familiar interface.

## Features

- 🖥️ **Multi-Server Support** - Connect to multiple Sharkord servers and switch between them seamlessly
- 🎨 **Custom Server Icons** - Upload custom icons for each server or use default icons
- 🔄 **Drag-and-Drop Reordering** - Easily reorder your servers by dragging them in the sidebar
- 🎯 **Server Management** - Right-click servers to rename, change icons, refresh, or remove them
- 🔧 **Keep Loaded Option** - Toggle whether servers stay loaded in memory when inactive
- 📺 **Screen Sharing** - Built-in screen capture with a custom picker for sharing your screen or windows
- 🔒 **Permission Control** - Configure app-wide permissions for notifications, screen capture, microphone, and camera
- 💾 **Persistent Storage** - All your servers and settings are saved automatically

## Current know issues

- Can't copy invite links from server admin page.
- Streaming with audio is broken and can't be fixed in electron with the skills and tools I have available to me.
- Probably many many more things.

## Requirements

- **Node.js** 16.x or higher
- **npm** or **yarn** package manager
- Windows, macOS, or Linux (only tested on Windows)

## Installation

### Build from Source

1. **Clone the repository**
   ```bash
   git clone https://github.com/yourusername/sweetshark-client.git
   cd sweetshark-client
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Run in development mode**
   ```bash
   npm start
   ```

## Building

### Build for Windows

```bash
# Build installer and portable version
npm run build:win

# Build only portable version
npm run build:win-portable
```

The built files will be in the `dist` folder:
- **NSIS Installer**: `dist/Sweetshark Client Setup X.X.X.exe`
- **Portable**: `dist/Sweetshark Client X.X.X.exe`

## Usage

### First Launch

1. When you first launch Sweetshark Client, you'll be prompted to configure app permissions
2. Choose which permissions you want to grant (notifications, screen capture, microphone, camera)
3. These settings CAN NOT be changed later, it's more of a disclaimer of what permissions the app will use.

### Adding a Server

1. Click the **+** button in the sidebar
2. Fill in the server details:
   - **Server Name**: A friendly name for your server (e.g., "My Gaming Server")
   - **Server URL**: The full URL of your Sharkord server (e.g., `http://localhost:4991` or `https://myserver.com`)
   - **Custom Icon** (optional): Upload an image to use as the server icon
3. Click **Add Server**

The client will automatically handle Sharkord invite links - just paste the full URL including the invite code.

### Managing Servers

**Switch Servers**: Click on any server icon in the sidebar

**Reorder Servers**: Drag and drop server icons to reorder them

**Server Context Menu** (Right-click on a server icon):
- **Rename Server** - Change the server's display name
- **Change Icon** - Upload a new icon or remove the current one
- **Refresh** - Reload the server's page
- **Keep Server Loaded** - Toggle whether the server stays loaded in memory when inactive (enabled by default)
- **Remove Server** - Delete the server from your list

### Screen Sharing

When a Sharkord server requests screen sharing:
1. A custom picker will appear showing all available screens and windows
2. Thumbnails update every 5 seconds
3. Click on the screen/window you want to share
4. Click **Cancel** to abort the screen share

### Stored Data Location

Server data and settings are stored in:
- **Windows**: `%APPDATA%\sweetshark-client\`

### What's Stored

- `config.json` - App settings and permissions
- `server-icons/` - Custom server icons
- Server list and configurations

## Technical Details

### Built With

- **Electron** v28.0.0 - Desktop application framework
- **electron-store** - Persistent data storage
- **electron-builder** - Application packaging

## Troubleshooting

### Server won't load
- Verify the server URL is correct and includes `http://` or `https://`
- Check that the Sharkord server is running and accessible
- Try refreshing the server (right-click server icon → Refresh)

### Screen sharing doesn't work
- Make sure Screen Capture permission was enabled
- Try restarting the application

### Icons not displaying
- Supported formats: PNG, JPG, JPEG, GIF, WEBP
- Try using a smaller image file

## Development

### Prerequisites for Development

```bash
npm install
```

### Development Mode

```bash
npm start
```

This will launch the app in development mode with hot reload.

### Project Dependencies

**Production:**
- electron-store ^8.1.0

**Development:**
- electron ^28.0.0
- electron-builder ^24.9.1

## License

**NONE - IT'S ALL AI GENERATED.**

This project is provided as-is with no warranty or license. Use at your own risk.

## Credits

- Built with [Electron](https://www.electronjs.org/)
- Created for [Sharkord](https://github.com/Sharkord/sharkord) - A lightweight, self-hosted real-time communication platform
- Vibe-coded by Sweets-omg with AI.
