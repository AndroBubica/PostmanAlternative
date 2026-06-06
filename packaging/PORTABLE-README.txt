API Lantern portable layout

Start-Windows.cmd launches Windows-x64\api-lantern.exe.
Start-macOS.command launches macOS\API Lantern.app.
The workspace and exports folders are shared by both builds.
portable.flag keeps writable API Lantern data inside this folder.

Windows and macOS binaries must be built on their respective platforms.
For offline Windows use, place a fixed WebView2 runtime in Windows-x64\runtime.
