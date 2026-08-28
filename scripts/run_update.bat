@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"
cd ..

set "ROOT_DIR=%CD%"
set "LOG_FILE=%ROOT_DIR%\logs\update.log"

if not exist "%ROOT_DIR%\logs" mkdir "%ROOT_DIR%\logs"

rem The weekly node throttle used to be deleted here, which meant it never
rem fired: every update walked all forty-two packs. What gets done is now
rem decided by what the update actually changed - see update_logic.ps1.
rem FEDDA_REPAIR=1 still forces the full pass.

echo [%date% %time%] FEDDA Update Starting... (logging to %LOG_FILE%)

powershell -ExecutionPolicy Bypass -File "%ROOT_DIR%\scripts\update_code.ps1"

set "UPDATE_EXIT=%errorlevel%"

REM update_code.ps1 uses 2 for a deliberate refusal - unpushed commits it will not
REM reset over - and 1 for an actual failure. Calling 2 "Failed" reports the guard
REM doing its job as a breakage, which is how a correct refusal comes to look
REM like an unstable updater.
if !UPDATE_EXIT! equ 0 (
    echo [%date% %time%] FEDDA Update Completed Successfully >> "%LOG_FILE%"
) else if !UPDATE_EXIT! equ 2 (
    echo [%date% %time%] FEDDA Update Refused - nothing was changed. See the reason above. >> "%LOG_FILE%"
) else (
    echo [%date% %time%] FEDDA Update Failed with exit code !UPDATE_EXIT! >> "%LOG_FILE%"
)

exit /b %UPDATE_EXIT%
