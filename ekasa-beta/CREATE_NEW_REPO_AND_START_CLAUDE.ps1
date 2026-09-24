$ErrorActionPreference = 'Stop'

$SourceRepo = 'https://github.com/wczvonce/nezabudni-apk.git'
$SourceBranch = 'ekasa-claude-code-handoff'
$TargetRepo = 'wczvonce/ekasa-skener-mobile'
$TargetRepoUrl = "https://github.com/$TargetRepo"
$Description = 'Mobilná Android aplikácia na skenovanie slovenských eKasa bločkov'

function Refresh-Path {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machine;$user"
}

function Ensure-Command([string]$Command, [string]$WingetId, [string]$Label) {
    if (Get-Command $Command -ErrorAction SilentlyContinue) { return }
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw "$Label nie je nainštalovaný a v počítači nie je dostupný winget. Nainštaluj $Label a spusti skript znova."
    }
    Write-Host "Inštalujem $Label..." -ForegroundColor Yellow
    winget install --id $WingetId --exact --source winget --accept-package-agreements --accept-source-agreements
    Refresh-Path
    if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
        throw "$Label sa nepodarilo nájsť ani po inštalácii. Zavri PowerShell, otvor ho znova a spusti skript ešte raz."
    }
}

Write-Host ''
Write-Host '=== eKasa Skener: nový GitHub repozitár + Claude Code ===' -ForegroundColor Cyan
Write-Host ''

Ensure-Command 'git' 'Git.Git' 'Git for Windows'
Ensure-Command 'gh' 'GitHub.cli' 'GitHub CLI'

Write-Host 'Kontrolujem prihlásenie do GitHubu...' -ForegroundColor Cyan
& gh auth status *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host 'Otvorí sa oficiálne prihlásenie do GitHubu.' -ForegroundColor Yellow
    & gh auth login --hostname github.com --git-protocol https --web
    if ($LASTEXITCODE -ne 0) { throw 'Prihlásenie do GitHubu nebolo dokončené.' }
}

$Base = Join-Path $HOME 'Documents\ClaudeCode'
New-Item -ItemType Directory -Force -Path $Base | Out-Null
$ProjectDir = Join-Path $Base 'ekasa-skener-mobile'
if (Test-Path $ProjectDir) {
    $suffix = Get-Date -Format 'yyyyMMdd-HHmmss'
    $ProjectDir = Join-Path $Base "ekasa-skener-mobile-$suffix"
}
$TempDir = Join-Path ([IO.Path]::GetTempPath()) ("ekasa-source-" + [Guid]::NewGuid().ToString('N'))

try {
    Write-Host 'Sťahujem pripravený eKasa projekt...' -ForegroundColor Cyan
    & git clone --depth 1 --branch $SourceBranch --single-branch $SourceRepo $TempDir
    if ($LASTEXITCODE -ne 0) { throw 'Zdrojový projekt sa nepodarilo stiahnuť.' }

    New-Item -ItemType Directory -Force -Path $ProjectDir | Out-Null
    Copy-Item -Path (Join-Path $TempDir 'ekasa-beta\*') -Destination $ProjectDir -Recurse -Force

    $WorkflowSource = Join-Path $TempDir '.github\workflows\ekasa-beta-apk.yml'
    if (Test-Path $WorkflowSource) {
        $WorkflowDir = Join-Path $ProjectDir '.github\workflows'
        New-Item -ItemType Directory -Force -Path $WorkflowDir | Out-Null
        Copy-Item $WorkflowSource (Join-Path $WorkflowDir 'android-apk.yml') -Force
    }

    $NestedGit = Join-Path $ProjectDir '.git'
    if (Test-Path $NestedGit) { Remove-Item -Recurse -Force $NestedGit }

    Set-Location $ProjectDir
    & git init -b main
    & git config user.name 'Ivan Povraznik'
    & git config user.email 'wczvonce@gmail.com'
    & git add .
    & git commit -m 'Initialize eKasa Skener Mobile'
    if ($LASTEXITCODE -ne 0) { throw 'Nepodarilo sa vytvoriť prvý Git commit.' }

    & gh repo view $TargetRepo --json nameWithOwner *> $null
    $repoExists = ($LASTEXITCODE -eq 0)

    if (-not $repoExists) {
        Write-Host "Vytváram nový súkromný repozitár $TargetRepo..." -ForegroundColor Cyan
        & gh repo create $TargetRepo --private --description $Description --source . --remote origin --push
        if ($LASTEXITCODE -ne 0) { throw 'Nový GitHub repozitár sa nepodarilo vytvoriť.' }
    }
    else {
        Write-Host "Repozitár $TargetRepo už existuje. Pripájam a pushujem projekt..." -ForegroundColor Yellow
        & git remote add origin "$TargetRepoUrl.git"
        if ($LASTEXITCODE -ne 0) {
            & git remote set-url origin "$TargetRepoUrl.git"
        }
        & git push -u origin main
        if ($LASTEXITCODE -ne 0) {
            throw 'Repozitár už obsahuje inú históriu. Otvor ho na GitHube, odstráň úvodný README alebo použi Claude Code na bezpečný import bez straty dát.'
        }
    }

    $PromptFile = Join-Path $ProjectDir 'PASTE_INTO_CLAUDE_CODE.txt'
    if (Test-Path $PromptFile) {
        Get-Content $PromptFile -Raw | Set-Clipboard
    }

    Write-Host ''
    Write-Host 'HOTOVO.' -ForegroundColor Green
    Write-Host "Nový repozitár: $TargetRepoUrl" -ForegroundColor Green
    Write-Host "Lokálny projekt: $ProjectDir" -ForegroundColor Green
    Write-Host 'Claude Code prompt je skopírovaný do schránky.' -ForegroundColor Green
    Write-Host ''
    Write-Host 'V ďalšom kroku:' -ForegroundColor Cyan
    Write-Host "1. Otvor priečinok: $ProjectDir"
    Write-Host '2. Spusti: claude'
    Write-Host '3. Stlač Ctrl+V a Enter.'

    Start-Process $TargetRepoUrl

    if (Get-Command claude -ErrorAction SilentlyContinue) {
        Write-Host ''
        Write-Host 'Spúšťam Claude Code v projekte. Prompt vlož cez Ctrl+V.' -ForegroundColor Cyan
        & claude
    }
}
finally {
    if (Test-Path $TempDir) {
        Remove-Item -Recurse -Force $TempDir -ErrorAction SilentlyContinue
    }
}
