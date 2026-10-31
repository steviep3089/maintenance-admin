param(
    [Parameter(Mandatory = $true)][ValidateSet('OFF', 'ON')][string]$State
)
$ErrorActionPreference = 'Stop'

# TESTING ONLY - hard-coded project, never LIVE. Run by the owner; it is the only thing that sends requests.
# Run once with Maintenance Mode OFF (-State OFF) and, after OFF passes, once with it ON (-State ON).
#
# Safety:
#  * Passwords and tokens are read with secure prompts and are never printed or written to disk.
#  * Requests that PASS the guard use an empty body, so the six non-Contracts functions fail validation
#    before doing any work (no user created/deleted, no email, no Drive upload).
#  * list-users and invite-contracts-portal call the real Contracts project once a caller passes the guard,
#    so this script only sends them requests that are rejected BEFORE that point (anonymous, malformed,
#    non-admin, and - when ON - a blocked caller). It never sends them a request that is allowed through.
$projectRef = 'etffoumsopxjptnmhvwh'
$baseUrl = "https://$projectRef.supabase.co"
$publishableKey = $env:VITE_SUPABASE_PUBLISHABLE_KEY
if (-not $publishableKey) { throw 'Set VITE_SUPABASE_PUBLISHABLE_KEY to the TESTING publishable key.' }
if ($publishableKey -notlike 'sb_publishable_*') { throw 'That is not a publishable key. Never use a secret or legacy key here.' }

function ConvertFrom-Secure([securestring]$secure) {
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

# Signs in against the TESTING project only and returns an access token (or $null when skipped).
function Get-AccessToken([string]$label) {
    $email = Read-Host "TESTING email for $label (Enter to skip)"
    if (-not $email) { return $null }
    $password = ConvertFrom-Secure (Read-Host "Password for $label" -AsSecureString)
    $body = @{ email = $email; password = $password } | ConvertTo-Json
    $resp = Invoke-RestMethod -Method Post -Uri "$baseUrl/auth/v1/token?grant_type=password" `
        -Headers @{ apikey = $publishableKey } -ContentType 'application/json' -Body $body
    $resp.access_token
}

function Invoke-Function([string]$name, [string]$token, [string]$body) {
    $headers = @{ apikey = $publishableKey }
    if ($token) { $headers.Authorization = "Bearer $token" }
    $script:LastNote = ''
    try {
        $r = Invoke-WebRequest -Uri "$baseUrl/functions/v1/$name" -Method Post -Headers $headers `
            -ContentType 'application/json' -Body $body -UseBasicParsing
        $status = [int]$r.StatusCode; $text = $r.Content
    } catch {
        if (-not $_.Exception.Response) { return 0 }
        $status = [int]$_.Exception.Response.StatusCode
        try {
            $reader = New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())
            $text = $reader.ReadToEnd()
        } catch { $text = '' }
    }
    # Keep ONLY the generic error string and the maintenance flag; never the rest of a response body.
    try {
        $json = $text | ConvertFrom-Json
        $parts = @()
        if ($json.error) { $parts += ([string]$json.error).Substring(0, [Math]::Min(70, ([string]$json.error).Length)) }
        if ($json.maintenance) { $parts += 'maintenance=true' }
        $script:LastNote = ($parts -join ' | ')
    } catch { }
    $status
}

# Functions that are safe to hit with an empty body when the caller is allowed through.
$safeFunctions = @('create-user', 'delete-user', 'get-admin-users', 'resend-invite', 'send-report-email', 'upload-drive')
# Functions that would contact the Contracts project if allowed through.
$contractsFunctions = @('list-users', 'invite-contracts-portal')
$contractsBody = '{"email":"maintenance-smoke@example.invalid"}'

