# Redact chat screenshot for public repo: cover owner nickname/avatar areas.
# ASCII only. Coordinates in SOURCE pixels (1080x2590).
Add-Type -AssemblyName System.Drawing
$src = 'C:\Users\Administrator\Downloads\Screenshot_2026_1121_103352.jpg'
$dst = 'C:\Users\Administrator\Downloads\chat-vision.png'
$img = [System.Drawing.Image]::FromFile($src)
$bmp = New-Object System.Drawing.Bitmap($img)
$g = [System.Drawing.Graphics]::FromImage($bmp)
function Cover($x, $y, $w, $h) {
  $rect = New-Object System.Drawing.Rectangle($x, $y, $w, $h)
  $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 18, 22, 26))
  $g.FillRectangle($brush, $rect)
}
# 1) top-right: admin tag + owner nickname + avatar (source px)
Cover 670 250 390 135
# 2) quoted nickname row " Sodium 10:32 " inside reply card (source px)
Cover 200 980 260 60
$g.Dispose()
$bmp.Save($dst, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose(); $img.Dispose()
Write-Host "saved: $dst"
