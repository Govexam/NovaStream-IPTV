@echo off
title NovaStream IPTV - Premium TV Player
color 0B
echo ========================================================
echo        NOVASTREAM IPTV - 20,000+ LIVE CHANNELS
echo ========================================================
echo Starting High-Speed Streaming Proxy Server...
echo.

cd /d "%~dp0"
start "" http://localhost:5000
python server.py
pause