# Expected outcomes: PASS = not 401/403/503 (reached validation); 503 = blocked by maintenance;
# 403 = role check; 401 = authentication.
$tokens = @{}
$tokens['superuser'] = Get-AccessToken 'Super User (an admin)'
$tokens['manager'] = Get-AccessToken 'manager'
$tokens['user'] = Get-AccessToken 'normal user'
$tokens['admin2'] = $null
$admin2Token = Get-AccessToken 'SECOND (non-Super-User) ADMIN - leave blank unless you have one'
if ($admin2Token) {
    $confirm = Read-Host 'Type ADMIN to confirm this account has the admin role in user_roles (a manager/user will give false failures)'
    if ($confirm -ceq 'ADMIN') { $tokens['admin2'] = $admin2Token } else { 'admin2 skipped (not confirmed as admin).' }
}

$results = New-Object System.Collections.Generic.List[object]
function Add-Result($fn, $who, $expect, $actual) {
    $ok = switch ($expect) {
        'PASS'   { $actual -notin @(0, 401, 403, 503) }
        'NOT503' { $actual -ne 503 -and $actual -ne 0 }
        default  { [string]$actual -eq $expect }
    }
    $results.Add([pscustomobject]@{ Function = $fn; Caller = $who; Expect = $expect; Got = $actual; Result = $(if ($ok) { 'PASS' } else { 'FAIL' }); Note = $(if (-not $ok -or $actual -eq 503) { $script:LastNote } else { '' }) })
}

foreach ($fn in ($safeFunctions + $contractsFunctions)) {
    $isContracts = $fn -in $contractsFunctions
    $body = if ($isContracts) { $contractsBody } else { '{}' }

    Add-Result $fn 'anonymous' '401' (Invoke-Function $fn $null $body)
    Add-Result $fn 'malformed token' '401' (Invoke-Function $fn 'not-a-jwt' $body)
    if ($tokens['user']) { Add-Result $fn 'normal user' '403' (Invoke-Function $fn $tokens['user'] $body) }

    # Managers are only allowed by invite-contracts-portal; elsewhere the role check (403) precedes the guard.
    if ($tokens['manager']) {
        if ($fn -eq 'invite-contracts-portal') {
            if ($State -eq 'ON') { Add-Result $fn 'manager' '503' (Invoke-Function $fn $tokens['manager'] $body) }
            # OFF: a manager would be allowed through to Contracts, so it is deliberately not sent.
        } else {
            Add-Result $fn 'manager' '403' (Invoke-Function $fn $tokens['manager'] $body)
        }
    }

    foreach ($who in @('superuser', 'admin2')) {
        if (-not $tokens[$who]) { continue }
        $isSuper = $who -eq 'superuser'
        if ($State -eq 'OFF') {
            if (-not $isContracts) { Add-Result $fn $who 'PASS' (Invoke-Function $fn $tokens[$who] $body) }
        } elseif ($isSuper) {
            if (-not $isContracts) { Add-Result $fn $who 'PASS' (Invoke-Function $fn $tokens[$who] $body) }
        } else {
            Add-Result $fn $who '503' (Invoke-Function $fn $tokens[$who] $body)
        }
    }
}

# Notification functions must be unaffected by maintenance: an UNSIGNED request is rejected by HMAC auth
# (never by maintenance) and performs no work. 404 means the function is not deployed in TESTING.
foreach ($fn in @('notify-defect', 'notify-expiring-invites')) {
    Add-Result $fn 'unsigned' 'NOT503' (Invoke-Function $fn $null '{}')
}

$results | Format-Table -AutoSize
$failed = @($results | Where-Object Result -eq 'FAIL').Count
if (-not $tokens['admin2']) { 'NOTE: no second admin supplied, so "normal admin receives 503" was NOT exercised live.' }
if ($State -eq 'OFF') { 'Any 503 above while OFF is a failure (guard cannot read the setting or Super User).' }
if ($failed) { throw "$failed case(s) failed. Return Maintenance Mode to OFF if it is ON." }
"All $($results.Count) cases passed for state $State."
