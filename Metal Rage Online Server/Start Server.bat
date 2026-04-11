@echo off
title Metal Rage Server

:: Set SERVER_DIR to the folder where this batch file is located
set "SERVER_DIR=%~dp0"

:: Check if server.js exists in the same folder as the batch
if not exist "%SERVER_DIR%server.js" (
    :: Fallback: Check if there is a "server" subfolder next to the batch
    if exist "%SERVER_DIR%server\server.js" (
        set "SERVER_DIR=%~dp0server"
    ) else (
        echo ERROR: Cannot find server.js
        echo Place this batch file in the same folder as server.js,
        echo or ensure server.js is in a folder named "server" next to this script.
        pause
        exit /b
    )
)

echo ============================================
echo  Metal Rage Online - Server
echo ============================================
echo.
echo Starting server on ports 9211 + 30907...
echo Press Ctrl+C to stop.
echo.

:: Jump to the directory and ensure we handle drive changes
cd /d "%SERVER_DIR%"

:: Check if node_modules exists
if not exist "node_modules" (
    echo Installing dependencies...
    call npm install
    echo.
)

node server.js
pause
