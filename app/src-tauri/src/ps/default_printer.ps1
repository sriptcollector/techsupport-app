$n = '__ARG__'
$w = Get-CimInstance Win32_Printer -Filter ("Name='" + ($n -replace "'", "''") + "'")
if (-not $w) { throw "No printer named $n." }
$w | Invoke-CimMethod -MethodName SetDefaultPrinter | Out-Null
"$n is now the default printer."
