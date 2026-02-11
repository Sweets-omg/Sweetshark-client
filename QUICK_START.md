# Quick Start Guide

## Super Simple Setup (for beginners)

### Windows:
1. Make sure you have [Node.js](https://nodejs.org/) installed
2. Double-click `start.bat`
3. Wait for it to install and launch!

### macOS/Linux:
1. Make sure you have [Node.js](https://nodejs.org/) installed
2. Open Terminal in this folder
3. Run: `./start.sh`

That's it! The client will open automatically.

## Adding Your First Server

Once the app opens:

1. Click the green **+** button in the sidebar
2. Enter a name for your server (e.g., "Home Server")
3. Enter your Sharkord server URL:
   - Local server: `http://localhost:4991`
   - Remote server: `http://your-server-ip:4991`
4. Click "Add Server"

The server will load and you can log in!

## Building Standalone Executables

Want a .exe or .app file you can share or run without Node.js?

Run one of these commands:

```bash
# Windows .exe
npm run build:win

# macOS .app
npm run build:mac

# Linux AppImage
npm run build:linux
```

Your executable will be in the `dist/` folder!

## Tips

- **Multiple servers**: Just click the + button to add more servers
- **Switch servers**: Click any server icon in the sidebar
- **Remove a server**: Right-click the server icon → Remove Server
- **Voice/Video**: Works automatically - no extra setup needed!
- **Credentials**: Check "save credentials" when logging in to each server

## Troubleshooting

**"command not found: npm"**
- Install Node.js from https://nodejs.org/

**"Server won't connect"**
- Make sure your Sharkord server is running
- Check that the URL is correct (include http://)
- Try pinging the server URL in a browser first

**"Build failed"**
- Run `npm install` first
- Make sure you have enough disk space
- Check that you're connected to the internet

Need more help? Check README.md or open an issue on GitHub!
