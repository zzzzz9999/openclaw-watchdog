@echo off
:: OpenClaw Gateway Monitor - Windows/WSL launcher
:: Double-click this file to start monitoring

title OpenClaw Gateway Monitor
chcp 65001 >nul 2>&1

:: Check if running from WSL filesystem (UNC path)
echo %~dp0 | findstr /i "wsl" >nul 2>&1
if not errorlevel 1 goto :run_via_wsl

:: Normal Windows path - run node directly
where node >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js is not installed.
    echo Install it from https://nodejs.org
    echo.
    pause
    exit /b 1
)

echo Starting OpenClaw Gateway Monitor...
echo.
node "%~dp0monitor.js" %*
if errorlevel 1 (
    echo.
    echo Monitor exited with an error.
    pause
)
goto :eof

:: WSL path - delegate to wsl.exe
:run_via_wsl
echo Detected WSL filesystem. Launching via wsl.exe...
echo.
set "UNCPATH=%~dp0"
if "%UNCPATH:~-1%"=="\" set "UNCPATH=%UNCPATH:~0,-1%"

:: Use bash -i to load .bashrc (so nvm node is on PATH), suppress job control warnings
wsl.exe bash -ic "node \"$(wslpath '%UNCPATH:\=/%')/monitor.js\"" 2>&1
if errorlevel 1 (
    echo.
    echo Monitor exited with an error.
    pause
)
