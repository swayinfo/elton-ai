' Starts the Piper speech server with no console window.
' Put a shortcut to this in shell:startup to have the voice ready at login.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.Run "node piper-server.js 5000", 0, False
