@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Start-Ghost.ps1"
if errorlevel 1 pause
