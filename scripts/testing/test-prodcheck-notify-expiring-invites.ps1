$ErrorActionPreference = 'Stop'

# Safe manual probe for the production-package digest endpoint (TESTING ONLY).
#
# Auth model:
# - HMAC-SHA256 signed request (no raw secret in headers).
#
# Safety properties:
# - Hardcoded to the testing project ref.
# - Forces dry-run and disallows deactivation in the request body.
# - Requires the testing function to have ALLOW_DRY_RUN=true, which forces dry-run behavior.
# - Prints only allowlisted result fields, not the full response body.
#
# NOTE: ALLOW_DRY_RUN=true in the testing deployment forces dry-run behavior.
# The function may still write audit logs.

function Read-PlainSecret([string]$Prompt) {
  $secure = Read-Host -AsSecureString $Prompt
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}

function To-Hex([byte[]]$Bytes) {
  ($Bytes | ForEach-Object { $_.ToString('x2') }) -join ''
}

function Get-Sha256Hex([string]$Text) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
    return To-Hex ($sha.ComputeHash($bytes))
  } finally {
    $sha.Dispose()
  }
}

function Get-HmacSha256Hex([string]$Key, [string]$Text) {
  $keyBytes = [Text.Encoding]::UTF8.GetBytes($Key)
  try {
    $h = [System.Security.Cryptography.HMACSHA256]::new($keyBytes)
    try {
      $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
      return To-Hex ($h.ComputeHash($bytes))
    } finally {
      $h.Dispose()
    }
  } finally {
    [Array]::Clear($keyBytes, 0, $keyBytes.Length)
  }
}

$ProjectRef = 'etffoumsopxjptnmhvwh'
$BaseUrl = "https://$ProjectRef.supabase.co"
$PathAndQuery = '/functions/v1/prodcheck-notify-expiring-invites'

Write-Host "Target: $BaseUrl (testing only)"
$confirm = Read-Host 'Verify testing ALLOW_DRY_RUN=true, then type DRYRUN'
if ($confirm -ne 'DRYRUN') {
  throw 'Cancelled'
}

$signingKey = Read-PlainSecret 'INVITE_DIGEST_SIGNING_KEY (testing only; may reuse INVITE_DIGEST_SECRET)'

$requestId = "prodcheck:notify-expiring-invites:$([guid]::NewGuid().ToString())"
$timestamp = [int][DateTimeOffset]::UtcNow.ToUnixTimeSeconds()

$bodyObj = @{
  dryRun = $true
  allowDeactivation = $false
}

$body = $bodyObj | ConvertTo-Json -Depth 5 -Compress
$bodySha = Get-Sha256Hex $body

$canonical = "v1`n$timestamp`n$requestId`nPOST`n$PathAndQuery`n$bodySha"
try {
  $sigHex = Get-HmacSha256Hex -Key $signingKey -Text $canonical
} finally {
  $signingKey = $null
}

$headers = @{
  'Content-Type' = 'application/json'
  'x-request-id' = $requestId
  'x-timestamp' = "$timestamp"
  'x-signature' = "v1=$sigHex"
}

try {
  $bodyBytes = [Text.Encoding]::UTF8.GetBytes($body)
  $resp = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$BaseUrl$PathAndQuery" -Headers $headers -Body $bodyBytes
} catch {
  $r = $_.Exception.Response
  if ($r) {
    Write-Host "Request failed: HTTP $([int]$r.StatusCode)"
  } else {
    Write-Host 'Request failed (no response)'
  }
  exit 1
}

$result = $null
try {
  $result = $resp.Content | ConvertFrom-Json
} catch {
  Write-Host "HTTP $($resp.StatusCode); response was not valid JSON"
  exit 1
}

if (
  $resp.StatusCode -ne 200 -or
  $result.success -ne $true -or
  $result.dryRun -ne $true -or
  $result.deactivationEnabled -ne $false -or
  $result.deactivated -ne 0
) {
  Write-Host "HTTP $($resp.StatusCode); dry-run/deactivation validation failed"
  exit 1
}

Write-Host "HTTP $($resp.StatusCode); success=true; dryRun=true; deactivationEnabled=false; deactivated=0"
