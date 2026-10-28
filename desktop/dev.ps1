param([switch]$PrivateGfont)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (Test-Path -LiteralPath "$repoRoot\.cache\cargo\bin\cargo.exe") {
    $env:CARGO_HOME = "$repoRoot\.cache\cargo"
    $env:RUSTUP_HOME = "$repoRoot\.cache\rustup"
    $env:Path = "$repoRoot\.cache\cargo\bin;" + $env:Path
}
Push-Location $PSScriptRoot
try {
    if (-not (Test-Path -LiteralPath 'node_modules')) { npm.cmd ci; if ($LASTEXITCODE) { throw 'CLI dependencies failed' } }
    if (-not (Test-Path -LiteralPath 'ui\node_modules')) { npm.cmd --prefix ui ci; if ($LASTEXITCODE) { throw 'UI dependencies failed' } }
    if ($PrivateGfont) { npm.cmd run dev -- --features private-gfont }
    else { npm.cmd run dev }
    if ($LASTEXITCODE) { throw 'Desktop dev process failed' }
} finally { Pop-Location }
