$ErrorActionPreference = 'Stop'

$Repo = 'wczvonce/ekasa-skener-mobile'
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

Write-Host "eKasa Skener - vytvorenie samostatneho GitHub repozitara" -ForegroundColor Cyan

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw 'Git nie je nainstalovany. Nainstaluj Git for Windows a spusti skript znovu.'
}

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-Host 'Instalujem oficialny GitHub CLI cez winget...'
        winget install --id GitHub.cli --exact --source winget --accept-package-agreements --accept-source-agreements
        $env:Path += ';C:\Program Files\GitHub CLI'
    }
}

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    throw 'GitHub CLI sa nepodarilo najst. Nainstaluj ho prikazom: winget install --id GitHub.cli'
}

try {
    gh auth status | Out-Host
} catch {
    Write-Host 'Otvaram oficialne prihlasenie do GitHubu...' -ForegroundColor Yellow
    gh auth login --hostname github.com --git-protocol https --web
}

$existing = $false
try {
    gh repo view $Repo --json nameWithOwner *> $null
    $existing = $true
} catch {
    $existing = $false
}

Set-Location $ProjectRoot

if (Test-Path '.git') {
    $currentRemote = git remote get-url origin 2>$null
    if ($LASTEXITCODE -eq 0 -and $currentRemote -match 'nezabudni-apk') {
        Write-Host 'Odstranujem historiu povodneho nesuvisiaceho repozitara a vytvaram cisty eKasa Git.' -ForegroundColor Yellow
        Remove-Item -Recurse -Force '.git'
    }
}

if (-not (Test-Path '.git')) {
    git init -b main
}

git add .
$hasHead = $true
git rev-parse --verify HEAD *> $null
if ($LASTEXITCODE -ne 0) { $hasHead = $false }

$hasChanges = $false
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) { $hasChanges = $true }

if (-not $hasHead -or $hasChanges) {
    git commit -m 'Initialize eKasa Skener Mobile'
}

if (-not $existing) {
    Write-Host "Vytvaram sukromny repozitar $Repo..." -ForegroundColor Cyan
    gh repo create $Repo --private --source=. --remote=origin --push
} else {
    Write-Host "Repozitar $Repo uz existuje. Pripajam ho ako origin." -ForegroundColor Yellow
    if ((git remote) -contains 'origin') {
        git remote set-url origin "https://github.com/$Repo.git"
    } else {
        git remote add origin "https://github.com/$Repo.git"
    }
    git branch -M main
    git push -u origin main
}

Write-Host "Hotovo: https://github.com/$Repo" -ForegroundColor Green
Write-Host 'Teraz spusti Claude Code v tomto priecinku a napis: Precitaj CLAUDE.md a vykonaj ho.' -ForegroundColor Green
