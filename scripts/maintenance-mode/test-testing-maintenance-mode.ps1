<#
 TESTING-ONLY Maintenance Mode access probe (project etffoumsopxjptnmhvwh).
 Prepared but NOT executed by the author. Run only after 20261030_maintenance_mode_setting.sql has
 been applied in TESTING with owner approval.

 It never toggles maintenance (the toggle calls use a dummy password and must be rejected before any
 password check). It checks:
   1. anonymous can read the status (no super user / manage flags)
   2. anonymous cannot call set_maintenance_mode
   3. optional non-admin token: cannot call set_maintenance_mode, no flags
   4. optional admin token: can_manage = true, is_super_user = false (read-only)
   5. optional super user token: is_super_user = true (read-only)
 Keys and tokens are read as hidden input and are never printed. Windows PowerShell 5.1 compatible.
#>
[CmdletBinding()]
param(
  [switch]$IncludeNonAdmin,
  [switch]$IncludeAdmin,
  [switch]$IncludeSuperUser
)

$ErrorActionPreference = 'Stop'
$ProjectRef = 'etffoumsopxjptnmhvwh'
$BaseUrl = "https://$ProjectRef.supabase.co"

function Read-Hidden([string]$Prompt) {
  $secure = Read-Host -Prompt $Prompt -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

function Invoke-Rpc([string]$Name, [string]$Body, [string]$ApiKey, [string]$Bearer) {
  $headers = @{ apikey = $ApiKey; 'Content-Type' = 'application/json' }
  if ($Bearer) { $headers['Authorization'] = "Bearer $Bearer" }
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$BaseUrl/rest/v1/rpc/$Name" -Headers $headers -Body $Body
    return @{ Status = [int]$r.StatusCode; Body = $r.Content }
  } catch {
    $resp = $_.Exception.Response
    if ($null -eq $resp) { return @{ Status = 0; Body = '' } }
    return @{ Status = [int]$resp.StatusCode; Body = '' }
  }
}

$results = New-Object System.Collections.ArrayList
function Add-Result([string]$Name, [bool]$Pass, [string]$Detail) {
  [void]$results.Add([pscustomobject]@{ Test = $Name; Result = $(if ($Pass) { 'PASS' } else { 'FAIL' }); Detail = $Detail })
}

$apiKey = Read-Hidden 'TESTING publishable key (sb_publishable_...)'
if (-not $apiKey.StartsWith('sb_publishable_')) { throw 'Expected a publishable key (sb_publishable_...). Secret keys must never be used here.' }

$off = '{"p_enabled":false,"p_message":null,"p_expected_return_at":null,"p_password":"not-a-real-password"}'

$r = Invoke-Rpc 'get_maintenance_status' '{}' $apiKey $null
$rows = $null; if ($r.Status -eq 200) { $rows = $r.Body | ConvertFrom-Json }
Add-Result 'anon: read status' ($r.Status -eq 200 -and @($rows).Count -eq 1 -and $rows[0].is_super_user -eq $false -and $rows[0].can_manage -eq $false) "HTTP $($r.Status)"

$r = Invoke-Rpc 'set_maintenance_mode' $off $apiKey $null
Add-Result 'anon: set rejected' ($r.Status -in 401, 403) "HTTP $($r.Status)"

if ($IncludeNonAdmin) {
  $tok = Read-Hidden 'NON-ADMIN user access token (TESTING)'
  $r = Invoke-Rpc 'get_maintenance_status' '{}' $apiKey $tok
  $rows = $null; if ($r.Status -eq 200) { $rows = $r.Body | ConvertFrom-Json }
  Add-Result 'non-admin: no super user / manage flags' ($r.Status -eq 200 -and $rows[0].is_super_user -eq $false -and $rows[0].can_manage -eq $false) "HTTP $($r.Status)"
  $r = Invoke-Rpc 'set_maintenance_mode' $off $apiKey $tok
  Add-Result 'non-admin: set rejected' ($r.Status -in 401, 403) "HTTP $($r.Status)"
  $tok = $null
}

if ($IncludeAdmin) {
  $tok = Read-Hidden 'ADMIN user access token (TESTING)'
  $r = Invoke-Rpc 'get_maintenance_status' '{}' $apiKey $tok
  $rows = $null; if ($r.Status -eq 200) { $rows = $r.Body | ConvertFrom-Json }
  Add-Result 'admin: can_manage=true, is_super_user=false' ($r.Status -eq 200 -and $rows[0].can_manage -eq $true -and $rows[0].is_super_user -eq $false) "HTTP $($r.Status)"
  $tok = $null
}

if ($IncludeSuperUser) {
  $tok = Read-Hidden 'SUPER USER access token (TESTING)'
  $r = Invoke-Rpc 'get_maintenance_status' '{}' $apiKey $tok
  $rows = $null; if ($r.Status -eq 200) { $rows = $r.Body | ConvertFrom-Json }
  Add-Result 'super user: is_super_user=true' ($r.Status -eq 200 -and $rows[0].is_super_user -eq $true) "HTTP $($r.Status)"
  $tok = $null
}

$apiKey = $null
$results | Format-Table -AutoSize
if (@($results | Where-Object { $_.Result -eq 'FAIL' }).Count -gt 0) { exit 1 }
