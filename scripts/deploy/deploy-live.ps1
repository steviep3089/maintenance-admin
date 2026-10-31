# Deploys exactly ONE Maintenance Edge Function to the LIVE project. Always run from the permanent repo.
# Usage: .\scripts\deploy\deploy-live.ps1 -Function notify-defect
param(
  [Parameter(Mandatory = $true)][string]$Function
)
$ErrorActionPreference = 'Stop'

$LiveRef = 'zebksrihswwwlejdiboq'
$Allowed = @('create-user', 'delete-user', 'get-admin-users', 'list-users', 'resend-invite',
  'send-report-email', 'upload-drive', 'invite-contracts-portal', 'notify-defect', 'notify-expiring-invites')

if ($Allowed -notcontains $Function) { throw "Refusing: '$Function' is not one of the allowed LIVE functions: $($Allowed -join ', ')" }

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if ((Split-Path $repo -Leaf) -ne 'maintenance-admin') { throw "Refusing: must run from the permanent 'maintenance-admin' repo, not '$repo'." }
if (-not (Test-Path (Join-Path $repo "supabase\functions\$Function\index.ts"))) { throw "Function source not found: $Function" }

$branch = (git -C $repo rev-parse --abbrev-ref HEAD).Trim()
if ($branch -ne 'master') { throw "Refusing: LIVE deploys only from 'master' (current: '$branch'). Merge reviewed changes first." }
if (git -C $repo status --porcelain) { throw 'Refusing: working tree is not clean. Commit or stash first.' }

$hash = (Get-FileHash (Join-Path $repo "supabase\functions\$Function\index.ts") -Algorithm SHA256).Hash.Substring(0, 12)
Write-Host "Target LIVE project : $LiveRef"
Write-Host "Function            : $Function (index.ts sha256 $hash...)"
Write-Host "Branch / commit     : $branch @ $((git -C $repo rev-parse --short HEAD).Trim())"
$answer = Read-Host "Type the function name to deploy to LIVE"
if ($answer -ne $Function) { throw 'Confirmation did not match. Nothing deployed.' }

# --project-ref is always explicit, so a stale supabase/.temp link can never redirect the deploy.
# All ten functions authenticate inside the handler (user JWT or HMAC), so verify_jwt stays off.
Push-Location $repo
try { npx supabase functions deploy $Function --project-ref $LiveRef --no-verify-jwt }
finally { Pop-Location }
