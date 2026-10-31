# Deploys ONE TESTING-only prodcheck-* function to the isolated TESTING project.
# Usage: .\scripts\deploy\deploy-testing.ps1 -Function prodcheck-notify-defect
param(
  [Parameter(Mandatory = $true)][string]$Function
)
$ErrorActionPreference = 'Stop'

$TestingRef = 'etffoumsopxjptnmhvwh'
$Allowed = @('prodcheck-notify-defect', 'prodcheck-notify-expiring-invites')
if ($Allowed -notcontains $Function) { throw "Refusing: '$Function' is not a TESTING function ($($Allowed -join ', '))." }

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$workdir = Join-Path $repo 'supabase-testing'
if (-not (Test-Path (Join-Path $workdir "supabase\functions\$Function\index.ts"))) { throw "Function source not found: $Function" }

Write-Host "Target TESTING project: $TestingRef  (function: $Function)"
# --workdir keeps the production supabase/ folder and its LIVE link out of this deploy.
npx supabase functions deploy $Function --project-ref $TestingRef --workdir $workdir --no-verify-jwt
