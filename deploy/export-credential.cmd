@echo off
chcp 65001 >nul
set "HERE=%~dp0"
set "ENTRY=%HERE%export-credential.cjs"

echo.
echo  ================================================
echo    WorkBuddy credential export
echo  ================================================
echo.

if not exist "%ENTRY%" goto :noentry

set "WB="

rem --- 1) drag WorkBuddy.exe onto this file ---
if not "%~1"=="" if exist "%~1" set "WB=%~1"

rem --- 2) WORKBUDDY_EXE environment variable ---
if not defined WB if defined WORKBUDDY_EXE if exist "%WORKBUDDY_EXE%" set "WB=%WORKBUDDY_EXE%"

rem --- 3) common install locations ---
if not defined WB call :try "C:\Program Files\com.tencent.pcgame.workbuddy\WorkBuddy.exe"
if not defined WB call :try "D:\Program Files\com.tencent.pcgame.workbuddy\WorkBuddy.exe"
if not defined WB call :try "E:\Program Files\com.tencent.pcgame.workbuddy\WorkBuddy.exe"
if not defined WB call :try "F:\Program Files\com.tencent.pcgame.workbuddy\WorkBuddy.exe"
if not defined WB call :try "%ProgramFiles%\com.tencent.pcgame.workbuddy\WorkBuddy.exe"
if not defined WB call :try "%ProgramFiles%\WorkBuddy\WorkBuddy.exe"
if not defined WB call :try "%LOCALAPPDATA%\Programs\WorkBuddy\WorkBuddy.exe"
if not defined WB call :try "%LOCALAPPDATA%\Programs\workbuddy\WorkBuddy.exe"

if defined WB goto :haveexe
for /f "delims=" %%i in ('where WorkBuddy.exe 2^>nul') do set "WB=%%i"

:haveexe
if not defined WB goto :notfound

echo  Found: %WB%
echo  Reading login state, please wait ...
echo.

set ELECTRON_RUN_AS_NODE=1
"%WB%" "%ENTRY%" 2>nul
set "RC=%ERRORLEVEL%"

if not "%RC%"=="0" goto :failed

echo.
echo  ------------------------------------------------------------
echo   Done. Now switch back to the GitHub page and paste it.
echo   (see the instructions printed above)
echo  ------------------------------------------------------------
echo.
pause
exit /b 0

rem ============================================================
:try
if not exist "%~1" exit /b 0
set "WB=%~1"
exit /b 0

:noentry
echo  [ERROR] export-credential.cjs not found in this folder.
echo          Keep this .cmd and that .cjs file together.
goto :halt

:notfound
echo  [ERROR] WorkBuddy.exe was not found automatically.
echo.
echo  Fix it in either of these two ways:
echo    1) Right-click the WorkBuddy shortcut - "Open file location",
echo       then drag WorkBuddy.exe onto this .cmd file and drop it.
echo    2) Or open a terminal and run:
echo         set WORKBUDDY_EXE=D:\your\path\WorkBuddy.exe
goto :halt

:failed
echo.
echo  [ERROR] Export failed. Please send the message printed above
echo          to the person who set this up for you.
goto :halt

:halt
echo.
pause
exit /b 1
