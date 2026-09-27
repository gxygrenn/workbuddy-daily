@echo off
REM Local credential exporter launcher for Windows (double-click friendly).
REM Finds WorkBuddy.exe then runs export-credential.cjs with the Electron runtime.
setlocal enabledelayedexpansion

set "SCRIPT_DIR=%~dp0"
set "ENTRY=%SCRIPT_DIR%export-credential.cjs"

REM 1) explicit override
if defined WORKBUDDY_EXE if exist "%WORKBUDDY_EXE%" (
  set "WB_BIN=%WORKBUDDY_EXE%"
  goto :run
)

REM 2) PATH lookup
for %%C in (WorkBuddy.exe WorkBuddy) do (
  for /f "delims=" %%P in ('where %%C 2^>nul') do (
    if not defined WB_BIN set "WB_BIN=%%P"
  )
)
if defined WB_BIN goto :run

REM 3) common install roots (no hardcoded version numbers)
set "ROOTS=%LOCALAPPDATA%\Programs %LOCALAPPDATA% %ProgramFiles% %ProgramData% D:\Program Files D:\ E:\ F:\"
for %%R in (%ROOTS%) do (
  if exist "%%R" (
    for /f "delims=" %%P in ('dir /b /s "%%R\WorkBuddy.exe" 2^>nul') do (
      if not defined WB_BIN set "WB_BIN=%%P"
    )
  )
)

:run
if not defined WB_BIN (
  echo.
  echo [ERROR] WorkBuddy.exe not found.
  echo Set it explicitly and retry, e.g.:
  echo     set WORKBUDDY_EXE=D:\Program Files\...\WorkBuddy.exe
  echo     scripts\export-credential.cmd
  echo.
  pause
  exit /b 1
)

echo Using runtime : %WB_BIN%
echo Entry script  : %ENTRY%
echo.

set ELECTRON_RUN_AS_NODE=1
"%WB_BIN%" "%ENTRY%" %*
set EXITCODE=%ERRORLEVEL%

echo.
if not "%EXITCODE%"=="0" (echo [FAILED] exit code %EXITCODE%) else (echo [DONE])
pause
exit /b %EXITCODE%
