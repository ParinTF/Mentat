# KernelForge host readiness check (read-only).
# Usage:  powershell -ExecutionPolicy Bypass -File runner\check-env.ps1
# Nothing is installed or modified. Messages are ASCII on purpose so the output
# survives any console code page.

$ErrorActionPreference = 'SilentlyContinue'
$results = @()

function Add-Result {
  param([string]$Name, [bool]$Ok, [string]$Detail, [string]$Fix = '')
  $script:results += [pscustomobject]@{ Check = $Name; Ok = $Ok; Detail = $Detail; Fix = $Fix }
}

# --- Windows / privileges -------------------------------------------------
$os = Get-CimInstance Win32_OperatingSystem
Add-Result 'Windows build' ($os.BuildNumber -ge 19041) "$($os.Caption) build $($os.BuildNumber)" 'WSL2 needs Windows 10 2004+ / Windows 11.'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Add-Result 'Administrator shell' $isAdmin $(if ($isAdmin) { 'elevated' } else { 'not elevated' }) 'Docker and WSL installation need an elevated shell.'

$cs = Get-CimInstance Win32_ComputerSystem
Add-Result 'Hypervisor present' ([bool]$cs.HypervisorPresent) "$([bool]$cs.HypervisorPresent)" 'Enable Virtualization (VT-x) in BIOS/UEFI.'

# --- Hardware sizing ------------------------------------------------------
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
Add-Result 'CPU cores' ($cpu.NumberOfLogicalProcessors -ge 4) "$($cpu.Name) - $($cpu.NumberOfCores)C/$($cpu.NumberOfLogicalProcessors)T" 'Runner containers are capped to 2 CPUs on this class of machine.'

$ramGb = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1)
Add-Result 'RAM' ($ramGb -ge 8) "$ramGb GB" 'Cap WSL2 memory in %USERPROFILE%\.wslconfig so the host stays responsive.'

$workspaceDrive = (Get-Item $PSScriptRoot).PSDrive
$freeGb = [math]::Round($workspaceDrive.Free / 1GB, 1)
Add-Result 'Free disk (workspace drive)' ($freeGb -ge 40) "$($workspaceDrive.Name): $freeGb GB free" 'CPU-only Python images need ~4 GB; CUDA images need 15 GB+.'

# --- GPU ------------------------------------------------------------------
$gpus = (Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name) -join '; '
$hasNvidia = [bool](Get-Command nvidia-smi)
Add-Result 'NVIDIA GPU + driver' $hasNvidia $gpus 'No NVIDIA GPU here, so CUDA/Triton submissions cannot execute on this host. CPU execution and the roofline model still work.'

# --- WSL ------------------------------------------------------------------
$wslCli = [bool](Get-Command wsl.exe)
$wslVersionOutput = if ($wslCli) { (wsl.exe --version 2>&1 | Out-String) } else { '' }
$wslInstalled = $wslCli -and ($wslVersionOutput -notmatch 'not installed') -and ($LASTEXITCODE -eq 0)
Add-Result 'WSL2 installed' $wslInstalled $(if ($wslInstalled) { 'wsl --version succeeded' } else { 'wsl.exe present but WSL is not installed' }) 'Run: wsl --install -d Ubuntu  (then reboot once).'

$distroList = if ($wslInstalled) { (wsl.exe -l -q 2>&1 | Out-String).Trim() } else { '' }
$hasDistro = $distroList -ne ''
Add-Result 'Linux distro registered' $hasDistro $(if ($hasDistro) { $distroList -replace "`r?`n", ', ' } else { 'none' }) 'wsl --install -d Ubuntu creates the default distro.'
# --- Docker ---------------------------------------------------------------
$dockerCli = [bool](Get-Command docker.exe)
Add-Result 'Docker CLI on PATH' $dockerCli $(if ($dockerCli) { (docker --version 2>&1 | Out-String).Trim() } else { 'not found' }) 'Install Docker Engine inside WSL2 Ubuntu (recommended) or Docker Desktop.'

$daemon = $false
$daemonDetail = 'not reachable'
if ($dockerCli) {
  $job = Start-Job -ScriptBlock { docker info --format '{{.ServerVersion}}|{{.OSType}}' 2>&1 | Out-String }
  if (Wait-Job $job -Timeout 12) {
    $daemonDetail = (Receive-Job $job).Trim()
    $daemon = $daemonDetail -notmatch 'error|Cannot connect|not found'
  } else {
    Stop-Job $job
    $daemonDetail = 'timeout after 12s'
  }
  Remove-Job $job -Force
}
Add-Result 'Docker daemon reachable' $daemon $daemonDetail 'Start the daemon: sudo service docker start  (inside WSL Ubuntu).'

# --- Python ---------------------------------------------------------------
$py = Get-Command python.exe
$pyPath = if ($py) { $py.Source } else { '' }
$isStoreAlias = $pyPath -match 'WindowsApps'
$pyOk = $false
$pyDetail = 'not found'
if ($pyPath -and -not $isStoreAlias) {
  $pyVersion = (python --version 2>&1 | Out-String).Trim()
  $pyOk = $pyVersion -match 'Python 3\.(1[0-9]|[89])'
  $pyDetail = $pyVersion
} elseif ($isStoreAlias) {
  $pyDetail = 'only the Microsoft Store alias is present (no real interpreter)'
}
Add-Result 'Python 3.9+ on host' $pyOk $pyDetail 'Optional on Windows: the worker runs inside Linux containers. winget install Python.Python.3.12'

# --- Node -----------------------------------------------------------------
$node = Get-Command node.exe
$nodeOk = $false
$nodeDetail = 'not found'
if ($node) {
  $nodeVersion = (node --version 2>&1 | Out-String).Trim()
  $major = [int]$nodeVersion.TrimStart('v').Split('.')[0]
  $nodeOk = $major -ge 22
  $nodeDetail = $nodeVersion
}
Add-Result 'Node.js 22+' $nodeOk $nodeDetail 'Needed for the playground and the contract tests.'

# --- Report ---------------------------------------------------------------
Write-Host ''
Write-Host 'KernelForge host readiness'
Write-Host '=========================='
$results | Format-Table -AutoSize | Out-String -Width 200 | Write-Host
foreach ($result in $results) {
  if (-not $result.Ok -and $result.Fix) { Write-Host ("  => {0}: {1}" -f $result.Check, $result.Fix) }
}

$coreChecks = 'Node.js 22+', 'WSL2 installed', 'Linux distro registered', 'Docker CLI on PATH', 'Docker daemon reachable'
$missing = @($results | Where-Object { $_.Check -in $coreChecks -and -not $_.Ok })
Write-Host ''
if ($missing.Count -eq 0) {
  Write-Host 'RESULT: READY for the Linux container runner (CPU execution).'
  exit 0
}
Write-Host ("RESULT: NOT READY - missing: {0}" -f (($missing | Select-Object -ExpandProperty Check) -join ', '))
exit 1