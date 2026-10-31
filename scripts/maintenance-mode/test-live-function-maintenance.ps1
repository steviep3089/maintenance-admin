$ErrorActionPreference = 'Stop'

# LIVE ONLY (zebksrihswwwlejdiboq). Run by the owner with Maintenance Mode OFF. Sends the only requests it makes.
#
# Safety:
#  * Anonymous and malformed-token requests go to all eight functions; they are rejected before any work.
#  * The Super User is sent ONE request with an empty JSON body to each of the six non-Contracts functions only
#    (create-user, delete-user, get-admin-users, resend-invite, send-report-email, upload-drive), which fail input
#    validation before creating, deleting, emailing or uploading anything.
#  * list-users and invite-contracts-portal can reach Contracts, so they never receive an authenticated request.
#  * The password and token are never printed or written to disk; only name/expected/actual/result are shown.
$projectRef = 'zebksrihswwwlejdiboq'
$baseUrl = "https://$projectRef.supabase.co"
# Pasted values often carry spaces, line breaks or quotes, which make a valid key fail as "Invalid API key".
$publishableKey = ([string]$env:LIVE_SUPABASE_PUBLISHABLE_KEY).Trim().Trim('"', "'").Trim()
if (-not $publishableKey) { throw 'Set LIVE_SUPABASE_PUBLISHABLE_KEY to the LIVE publishable key (sb_publishable_...).' }
if ($publishableKey -notlike 'sb_publishable_*') { throw 'That is not a publishable key. Never use a secret or legacy key here.' }

$allFunctions = @('create-user', 'delete-user', 'get-admin-users', 'list-users', 'resend-invite', 'send-report-email', 'upload-drive', 'invite-contracts-portal')
$safeFunctions = @('create-user', 'delete-user', 'get-admin-users', 'resend-invite', 'send-report-email', 'upload-drive')

function Get-SuperUserToken {
    $email = (Read-Host 'LIVE Super User email').Trim()
    $secure = Read-Host 'Password' -AsSecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
        $body = @{ email = $email; password = $password } | ConvertTo-Json
        try {
            $resp = Invoke-RestMethod -Method Post -Uri "$baseUrl/auth/v1/token?grant_type=password" `
                -Headers @{ apikey = $publishableKey } -ContentType 'application/json' -Body $body
        } catch {
            # Only the HTTP status and a short lowercase error code are shown, never the body, key or credentials.
            $status = 0; $code = 'none'
            if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
            $raw = ''
            if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $raw = $_.ErrorDetails.Message }
            elseif ($_.Exception.Response) {
                try { $raw = (New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())).ReadToEnd() } catch { }
            }
            try {
                $j = $raw | ConvertFrom-Json
                $c = if ($j.error_code) { [string]$j.error_code } elseif ($j.code -is [string]) { [string]$j.code } else { '' }
                if ($c -match '^[a-z_]{1,40}$') { $code = $c }
            } catch { }
            throw "Sign-in failed: HTTP $status, error_code=$code. (400 invalid_credentials = wrong email/password; 401/403 or invalid_api_key = wrong key; status 0 = network/TLS.)"
        }
        if (-not $resp.access_token) { throw 'Sign-in returned no access token (an MFA or unconfirmed account would do this).' }
        $resp.access_token
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
        $password = $null; $body = $null
    }
}

function Invoke-Function([string]$name, [string]$token, [string]$body) {
    $headers = @{ apikey = $publishableKey }
    if ($token) { $headers.Authorization = "Bearer $token" }
    try {
        $r = Invoke-WebRequest -Uri "$baseUrl/functions/v1/$name" -Method Post -Headers $headers `
            -ContentType 'application/json' -Body $body -UseBasicParsing
        [int]$r.StatusCode
    } catch {
        if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
    }
}

$results = New-Object System.Collections.Generic.List[object]
function Add-Result([string]$fn, [string]$caller, [string]$expected, [int]$actual) {
    $ok = if ($expected -eq 'not 401/403/503') { $actual -notin @(0, 401, 403, 503) } else { [string]$actual -eq $expected }
    $results.Add([pscustomobject]@{ Function = $fn; Caller = $caller; Expected = $expected; Actual = $actual; Result = $(if ($ok) { 'PASS' } else { 'FAIL' }) })
}

foreach ($fn in $allFunctions) {
    Add-Result $fn 'anonymous' '401' (Invoke-Function $fn $null '{}')
    Add-Result $fn 'malformed token' '401' (Invoke-Function $fn 'not-a-jwt' '{}')
}

$token = Get-SuperUserToken
try {
    foreach ($fn in $safeFunctions) {
        Add-Result $fn 'Super User' 'not 401/403/503' (Invoke-Function $fn $token '{}')
    }
} finally { $token = $null }

$results | Format-Table Function, Caller, Expected, Actual, Result -AutoSize
$failed = @($results | Where-Object Result -eq 'FAIL').Count
if ($failed) { throw "$failed case(s) failed. A 503 for the Super User while OFF means the guard cannot read the setting; do not enable maintenance." }
"All $($results.Count) cases passed."
