@echo off
rem ============================================================
rem  Holy Light画布 MCP  --  one-click installer launcher (Windows)
rem
rem  This file does exactly one job: find ANY Node.js on this
rem  machine and hand the real work over to setup.js.
rem
rem  It has to be plain-ASCII on purpose: cmd.exe decodes batch
rem  files with the console code page, so a single non-ASCII byte
rem  here can turn into garbage or a syntax error. All the
rem  human-facing words live in setup.js, which prints in UTF-8.
rem ============================================================

chcp 65001 >nul 2>nul
setlocal

set "NODE_EXE="

rem --- 1) whatever is on PATH --------------------------------
for /f "delims=" %%i in ('where node 2^>nul') do (
  if not defined NODE_EXE set "NODE_EXE=%%i"
)

rem --- 2) the usual install locations -----------------------
if not defined NODE_EXE (
  for %%c in (
    "%ProgramFiles%\nodejs\node.exe"
    "%LOCALAPPDATA%\Programs\nodejs\node.exe"
    "%USERPROFILE%\scoop\apps\nodejs\current\node.exe"
    "%SystemDrive%\nodejs\node.exe"
  ) do (
    if not defined NODE_EXE if exist %%~c set "NODE_EXE=%%~c"
  )
)

rem --- 3) the copy WorkBuddy itself ships -------------------
if not defined NODE_EXE (
  set "WBNODE=%USERPROFILE%\.workbuddy\binaries\node\versions"
  for /f "delims=" %%d in ('dir /b /o-n "%USERPROFILE%\.workbuddy\binaries\node\versions" 2^>nul') do (
    if not defined NODE_EXE if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\%%d\node.exe" (
      set "NODE_EXE=%USERPROFILE%\.workbuddy\binaries\node\versions\%%d\node.exe"
    )
  )
)

if not defined NODE_EXE goto :nonode

"%NODE_EXE%" "%~dp0setup.js" %*
set "RC=%errorlevel%"

echo.
echo ------------------------------------------------------------
echo  press any key to close this window
echo ------------------------------------------------------------
pause >nul
exit /b %RC%

:nonode
echo.
echo   [!!]  Node.js was not found on this computer.
echo.
echo   Holy Light画布's MCP server runs on Node.js 22.5 or newer.
echo   Install the LTS build from   https://nodejs.org/
echo   then double-click install.cmd again.
echo.
echo   (If it is already installed, close this window, reopen it,
echo    and try once more so PATH gets picked up.)
echo.
pause
exit /b 1
