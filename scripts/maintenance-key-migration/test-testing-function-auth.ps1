
$ErrorActionPreference = 'Stop'

# TESTING ONLY - never target LIVE.
$projectRef = 'etffoumsopxjptnmhvwh'
$baseUrl = "https://$projectRef.supabase.co/functions/v1"
$publishableKey = $env:VITE_SUPABASE_PUBLISHABLE_KEY

# Exclude Contracts-integrated functions from this test.
$functionNames = @(
    'create-user',
    'delete-user',
    'get-admin-users',
    'resend-invite',
    'send-report-email',
    'upload-drive'
)

if (-not $publishableKey) {
    throw 'Set VITE_SUPABASE_PUBLISHABLE_KEY to the TESTING publishable key before running.'
}

function Get-ResponseStatus {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FunctionName,

        [Parameter(Mandatory = $true)]
        [hashtable]$Headers,

        [Parameter(Mandatory = $true)]
        [string]$Body
    )

    $uri = "$baseUrl/$FunctionName"

    try {
        $response = Invoke-WebRequest `
            -Uri $uri `
            -Method Post `
            -Headers $Headers `
            -ContentType 'application/json' `
            -Body $Body `
            -UseBasicParsing `
            -TimeoutSec 30

        return [int]$response.StatusCode
    }
    catch {
        if ($_.Exception.Response) {
            return [int]$_.Exception.Response.StatusCode
        }

        throw "Request to TESTING function '$FunctionName' failed before an HTTP response."
    }
}

function Assert-ExpectedStatus {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FunctionName,

        [Parameter(Mandatory = $true)]
        [hashtable]$Headers,

        [Parameter(Mandatory = $true)]
        [string]$Body,

        [Parameter(Mandatory = $true)]
        [int]$ExpectedStatus,

        [Parameter(Mandatory = $true)]
        [string]$CaseName
    )

    $actualStatus = Get-ResponseStatus `
        -FunctionName $FunctionName `
        -Headers $Headers `
        -Body $Body

    if ($actualStatus -ne $ExpectedStatus) {
        throw "$FunctionName $CaseName expected HTTP $ExpectedStatus; got HTTP $actualStatus."
    }

    Write-Output "PASS $FunctionName $CaseName HTTP $actualStatus"
}

$body = '{}'

$headers = @{
    apikey = $publishableKey
    Accept = 'application/json'
}

Write-Host 'Testing anonymous and malformed-token rejection...' -ForegroundColor Cyan

foreach ($functionName in $functionNames) {

    # Test 1: No user authentication token
    Assert-ExpectedStatus `
        -FunctionName $functionName `
        -Headers $headers `
        -Body $body `
        -ExpectedStatus 401 `
        -CaseName 'anonymous'

    # Test 2: Invalid authentication token
    $malformedHeaders = @{
        apikey = $publishableKey
        Accept = 'application/json'
        Authorization = 'Bearer not-a-valid-jwt'
    }

    Assert-ExpectedStatus `
        -FunctionName $functionName `
        -Headers $malformedHeaders `
        -Body $body `
        -ExpectedStatus 401 `
        -CaseName 'malformed-token'
}

Write-Host 'Anonymous and malformed-token tests completed.' -ForegroundColor Green

# Test 3: Authenticated non-admin user must be denied.
# Enter a TESTING-only access token. Do not use LIVE credentials.
$secureToken = Read-Host `
    'Paste a valid non-admin TESTING access token (input hidden)' `
    -AsSecureString

$tokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)

try {
    $nonAdminToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPointer)
}
finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer)
}

if (-not $nonAdminToken) {
    throw 'A valid non-admin TESTING access token is required.'
}

try {
    Write-Host 'Testing non-admin rejection...' -ForegroundColor Cyan

    foreach ($functionName in $functionNames) {

        $nonAdminHeaders = @{
            apikey = $publishableKey
            Accept = 'application/json'
            Authorization = "Bearer $nonAdminToken"
        }

        Assert-ExpectedStatus `
            -FunctionName $functionName `
            -Headers $nonAdminHeaders `
            -Body $body `
            -ExpectedStatus 403 `
            -CaseName 'non-admin'
    }

    Write-Host 'All 18 TESTING authentication checks passed.' -ForegroundColor Green
}
finally {
    $nonAdminToken = $null
    $secureToken = $null
}
