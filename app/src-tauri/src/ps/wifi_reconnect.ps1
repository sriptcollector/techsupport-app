# Turns Wi-Fi off and on again for the network that was connected, then clears the name cache.
$ifs = (netsh wlan show interfaces) 2>$null
$prof = ($ifs | Select-String -Pattern '^\s*Profile\s*:\s*(.+)$' | ForEach-Object { $_.Matches[0].Groups[1].Value.Trim() } | Select-Object -First 1)
if (-not $prof) { $prof = ((netsh wlan show profiles) | Select-String -Pattern 'All User Profile\s*:\s*(.+)$' | ForEach-Object { $_.Matches[0].Groups[1].Value.Trim() } | Select-Object -First 1) }
if (-not $prof) { throw 'No saved Wi-Fi network was found on this computer.' }
netsh wlan disconnect | Out-Null
Start-Sleep -Seconds 2
netsh wlan connect name="$prof" | Out-Null
$ok = $false
for ($i = 0; $i -lt 12; $i++) { Start-Sleep -Seconds 1; if (Test-Connection -ComputerName 1.1.1.1 -Count 1 -Quiet -ErrorAction SilentlyContinue) { $ok = $true; break } }
Clear-DnsClientCache -ErrorAction SilentlyContinue
if ($ok) { "Reconnected to $prof and the internet answers." } else { "Reconnected to $prof, but the internet still does not answer. The router may need a restart." }
