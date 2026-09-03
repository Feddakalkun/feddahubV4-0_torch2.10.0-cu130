param([string]$Start = "", [string]$Title = "Choose a folder")

<#
    Show Windows' own folder picker and print what was chosen.

    A browser cannot do this. `<input type="file" webkitdirectory>` hands the
    page a list of names and a fake path - the real location is withheld on
    purpose, and no amount of markup gets it back. So the picker has to run
    where the files are, which is the backend, on the user's own machine.

    Run with -STA. Windows Forms requires a single-threaded apartment and
    silently returns nothing without one, which looks exactly like the user
    pressing Cancel.

    Printed on stdout, nothing else. The caller reads one line, and an empty
    line means cancelled.
#>

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = $Title
$dialog.ShowNewFolderButton = $true
if ($Start -and (Test-Path $Start)) { $dialog.SelectedPath = $Start }

# Without an owner the dialog opens behind the browser window and the app looks
# frozen while a picker nobody can see waits for an answer. An invisible
# top-most form gives it something to sit in front of.
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$owner.Show()
$owner.Activate()

$result = $dialog.ShowDialog($owner)

$owner.Close()
$owner.Dispose()

if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
    Write-Output $dialog.SelectedPath
}
$dialog.Dispose()
