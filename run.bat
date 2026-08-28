@echo off
setlocal
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
rem `run.bat repair` forces the full update pass - every node pack, every
rem dependency - instead of only what the last pull changed. It is the one
rem thing the old update.bat could do that this could not.
if /i "%~1"=="repair" set "FEDDA_REPAIR=1"
powershell -ExecutionPolicy Bypass -File "%ROOT%\scripts\run.ps1" -RootPath "%ROOT%"
