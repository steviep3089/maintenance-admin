param(
  # TESTING division id. Omit to verify that a defect with no division is skipped (nothing sent, no all-admin fallback).
  [string]$DivisionId = ''
)

$ErrorActionPreference = 'Stop'

if ($DivisionId -and $DivisionId -notmatch '^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$') {
  throw 'DivisionId must be a UUID'
}

# Safe manual probe for the production-package defect endpoint (TESTING ONLY).
#
# Auth model:
# - HMAC-SHA256 signed request (no raw secret in headers).
#
# Safety properties:
# - Hardcoded to the testing project ref.
# - Includes dryRun=true in the signed body; testing deployment must force ALLOW_DRY_RUN=true.
# - Prints only allowlisted result fields, not the full response body.
#
# NOTE: ALLOW_DRY_RUN=true in the testing deployment forces dry-run behavior.

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
$PathAndQuery = '/functions/v1/prodcheck-notify-defect'

Write-Host "Target: $BaseUrl (testing only)"
$confirm = Read-Host 'Verify testing ALLOW_DRY_RUN=true, then type DRYRUN'
if ($confirm -ne 'DRYRUN') {
  throw 'Cancelled'
}

$signingKey = Read-PlainSecret 'DEFECT_WEBHOOK_SIGNING_KEY (testing only; may reuse DEFECT_WEBHOOK_SECRET)'

$requestId = "prodcheck:notify-defect:$([guid]::NewGuid().ToString())"
$timestamp = [int][DateTimeOffset]::UtcNow.ToUnixTimeSeconds()

# Fake defect payload (no real data)
$bodyObj = @{
  dryRun = $true
  id = '00000000-0000-0000-0000-000000000000'
  asset = 'TEST-ASSET'
  title = 'TEST defect notification (forced dry run)'
  description = 'This is a dry-run test payload. No emails should be sent.'
  category = 'Test'
  submitted_by = 'test@example.invalid'
  status = 'Reported'
  priority = 3
}
if ($DivisionId) { $bodyObj['division_id'] = $DivisionId }

# Use a stable JSON string (ConvertTo-Json -Compress) and sign the exact bytes we send.
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

$expectedMessages = if ($DivisionId) {
  @('Dry run: notification skipped', 'No eligible recipients')
} else {
  @('No division assigned; notification skipped')
}

if (
  $resp.StatusCode -ne 200 -or
  $result.success -ne $true -or
  $expectedMessages -notcontains $result.message -or
  $result.sent -ne 0
) {
  Write-Host "HTTP $($resp.StatusCode); dry-run validation failed"
  exit 1
}

Write-Host "HTTP $($resp.StatusCode); success=true; sent=0; eligibleRecipients=$($result.total); outcome=$($result.message)"
