Set shell = CreateObject("WScript.Shell")
root = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = root
python = "G:\LocalAI\CyberGirlfriend\qwen3-tts-env\Scripts\python.exe"
command = "cmd.exe /c set HF_HOME=G:\LocalAI\CyberGirlfriend\HuggingFaceCache&& set NO_PROXY=127.0.0.1,localhost&& """ & python & """ voxcpm_voice_service.py 1>data\natural-voice.log 2>data\natural-voice-error.log"
shell.Run command, 0, False
