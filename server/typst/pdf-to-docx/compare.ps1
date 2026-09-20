# Prove the Word export against the PDF it was made from.
#
#   .\compare.ps1 -Source <folder-with-main.typ> -Out <scratch-folder>
#   .\compare.ps1 -Pdf <already-compiled.pdf>   -Out <scratch-folder>
#
# A developer tool. It is not part of `bun run test`, it never runs in Docker,
# and it needs three things this machine has and the container does not:
# typst on PATH, Microsoft Word, and the report's fonts installed so Word is
# not substituting while you look at the result.
#
# What it does: compile the PDF, run convert.py on it, render the Word file
# back to PDF through Word itself, then score the two page by page and write
# contact sheets you can open side by side. Equal page counts are the pass
# mark; the sheets are the real check.

[CmdletBinding()]
param(
  [string]$Source,
  [string]$Pdf,
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Python = $env:PDF2DOCX_PYTHON,
  [string]$Label = "sheet"
)

$ErrorActionPreference = "Stop"
if (-not $Python) { $Python = "python" }
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$Out = (Resolve-Path $Out).Path

# 1. The reference PDF, compiled the way the server compiles it.
$reference = Join-Path $Out "reference.pdf"
if ($Pdf) {
  Copy-Item -Force (Resolve-Path $Pdf).Path $reference
} elseif ($Source) {
  $src = (Resolve-Path $Source).Path
  $args = @("compile", "--root", $src, "--ignore-system-fonts", "-j", "1")
  $fonts = Join-Path $src "fonts"
  if (Test-Path $fonts) { $args += @("--font-path", $fonts) }
  $args += @((Join-Path $src "main.typ"), $reference)
  & typst @args
  if ($LASTEXITCODE -ne 0) { throw "typst compile failed ($LASTEXITCODE)" }
} else {
  throw "pass -Source <folder> or -Pdf <file>"
}

# 2. The converter under test.
$docx = Join-Path $Out "converted.docx"
$result = Join-Path $Out "result.json"
& $Python -I -B (Join-Path $here "convert.py") $reference $docx $result
if ($LASTEXITCODE -ne 0) { throw "convert.py failed ($LASTEXITCODE): $(Get-Content $result -Raw)" }
Write-Host "result.json: $(Get-Content $result -Raw)"

# 3. Word's own opinion of that file, as a PDF.
$rendered = Join-Path $Out "converted.pdf"
if (Test-Path $rendered) { Remove-Item -Force $rendered }
$word = $null
$doc = $null
try {
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $word.DisplayAlerts = 0
  # FileName, ConfirmConversions, ReadOnly, AddToRecentFiles.
  $doc = $word.Documents.Open($docx, $false, $true, $false)
  $doc.Fields.Update() | Out-Null   # the PAGE field in the footer
  $doc.Repaginate()
  $pages = $doc.ComputeStatistics(2)  # wdStatisticPages
  $doc.SaveAs2([string]$rendered, 17) # wdFormatPDF
  Write-Host "Word reports $pages page(s)"
} finally {
  if ($doc) { $doc.Close([ref]0) | Out-Null }
  if ($word) { $word.Quit() | Out-Null }
  foreach ($o in @($doc, $word)) {
    if ($o) { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($o) }
  }
  [System.GC]::Collect()
  [System.GC]::WaitForPendingFinalizers()
}

# 4. Score the pages and draw the sheets.
& $Python -I -B (Join-Path $here "compare_pages.py") $reference $rendered $Out $Label
$scored = $LASTEXITCODE
if ($scored -ne 0) { Write-Warning "page counts differ" }
exit $scored
