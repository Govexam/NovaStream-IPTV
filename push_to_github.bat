@echo off
title Push NovaStream IPTV to GitHub
color 0A
echo ========================================================
echo        PUSH NOVASTREAM IPTV TO GITHUB REPOSITORY
echo ========================================================
echo.
set /p REPO_URL="Enter your GitHub Repository URL (e.g., https://github.com/username/NovaStream-IPTV.git): "

if "%REPO_URL%"=="" (
    echo Error: No repository URL provided!
    pause
    exit /b
)

echo.
echo Connecting to remote: %REPO_URL% ...
git remote remove origin >nul 2>&1
git remote add origin %REPO_URL%
git branch -M main

echo.
echo Pushing code to GitHub...
git push -u origin main

echo.
echo ========================================================
echo Done! If you see any login prompt, sign in via browser.
echo ========================================================
pause
