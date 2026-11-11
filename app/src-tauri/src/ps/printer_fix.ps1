# Clears this person's stuck print jobs and resumes the printers. Restarting the spooler (needs the Windows Yes box) is printer_spooler.ps1.
$out = @()
foreach ($p in Get-Printer -ErrorAction SilentlyContinue) {
  $jobs = @(Get-PrintJob -PrinterName $p.Name -ErrorAction SilentlyContinue)
  foreach ($j in $jobs) { Remove-PrintJob -InputObject $j -ErrorAction SilentlyContinue }
  $w = Get-CimInstance Win32_Printer -Filter ("Name='" + ($p.Name -replace "'", "''") + "'")
  if ($w) { $w | Invoke-CimMethod -MethodName Resume | Out-Null }
  $out += "$($p.Name): cleared $($jobs.Count) job(s), resumed."
}
if (-not $out) { 'No printers found on this computer.' } else { $out -join "`n" }
