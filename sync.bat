@echo off
cd /d "C:\Users\abaza\OneDrive\Desktop\Demand-Planning-App"
git add .
git commit -m "Auto-sync %DATE% %TIME%"
git push
echo.
echo Done! All files pushed to GitHub.
timeout /t 3
