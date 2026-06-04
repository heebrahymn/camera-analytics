@echo off
cd /d "%~dp0"
echo Starting Carbon Worker at %date% %time% >> worker.log
python worker.py --config config.yaml >> worker.log 2>&1
echo Carbon Worker stopped at %date% %time% with error level %errorlevel% >> worker.log
