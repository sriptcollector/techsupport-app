# Removes temporary files older than 2 days from this user's temp folder and reports free space. Never touches documents.
$cut = (Get-Date).AddDays(-2)
$files = Get-ChildItem $env:TEMP -Recurse -File -Force -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt $cut }
$size = ($files | Measure-Object Length -Sum).Sum
$files | Remove-Item -Force -ErrorAction SilentlyContinue
$free = (Get-PSDrive -Name C).Free
$big = (Get-ChildItem "$env:USERPROFILE\Downloads" -File -ErrorAction SilentlyContinue | Sort-Object Length -Descending | Select-Object -First 3 | ForEach-Object { "$($_.Name) ($([math]::Round($_.Length / 1MB)) MB)" }) -join ', '
"Removed about $([math]::Round($size / 1MB)) MB of old temporary files. Free space on C: now $([math]::Round($free / 1GB, 1)) GB. Biggest files in Downloads: $big"
