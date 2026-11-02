<#
  Project audit. It is performed by Freebuff (the agent), not by the AI models
  in the chat: the models are the object under test, not the auditor.
  The script never asks a model to "audit" anything and spends no model quota
  unless you pass -Deep.

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File agent-health/audit.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File agent-health/audit.ps1 -Deep

  Log: agent-health/logs/YYYY-MM-DD.log
  Exit code: 0 = all good, 1 = something failed.

  NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads BOM-less UTF-8 as
  ANSI, and a multi-byte character can turn into a quote and break parsing.
#>
param(
  [string]$BaseUrl = 'http://127.0.0.1:5174',
  [switch]$Deep
)

$ErrorActionPreference = 'Stop'

$healthDir = Split-Path -Parent $PSCommandPath
$repoDir = Split-Path -Parent $healthDir
$logDir = Join-Path $healthDir 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir ("{0}.log" -f (Get-Date -Format 'yyyy-MM-dd'))

$script:passed = 0
$script:failed = 0

function Write-Log([string]$Line) {
  $entry = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Line
  Write-Host $entry
  Add-Content -Path $logFile -Value $entry
}

function Assert([string]$Name, [bool]$Ok, [string]$Detail = '') {
  $suffix = ''
  if ($Detail) { $suffix = ' -- ' + $Detail }
  if ($Ok) {
    $script:passed++
    Write-Log ('PASS  ' + $Name + $suffix)
  } else {
    $script:failed++
    Write-Log ('FAIL  ' + $Name + $suffix)
  }
}

function Invoke-Api {
  param(
    [string]$Method = 'GET',
    [string]$Path = '/',
    [string]$Body
  )
  $request = @{
    Uri             = "$BaseUrl$Path"
    Method          = $Method
    UseBasicParsing = $true
    TimeoutSec      = 25
  }
  if ($PSBoundParameters.ContainsKey('Body')) {
    $request['Body'] = $Body
    $request['ContentType'] = 'application/json'
  }
  try {
    $response = Invoke-WebRequest @request
    return @{ Status = [int]$response.StatusCode; Body = [string]$response.Content }
  } catch {
    $response = $_.Exception.Response
    if ($response -and $response.StatusCode) {
      $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
      $content = $reader.ReadToEnd()
      $reader.Dispose()
      return @{ Status = [int]$response.StatusCode; Body = $content }
    }
    return @{ Status = 0; Body = $_.Exception.Message }
  }
}

function Run-Git([string[]]$GitArgs) {
  Push-Location $repoDir
  $previous = $ErrorActionPreference
  # git writes expected misses to stderr; with Stop that would abort the audit.
  $ErrorActionPreference = 'Continue'
  try {
    $output = & git @GitArgs 2>&1
    $code = $LASTEXITCODE
    $lines = @($output | ForEach-Object { [string]$_ })
    return @{ Code = $code; Output = $lines }
  } finally {
    $ErrorActionPreference = $previous
    Pop-Location
  }
}

Write-Log ('=== audit start: ' + $BaseUrl + ' (mode: ' + $(if ($Deep) { 'deep' } else { 'contract-only' }) + ') ===')

# 1. Static page is served and has its mount point.
$page = Invoke-Api -Path '/'
Assert 'page answers 200' ($page.Status -eq 200) ('status ' + $page.Status)
Assert 'page contains #root' ($page.Body -match 'id="root"') 'mount point present'

# 2. API contract: method and body are validated server side, no model needed.
$wrongMethod = Invoke-Api -Method 'GET' -Path '/api/chat'
Assert 'api/chat rejects GET' ($wrongMethod.Status -eq 405) ('status ' + $wrongMethod.Status)

$badJson = Invoke-Api -Method 'POST' -Path '/api/chat' -Body '{not json'
Assert 'api/chat rejects malformed JSON' ($badJson.Status -in 400, 500) ('status ' + $badJson.Status)

$empty = Invoke-Api -Method 'POST' -Path '/api/chat' -Body '{}'
Assert 'api/chat requires a question' ($empty.Status -eq 400) ('status ' + $empty.Status)

$noModels = Invoke-Api -Method 'POST' -Path '/api/chat' -Body '{"models":[],"text":"1+1"}'
Assert 'api/chat requires a model' ($noModels.Status -eq 400) ('status ' + $noModels.Status)

# 3. Source-level checks (static audit, no requests to providers).
$noStore = Run-Git @('grep', '-l', 'no-store', '--', 'api')
Assert 'handler marks responses no-store' ($noStore.Code -eq 0) ($noStore.Output -join ', ')

# Exclude this script: it contains the pattern itself and is not a secret.
$keyLeak = Run-Git @('grep', '-l', '-E', 'sk-or-v1-|orcarouter[_-]?[A-Za-z0-9]{20,}', '--', '.', ':(exclude)agent-health/audit.ps1')
Assert 'no API keys in tracked files' ($keyLeak.Code -ne 0) $(if ($keyLeak.Code -eq 0) { 'found in: ' + ($keyLeak.Output -join ', ') } else { 'clean' })

$envTracked = Run-Git @('ls-files', '--error-unmatch', '.env')
Assert '.env is not tracked by git' ($envTracked.Code -ne 0) $(if ($envTracked.Code -eq 0) { 'staged: run git rm --cached .env' } else { 'ignored' })

$secretsIgnored = Run-Git @('check-ignore', '.env')
Assert '.env matches gitignore' ($secretsIgnored.Code -eq 0) $(if ($secretsIgnored.Code -eq 0) { $secretsIgnored.Output -join ', ' } else { 'not ignored' })

# 4. Secrets in the environment: names are counted, values are never printed.
$keyNames = @('OPENROUTER_API_KEY', 'ORCAROUTER_API_KEY', 'OPENROUTER_API_KEY2', 'ORCAROUTER_API_KEY2')
$setKeys = 0
foreach ($name in $keyNames) {
  if ([Environment]::GetEnvironmentVariable($name)) { $setKeys++ }
}
Write-Log ('INFO  provider keys in this process: ' + $setKeys + ' of ' + $keyNames.Length + ' (values not read)')

# 5. Optional deep check: one real model request. Still run by the agent --
#    the model here is just the thing being observed, never the auditor.
if ($Deep) {
  $body = '{"models":["claude"],"text":"6 x 9? A) 54 B) 45 C) 63 D) 56","image":"","history":[],"memory":0}'
  $live = Invoke-Api -Method 'POST' -Path '/api/chat' -Body $body
  $shape = $false
  $note = ''
  if ($live.Status -eq 200) {
    try {
      $data = $live.Body | ConvertFrom-Json
      $first = $data.responses[0]
      $shape = [bool]($first.id -and $first.label -and $first.text -and -not $first.error)
      $note = 'id=' + $first.id + ' error=' + $first.error + ' reason=' + $first.reason + ' ms=' + $first.ms
    } catch {
      $note = 'response is not valid JSON'
    }
  } else {
    $note = 'status ' + $live.Status
  }
  Assert 'live model reply' $shape $note
}

Write-Log ('=== audit done: passed=' + $script:passed + ' failed=' + $script:failed + ' log=' + $logFile + ' ===')

if ($script:failed -gt 0) { exit 1 }
exit 0
