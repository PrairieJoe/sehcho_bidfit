param(
  [int]$Port = 3002
)

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$env:CI = 'true'

$runtimeRoot = 'C:\Users\jojae\.cache\codex-runtimes\codex-primary-runtime\dependencies'
$bundledNode = Join-Path $runtimeRoot 'node\bin'
$bundledPnpm = Join-Path $runtimeRoot 'bin\fallback\pnpm.cmd'

if (Test-Path $bundledNode) {
  $env:Path = "$bundledNode;$env:Path"
}

if (Test-Path $bundledPnpm) {
  Write-Host "BidFit is starting at http://localhost:$Port"
  & $bundledPnpm dev --hostname 127.0.0.1 --port $Port
} else {
  Write-Host "BidFit is starting at http://localhost:$Port"
  pnpm dev --hostname 127.0.0.1 --port $Port
}
