# Sets the system text size (Settings > Accessibility > Text size) to __ARG__ percent, for this user only.
$p = [int]'__ARG__'
if ($p -lt 100 -or $p -gt 225) { throw 'size must be 100 to 225' }
$k = 'HKCU:\Software\Microsoft\Accessibility'
New-Item -Path $k -Force | Out-Null
$old = (Get-ItemProperty -Path $k -Name TextScaleFactor -ErrorAction SilentlyContinue).TextScaleFactor
if (-not $old) { $old = 100 }
Set-ItemProperty -Path $k -Name TextScaleFactor -Value $p -Type DWord
Add-Type -Namespace TS -Name Msg -MemberDefinition '[DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, UIntPtr w, string l, uint f, uint t, out UIntPtr r);'
$r = [UIntPtr]::Zero
[TS.Msg]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'WindowsThemeElement', 2, 5000, [ref]$r) | Out-Null
"Text size set to $p percent (it was $old percent)."
