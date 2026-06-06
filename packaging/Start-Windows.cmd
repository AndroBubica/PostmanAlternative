@echo off
setlocal
cd /d "%~dp0"
if not exist portable.flag type nul > portable.flag
start "" "%~dp0Windows-x64\api-lantern.exe"
