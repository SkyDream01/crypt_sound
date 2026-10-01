@echo off
setlocal
cd /d "%~dp0"
set "PYTHON=%~dp0.venv\Scripts\python.exe"

if not exist "%PYTHON%" (
    echo Project virtual environment not found: .venv\Scripts\python.exe
    echo Create the virtual environment and install the project as described in README.md.
    pause
    exit /b 1
)

"%PYTHON%" -c "import numpy, scipy, fastapi, uvicorn" >nul 2>&1
if errorlevel 1 (
    echo Project packages are missing. Installing dependencies; this may take a few minutes...
    "%PYTHON%" -m pip install -e .
    if errorlevel 1 (
        echo Dependency installation failed. Check your internet connection or pip configuration.
        pause
        exit /b 1
    )
)

"%PYTHON%" -m crypt_sound serve --open-browser
if errorlevel 1 echo The local workbench stopped with an error.
pause
