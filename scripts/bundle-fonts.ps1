# Fetch the two web fonts into static/fonts, so the desktop build needs no network.
#
# The web build links Google Fonts directly, which is fine for a hosted page and wrong
# for a desktop application: offline (or behind a proxy that blocks fonts.googleapis.com)
# the interface would fall back to whatever the system has. This script downloads the
# latin subsets once and writes a local stylesheet beside them.
#
# Run it from the project root:  powershell -File scripts\bundle-fonts.ps1

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root 'static\fonts'
New-Item -ItemType Directory -Force $outDir | Out-Null

# A modern Chrome UA, because Google serves woff2 only to browsers that ask for it.
$ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
$cssUrl = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap'

Write-Host "GET $cssUrl"
$css = (Invoke-WebRequest -Uri $cssUrl -UserAgent $ua -UseBasicParsing).Content

# Each @font-face block is `/* subset */ @font-face { ... src: url(https://...woff2) ... }`.
# Only the latin and latin-ext subsets are kept: the interface is English and Chinese, and
# Google's CJK families are megabytes of glyphs the interface never draws itself (the
# browser's own CJK fallback handles Chinese text).
$blocks = [regex]::Matches($css, '(?s)/\*\s*([a-z-]+)\s*\*/\s*(@font-face\s*\{.*?\})')
$written = 0
# Inter and JetBrains Mono are variable fonts: Google serves the *same* file for every
# weight it was asked for, so the three Inter weights arrive as three identical
# downloads. Hash the bytes and keep one file per hash — the faces below still declare
# their own weights, they just share the file.
$byHash = @{}
$sheets = New-Object System.Text.StringBuilder
foreach ($m in $blocks) {
    $subset = $m.Groups[1].Value
    if ($subset -notin @('latin', 'latin-ext')) { continue }
    $block = $m.Groups[2].Value
    $urlMatch = [regex]::Match($block, 'url\((https://[^)]+\.woff2)\)')
    if (-not $urlMatch.Success) { continue }
    $url = $urlMatch.Groups[1].Value
    $family = [regex]::Match($block, "font-family:\s*'([^']+)'").Groups[1].Value
    $weight = [regex]::Match($block, 'font-weight:\s*(\d+)').Groups[1].Value
    $style = [regex]::Match($block, 'font-style:\s*(\w+)').Groups[1].Value

    $tmp = Join-Path $env:TEMP ('aetherax-font-' + [guid]::NewGuid().ToString('n') + '.woff2')
    Invoke-WebRequest -Uri $url -UserAgent $ua -UseBasicParsing -OutFile $tmp
    $hash = (Get-FileHash -Path $tmp -Algorithm SHA256).Hash
    if ($byHash.ContainsKey($hash)) {
        $name = $byHash[$hash]
        Remove-Item $tmp -Force
    } else {
        $name = (($family + '-' + $style + '-' + $subset) -replace '\s+', '') + '.woff2'
        $target = Join-Path $outDir $name
        Move-Item $tmp $target -Force
        $byHash[$hash] = $name
        Write-Host ("  {0} ({1} bytes)" -f $name, (Get-Item $target).Length)
    }
    [void]$sheets.AppendLine("/* $subset, weight $weight */")
    [void]$sheets.AppendLine('@font-face {')
    [void]$sheets.AppendLine("	font-family: '$family';")
    [void]$sheets.AppendLine("	font-style: $style;")
    [void]$sheets.AppendLine("	font-weight: $weight;")
    [void]$sheets.AppendLine('	font-display: swap;')
    # No unicode-range: the files are already subset, and the ranges only matter when a
    # page mixes scripts in one family.
    [void]$sheets.AppendLine("	src: url('/fonts/$name') format('woff2');")
    [void]$sheets.AppendLine('}')
    $written++
}

if ($written -eq 0) { throw 'No latin font faces found in the Google Fonts response.' }
Set-Content -Path (Join-Path $outDir 'fonts.css') -Value $sheets.ToString() -Encoding UTF8
Write-Host "Wrote static/fonts/fonts.css with $written faces."
