# appearance: dark | light (apps and Windows)
$a = '__ARG__'
$v = if ($a -eq 'dark') { 0 } elseif ($a -eq 'light') { 1 } else { throw 'appearance must be dark or light' }
$k = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize'
Set-ItemProperty -Path $k -Name AppsUseLightTheme -Value $v -Type DWord
Set-ItemProperty -Path $k -Name SystemUsesLightTheme -Value $v -Type DWord
"Switched to $a mode."
