@echo off
setlocal
if not defined LLAMA_SERVER set "LLAMA_SERVER=%LOCALAPPDATA%\Microsoft\WinGet\Packages\ggml.llamacpp_Microsoft.Winget.Source_8wekyb3d8bbwe\llama-server.exe"
if not defined MODEL set "MODEL=G:\LocalAI\CyberGirlfriend\Models\llm\Qwen3.5-9B\Qwen3.5-9B-Q5_K_M.gguf"

if not exist "%MODEL%" (
  echo Companion model is not installed: %MODEL%
  pause
  exit /b 1
)

netstat -ano | findstr "127.0.0.1:1235" | findstr "LISTENING" >nul && exit /b 0

"%LLAMA_SERVER%" ^
  -m "%MODEL%" ^
  --host 127.0.0.1 ^
  --port 1235 ^
  -c 8192 ^
  -np 1 ^
  -ngl 0 ^
  -t 8 ^
  -tb 12 ^
  -fa auto ^
  --jinja ^
  --reasoning off ^
  --reasoning-budget 0 ^
  --alias local-companion-model
