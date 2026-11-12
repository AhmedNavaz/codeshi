@echo off
rem The codeshi command (#90) on Windows. File, Install 'codeshi' Command puts a small launcher for this file on the PATH.
rem It runs bin\codeshi.mjs with the Node built into Codeshi.exe, so it needs no Node of its own.
setlocal
set "CODESHI_BIN=%~dp0"
set "CODESHI_APP=%CODESHI_BIN%..\..\..\Codeshi.exe"
if not exist "%CODESHI_APP%" goto source
set ELECTRON_RUN_AS_NODE=1
"%CODESHI_APP%" "%CODESHI_BIN%codeshi.mjs" %*
exit /b %ERRORLEVEL%
:source
rem A copy run from source uses the Node on the PATH.
node "%CODESHI_BIN%codeshi.mjs" %*
exit /b %ERRORLEVEL%
