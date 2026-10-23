@echo off
rem Starts the Kaotic Gaming site on this computer (http://localhost:8088).
rem Keep this window open while the site is running; close it to stop the site.
cd /d "%~dp0"
title Kaotic Gaming site
node server.js
echo.
echo The site stopped. Press any key to close this window.
pause >nul
