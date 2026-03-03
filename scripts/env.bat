@echo off
REM Windows: activate venv and add nvidia cublas/cudnn lib dirs to PATH so
REM CTranslate2/faster-whisper can load them. Run: scripts\env.bat
cd /d "%~dp0.."
call ".venv\Scripts\activate.bat"
set "VENV_LIB=.venv\Lib\site-packages\nvidia"
set "PATH=%VENV_LIB%\cublas\lib;%VENV_LIB%\cudnn\lib;%PATH%"
echo venv + CUDA libs ready
