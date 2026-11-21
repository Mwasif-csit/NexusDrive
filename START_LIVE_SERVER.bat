@echo off
title NexusDrive by ByteNexus - Live Server (Port 5000)
echo =====================================================================
echo   Starting NexusDrive by ByteNexus (Pure HTML, CSS, JavaScript)
echo   URL: http://localhost:5000
echo =====================================================================
start "" "http://localhost:5000"
python -m http.server 5000
pause
