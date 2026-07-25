@echo off
REM ビルド(electron-builder)を待たず、electron-vite の dev モードで即起動する。
REM ELECTRON_RUN_AS_NODE が環境変数に残っていると Electron が素の Node として起動し
REM electron.app が undefined になって落ちるため、ここで明示的にクリアする。
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
call npm run dev
if errorlevel 1 pause
