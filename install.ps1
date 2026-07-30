$ErrorActionPreference = "Stop"

$installer = Join-Path $PSScriptRoot "install.mjs"
& node $installer @args
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
