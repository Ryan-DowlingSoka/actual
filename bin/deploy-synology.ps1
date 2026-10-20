<#
.SYNOPSIS
  Deploy the Actual server and bank importer to the Synology NAS from PowerShell.

.DESCRIPTION
  Runs bin/deploy-synology with Git for Windows' bash. The deploy streams
  binary image data (docker save | gzip | ssh), which Windows PowerShell
  pipelines would corrupt, so the work itself stays in the bash script.

.EXAMPLE
  .\bin\deploy-synology.ps1 <ssh-user>
  .\bin\deploy-synology.ps1 <ssh-user> importer
  .\bin\deploy-synology.ps1 <ssh-user> all --redeploy <tag>
#>

$ErrorActionPreference = 'Stop'

# Git for Windows' bash, found from git itself (not WSL's bash.exe in System32).
$git = Get-Command git -ErrorAction SilentlyContinue
if (-not $git) {
  throw 'git was not found on PATH; install Git for Windows.'
}
$bash = Join-Path (Split-Path (Split-Path $git.Source)) 'bin\bash.exe'
if (-not (Test-Path $bash)) {
  throw "Git Bash was not found at $bash."
}

$repo = Split-Path $PSScriptRoot
Push-Location $repo
try {
  & $bash bin/deploy-synology @args
  $code = $LASTEXITCODE
} finally {
  Pop-Location
}
exit $code
