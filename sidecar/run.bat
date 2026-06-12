@echo off
rem OwenFlow STT sidecar launcher
rem Note: bare "python" on this machine resolves to a hermes venv; use the py launcher.
cd /d "%~dp0"
py -3.13 -m pip install -r requirements.txt
py -3.13 server.py
