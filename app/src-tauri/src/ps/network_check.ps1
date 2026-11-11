# Checks each link of the chain and says where it breaks. Also clears the name cache.
$gw = (Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric | Select-Object -First 1).NextHop
$wifi = (netsh wlan show interfaces) 2>$null | Select-String -Pattern '^\s*State\s*:\s*(.+)$' | ForEach-Object { $_.Matches[0].Groups[1].Value.Trim() } | Select-Object -First 1
"Wi-Fi: $(if ($wifi) { $wifi } else { 'no Wi-Fi adapter found' })"
if ($gw) { "Router ($gw): $(if (Test-Connection -ComputerName $gw -Count 1 -Quiet -ErrorAction SilentlyContinue) { 'answers' } else { 'does not answer' })" } else { 'Router: none found (not connected)' }
"Internet (1.1.1.1): $(if (Test-Connection -ComputerName 1.1.1.1 -Count 1 -Quiet -ErrorAction SilentlyContinue) { 'reachable' } else { 'not reachable' })"
try { [void][System.Net.Dns]::GetHostAddresses('www.microsoft.com'); 'Names (DNS): work' } catch { 'Names (DNS): do not work' }
Clear-DnsClientCache -ErrorAction SilentlyContinue
'Name cache cleared.'
