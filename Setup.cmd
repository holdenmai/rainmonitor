@echo off
rem Double-click this file to set up Rain Monitor.
rem
rem It exists because the alternative is telling a farmer to open PowerShell and
rem type an ExecutionPolicy incantation. A .cmd file runs on double-click with no
rem policy to argue with, and -ExecutionPolicy Bypass applies only to this run.
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup.ps1" %*
if errorlevel 1 (
  echo.
  echo Setup did not finish. The message above says why.
  pause
)
