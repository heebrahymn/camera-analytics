@echo off
cd /d "%~dp0"
:start
echo Starting Carbon Worker at %date% %time% >> worker.log
python worker.py --config config.yaml >> worker.log 2>&1
echo Carbon Worker stopped at %date% %time% with error level %errorlevel% >> worker.log
echo Worker crashed or stopped. Restarting in 10 seconds... >> worker.log
timeout /t 10 > nul
goto start
