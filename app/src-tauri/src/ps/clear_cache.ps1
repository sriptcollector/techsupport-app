# Deletes only browser cache folders (not passwords, history, bookmarks or logins). Locked files are skipped.
$la = $env:LOCALAPPDATA; $targets = @()
$b = '__ARG__'
$roots = @{ chrome = "$la\Google\Chrome\User Data"; edge = "$la\Microsoft\Edge\User Data"; brave = "$la\BraveSoftware\Brave-Browser\User Data" }
if ($roots.ContainsKey($b)) {
  foreach ($prof in Get-ChildItem $roots[$b] -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'Default' -or $_.Name -like 'Profile *' }) {
    foreach ($c in 'Cache', 'Code Cache', 'GPUCache') { $targets += Join-Path $prof.FullName $c }
  }
} elseif ($b -eq 'firefox') {
  foreach ($prof in Get-ChildItem "$la\Mozilla\Firefox\Profiles" -Directory -ErrorAction SilentlyContinue) { $targets += Join-Path $prof.FullName 'cache2' }
} else { throw 'browser must be chrome, edge, brave or firefox' }
$freed = 0
foreach ($t in $targets) {
  if (Test-Path $t) {
    $freed += (Get-ChildItem $t -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
    Get-ChildItem $t -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  }
}
"Cleared the $b cache: about $([math]::Round($freed / 1MB)) MB. Passwords, history and bookmarks were not touched."
