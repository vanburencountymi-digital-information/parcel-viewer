# compose.ps1 - docker compose wrapper for standalone Parcel Viewer
#
# Passes --env-file ../.env so MARTIN_DATABASE_URL, PV_HTTP_PORT, etc. resolve.
# Before up/build, verifies repo assets needed for nginx + api + martin exist.
#
# Usage (from anywhere):
#   cp .env.example .env
#   .\infra\compose.ps1 up --build -d
#   .\infra\compose.ps1 logs -f martin
#   .\infra\compose.ps1 down

param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ComposeArgs
)

$ErrorActionPreference = "Stop"
$InfraDir = $PSScriptRoot
$RootDir = (Resolve-Path (Join-Path $InfraDir "..")).Path
$EnvFile = Join-Path $RootDir ".env"
$ComposeFile = Join-Path $InfraDir "docker-compose.viewer.yml"

$MapJs = Join-Path $RootDir "frontend\public\js\map.js"
$DemoIndex = Join-Path $RootDir "demo\index.html"
$MartinYaml = Join-Path $InfraDir "martin\martin.yaml"
$BackendPkg = Join-Path $RootDir "backend\parcel_viewer\__init__.py"

function Test-ComposeNeedsPreflight {
    param([string[]]$CmdArgs)
    if (-not $CmdArgs -or $CmdArgs.Count -eq 0) { return $false }
    $cmd = $CmdArgs[0]
    return $cmd -in @('up', 'build', 'create', 'run', 'start', 'restart')
}

if (-not (Test-Path $EnvFile)) {
    throw "Missing $EnvFile - copy .env.example to .env and fill in database URLs."
}

$needsPreflight = Test-ComposeNeedsPreflight -CmdArgs $ComposeArgs

if ($needsPreflight) {
    if (-not (Test-Path $MapJs)) {
        throw "Missing $MapJs - frontend assets not found."
    }
    if (-not (Test-Path $DemoIndex)) {
        throw "Missing $DemoIndex - demo page not found."
    }
    if (-not (Test-Path $MartinYaml)) {
        throw "Missing $MartinYaml - Martin config not found."
    }
    if (-not (Test-Path $BackendPkg)) {
        throw "Missing parcel_viewer Python package at backend/parcel_viewer/ (needed for api Docker build)."
    }
}

Push-Location $InfraDir
try {
    & docker compose -f $ComposeFile --env-file $EnvFile @ComposeArgs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
    Pop-Location
}
