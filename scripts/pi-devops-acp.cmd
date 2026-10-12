@echo off
rem ACP stdio entry. Does not change the default pi profile.
setlocal EnableExtensions
if "%PI_CODING_AGENT_DIR%"=="" for %%I in ("%~dp0..") do set "PI_CODING_AGENT_DIR=%%~fI"
where node >nul 2>&1
if errorlevel 1 (
  echo node не найден в PATH. 1>&2
  exit /b 1
)
node "%PI_CODING_AGENT_DIR%\pi\tools\acp-server.mjs"
exit /b %ERRORLEVEL%
