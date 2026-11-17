@echo off
rem Monomem launcher. Runs the bundled official Node runtime (signed by the OpenJS Foundation; renamed monomem-node.exe,
rem the signature stays valid) with Monomem's code in this folder. App settings and hooks name runtime\monomem-node.exe
rem and dist\src\cli.js here; this folder never moves.
rem Double-clicked in Explorer with no arguments (cmd.exe /c ""<this file>" "): open the dashboard instead of help.
setlocal EnableDelayedExpansion
set "MM_LINE=!cmdcmdline:"=!"
if "%~1"=="" if /i "!MM_LINE!"=="%ComSpec% /c %~f0 " (
  endlocal
  "%~dp0runtime\monomem-node.exe" "%~dp0dist\src\cli.js" open
  exit /b
)
endlocal
"%~dp0runtime\monomem-node.exe" "%~dp0dist\src\cli.js" %*
