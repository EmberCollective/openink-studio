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
    npm.cmd ci
    if ($LASTEXITCODE) { throw 'CLI dependencies failed' }
    npm.cmd --prefix ui ci
    if ($LASTEXITCODE) { throw 'UI dependencies failed' }
    if ($PrivateGfont) { npm.cmd run build -- --features private-gfont }
    else { npm.cmd run build }
    if ($LASTEXITCODE) { throw 'Desktop build failed' }
} finally { Pop-Location }
