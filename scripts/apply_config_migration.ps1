# apply_config_migration.ps1
#
# Runs backend/migrations/0001_config_store.sql against the production database.
# Creates the config schema, config_versions table, and pv_writer role.
# Safe to re-run: the migration is idempotent (IF NOT EXISTS / DO $$ blocks).
#
# Mirrors the pattern in county-data-services/scripts/apply_migrations.ps1.
# Connection: same DB instance (34.170.241.253), postgres user, postgres database.
#
# Password resolution (first match wins):
#   1. $env:PGPASSWORD
#   2. gcloud Secret Manager secret DB_PASSWORD (project core-db-475718)
#   3. pgpass.conf
#
# Run from the parcel-viewer repo root:
#   .\scripts\apply_config_migration.ps1
#
# After it completes, follow the printed instructions to set pv_writer's password
# and store it in Secret Manager (steps 2-3 of docs/admin-console-provisioning.md).

param(
    [string]$ProjectId  = "core-db-475718",
    [string]$SecretName = "DB_PASSWORD",
    [string]$PgHost     = "34.170.241.253",
    [string]$PgDb       = "postgres",
    [string]$PgUser     = "postgres"
)

$ErrorActionPreference = "Stop"

$RepoRoot     = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$MigrationFile = Join-Path $RepoRoot "backend\migrations\0001_config_store.sql"

if (-not (Test-Path $MigrationFile)) {
    throw "Migration file not found: $MigrationFile"
}

# ── Password ──────────────────────────────────────────────────────────────────
if ($env:PGPASSWORD) {
    Write-Host "Using PGPASSWORD from environment." -ForegroundColor DarkGray
} else {
    $gcloud = Get-Command gcloud -ErrorAction SilentlyContinue
    if (-not $gcloud) {
        Write-Warning "gcloud not found and PGPASSWORD unset; psql will prompt or use pgpass.conf."
    } else {
        Write-Host "Fetching postgres password from Secret Manager ($SecretName)..." -ForegroundColor DarkGray
        $pw = & gcloud secrets versions access latest --secret=$SecretName --project=$ProjectId 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "Could not read secret '$SecretName' in project '$ProjectId': $pw"
        }
        $env:PGPASSWORD = $pw.Trim()
    }
}

# ── psql helpers ──────────────────────────────────────────────────────────────
$common = @('-h', $PgHost, '-U', $PgUser, '-d', $PgDb, '-v', 'ON_ERROR_STOP=1')

function Invoke-Psql {
    param([string]$Sql, [string]$File, [switch]$Quiet)
    $psqlArgs = $common + $(if ($Quiet) { @('-q') } else { @() })
    if ($File) {
        & psql @psqlArgs '-f' $File
        if ($LASTEXITCODE -ne 0) { throw "psql failed: $File" }
    } else {
        & psql @psqlArgs '-c' $Sql
        if ($LASTEXITCODE -ne 0) { throw "psql failed: $Sql" }
    }
}

function Invoke-PsqlScalar {
    param([string]$Sql)
    $raw = & psql @common '-t' '-A' '-c' $Sql 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
    return ($raw | Out-String).Trim()
}

# ── Preflight ─────────────────────────────────────────────────────────────────
Write-Host "Connecting to $PgHost / $PgDb as $PgUser ..." -ForegroundColor Cyan
Invoke-Psql -Sql "SELECT 1;" -Quiet
Write-Host "Connected." -ForegroundColor Green

# ── Idempotency check ─────────────────────────────────────────────────────────
$tableExists = Invoke-PsqlScalar "SELECT to_regclass('config.config_versions') IS NOT NULL;"
if ($tableExists -eq 't') {
    Write-Host ""
    Write-Host "config.config_versions already exists - migration was previously applied." -ForegroundColor Yellow
    $roleExists = Invoke-PsqlScalar "SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname = 'pv_writer');"
    Write-Host "pv_writer role present: $roleExists" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "Nothing to do. If you need to reset, drop the schema manually." -ForegroundColor DarkGray
    exit 0
}

# ── Apply ─────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host ">> 0001_config_store.sql" -ForegroundColor Cyan
Invoke-Psql -File $MigrationFile
Write-Host "   OK" -ForegroundColor Green

# ── Verify ────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "Verifying..." -ForegroundColor Cyan
Invoke-Psql -Sql "SELECT to_regclass('config.config_versions');"
Invoke-Psql -Sql "SELECT rolname FROM pg_roles WHERE rolname = 'pv_writer';"

# ── Next steps ────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "Migration applied. Next steps (docs/admin-console-provisioning.md):" -ForegroundColor Green
Write-Host ""
Write-Host "  Step 2 - set pv_writer password (run this against the DB as postgres):" -ForegroundColor Yellow
Write-Host "    ALTER ROLE pv_writer PASSWORD '<strong-generated-password>';" -ForegroundColor DarkGray
Write-Host "  Then store the connection string in Secret Manager:" -ForegroundColor Yellow
Write-Host ("    postgresql://pv_writer:<password>@" + $PgHost + ":5432/" + $PgDb + "?sslmode=require") -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Step 3 - wire PV_WRITER_DATABASE_URL + PV_ADMIN_TOKEN on the API service." -ForegroundColor Yellow
Write-Host "           See docs/admin-console-provisioning.md for the full checklist." -ForegroundColor DarkGray
