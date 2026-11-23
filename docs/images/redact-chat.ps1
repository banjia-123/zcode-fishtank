# Redact chat screenshot for public repo: cover owner nickname/avatar areas and the group name.
# ASCII only; coordinates in SOURCE pixels (1080x2590).
# Usage: edit the two param defaults below to your own paths, then run.
param(
  [string]$src = '<your-phone-screenshot.jpg>',
  [string]$dst = '<output-chat-vision.png>'
)
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile($src)
$bmp = New-Object [System.Drawing.Bitmap]($img)
$g = [System.Drawing.Graphics]::FromImage($bmp)
function Cover($x, $y, $w, $h) {
  $rect = New-Object [System.Drawing.Rectangle]($x, $y, $w, $h)
  $brush = New-Object [System.Drawing.SolidBrush]([System.Drawing.Color]::FromArgb(255, 18, 22, 26))
  $g.FillRectangle($brush, $rect)
}
# 1) top-right: admin tag + owner nickname + avatar (source px)
Cover 670 250 390 135
# 2) quoted nickname row inside reply card (source px)
Cover 200 980 260 60
# 3) group name in the title bar (source px). The committed file also has a "<group name>" placeholder drawn here.
Cover 170 128 225 55
$g.Dispose()
$bmp.Save($dst, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose(); $img.Dispose()
Write-Host "saved: $dst"
