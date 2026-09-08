Set shell = CreateObject("WScript.Shell")
root = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
profile = root & "\data\chrome-profile"
command = """" & chrome & """ --app=http://127.0.0.1:17860 --start-maximized --autoplay-policy=no-user-gesture-required --user-data-dir=""" & profile & """"
shell.Run command, 1, False
