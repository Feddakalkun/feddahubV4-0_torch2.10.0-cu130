param(
    [Parameter(Mandatory = $true)][string]$RootPath,
    [Parameter(Mandatory = $true)][string]$Python,
    [Parameter(Mandatory = $true)][string]$ComfyMain,
    [Parameter(Mandatory = $true)][string]$OutLog,
    [Parameter(Mandatory = $true)][string]$ErrLog
)

# Start ComfyUI with the folders the user chose.
#
# Lifted out of run.ps1 so it has two callers: the launcher, and the backend's
# restart endpoint. The settings in Settings > Folders only reach ComfyUI at
# launch - extra_model_paths.yaml is written here, and the output and input
# directories are command-line arguments - so a restart that did not repeat all
# of this would quietly drop the very change it was asked to apply.
#
# Returns the process object, which is the only thing it writes to the
# pipeline; everything else goes to the host.

$ErrorActionPreference = "Stop"

$ComfyExtraArgs = ""
$SettingsFile = Join-Path $RootPath "config\runtime_settings.json"
if (Test-Path $SettingsFile) {
    try {
        $UserPaths = Get-Content $SettingsFile -Raw | ConvertFrom-Json

        $OutDir = "$($UserPaths.output_path)".Trim()
        if ($OutDir -and (Test-Path $OutDir)) {
            $ComfyExtraArgs += " --output-directory `"$OutDir`""
            Write-Host "  Output folder: $OutDir" -ForegroundColor DarkGray
        }

        $InDir = "$($UserPaths.input_path)".Trim()
        if ($InDir -and (Test-Path $InDir)) {
            $ComfyExtraArgs += " --input-directory `"$InDir`""
            Write-Host "  Input folder:  $InDir" -ForegroundColor DarkGray
        }

        # FEDDA's own models tree is listed first on purpose. ComfyUI's
        # downloader nodes write to the first path for a folder type, so the
        # user's tree listed first would make FEDDA download into it.
        # A list now: models end up on whichever drive had room, and one
        # folder meant the rest were invisible. The superseded singular is
        # still read so a settings file written before this keeps working.
        $ExtraList = @()
        if ($UserPaths.PSObject.Properties.Name -contains "extra_models_paths") {
            $ExtraList = @($UserPaths.extra_models_paths)
        }
        if (-not $ExtraList -or $ExtraList.Count -eq 0) {
            $ExtraList = @("$($UserPaths.extra_models_path)")
        }
        $ExtraList = @($ExtraList | ForEach-Object { "$_".Trim() } |
                       Where-Object { $_ -and (Test-Path $_) })
        if ($ExtraList.Count -gt 0) {
            $OwnModels = Join-Path $RootPath "ComfyUI\models"
            # base_path on its own adds nothing. ComfyUI pops base_path
            # and is_default, then adds one search path per remaining
            # key - so a section with no folder types parses cleanly and
            # registers nothing. That is what made Settings > Folders a
            # no-op: no error, no log line, and an empty model list.
            #
            # The alternate names are deliberate. Libraries put diffusion
            # models under `unet` as often as `diffusion_models`, text
            # encoders under `clip`, and some keep everything in
            # `checkpoints`.
            $Folders = @(
                "    checkpoints: checkpoints/",
                "    diffusion_models: |",
                "        diffusion_models/",
                "        unet/",
                "        checkpoints/",
                "    text_encoders: |",
                "        text_encoders/",
                "        clip/",
                "        checkpoints/",
                "    clip_vision: clip_vision/",
                "    vae: |",
                "        vae/",
                "        vae_approx/",
                "    loras: loras/",
                "    controlnet: controlnet/",
                "    upscale_models: upscale_models/",
                "    style_models: style_models/",
                "    embeddings: embeddings/",
                "    unet_gguf: unet_gguf/",
                "    llm_gguf: llm_gguf/",
                # Folders custom nodes register rather than ComfyUI core.
                # Without these the node sees an empty list and refuses the
                # prompt with "not in []" - which is what happened to
                # SAMLoader and UltralyticsDetectorProvider once the model
                # library moved to another drive: the files were there, and
                # nothing had told ComfyUI to look.
                #
                # Impact-Pack's own names, not the folder layout: it
                # registers ultralytics_bbox and ultralytics_segm, which
                # live one level down inside ultralytics/.
                "    sams: sams/",
                "    ultralytics_bbox: ultralytics/bbox/",
                "    ultralytics_segm: ultralytics/segm/",
                "    insightface: insightface/",
                "    ipadapter: ipadapter/",
                "    inpaint: inpaint/"
            )
            # Two shapes reach this box, and only one of them worked.
            #
            # A ComfyUI models tree has loras/, checkpoints/, vae/ and the rest
            # underneath, and every mapping above is written relative to
            # base_path - so it finds them. A LoRA library is not that: it is a
            # folder of .safetensors sorted by character or concept, and
            # `loras: loras/` then points at a directory that does not exist.
            # ComfyUI reports nothing, the picker says "Search 1 LoRAs..." on a
            # machine holding 211, and Settings > Folders looks broken.
            #
            # So: if none of the standard subfolders is there, the folder is
            # taken to be a LoRA library and searched as one. Only loras gets
            # the extra path - mapping every type to ./ would put the same 211
            # files in the checkpoint and VAE pickers too.
            $Known = @("loras", "checkpoints", "vae", "unet", "diffusion_models",
                       "controlnet", "clip", "text_encoders", "upscale_models",
                       "embeddings", "clip_vision")

            # Each folder is judged on its own. One drive may hold a full
            # ComfyUI tree and the next just a pile of LoRAs, and deciding
            # once for all of them would mis-read whichever came second.
            $ExtraSections = @()
            $Index = 0
            foreach ($Dir in $ExtraList) {
                $Index++
                $LooksLikeTree = $false
                foreach ($k in $Known) {
                    if (Test-Path (Join-Path $Dir $k)) { $LooksLikeTree = $true; break }
                }
                $UserFolders = $Folders
                if (-not $LooksLikeTree) {
                    $UserFolders = $Folders | ForEach-Object {
                        if ($_ -eq "    loras: loras/") { "    loras: |`n        loras/`n        ./" }
                        else { $_ }
                    }
                    Write-Host "  Extra models:  $Dir (LoRA library)" -ForegroundColor DarkGray
                } else {
                    Write-Host "  Extra models:  $Dir (read-only)" -ForegroundColor DarkGray
                }
                # Unique section names. Two sections sharing one key is not a
                # merge in YAML - the second silently replaces the first, and
                # every folder but the last would go unsearched.
                $ExtraSections += @("", "user_models_${Index}:", "    base_path: $Dir") + $UserFolders
            }

            $Yaml = (@(
                "# Written by run.ps1 from config/runtime_settings.json.",
                "# Edits here are replaced on every launch - use Settings > Folders.",
                "#",
                "# fedda carries is_default so it is searched first, which is",
                "# also where downloader nodes write - never into your library.",
                "fedda:",
                "    base_path: $OwnModels",
                "    is_default: true"
            ) + $Folders + $ExtraSections) -join "`n"
            # Not Set-Content -Encoding UTF8: in Windows PowerShell 5.1
            # that writes a BOM, and ComfyUI feeds this file straight to
            # PyYAML, which fails on the first character with
            # "expected '<document start>'". ComfyUI then runs with no
            # extra search paths and reports nothing, so Settings >
            # Folders silently did nothing whatsoever.
            #
            # -Encoding utf8NoBOM does not exist before PowerShell 6.
            $YamlPath = Join-Path $RootPath "ComfyUI\extra_model_paths.yaml"
            [System.IO.File]::WriteAllText(
                $YamlPath, $Yaml, (New-Object System.Text.UTF8Encoding($false)))
        }
    } catch {
        Write-Host "  [WARN] Could not read folder settings - using defaults." -ForegroundColor Yellow
    }
}

# ComfyUI creates these on demand, and some nodes read them at import instead.
# ComfyUI_Comfyroll_CustomNodes lists output/ inside INPUT_TYPES, so a missing
# folder raises during /object_info - ComfyUI catches it per node and carries
# on, which means one node type quietly vanishes from the list and the error is
# logged on every single call.
foreach ($Dir in @("output", "input", "temp")) {
    $Path = Join-Path $RootPath "ComfyUI\$Dir"
    if (-not (Test-Path $Path)) { New-Item -ItemType Directory -Force $Path | Out-Null }
}

$ComfyProc = Start-Process -FilePath $Python `
    -ArgumentList "-s `"$ComfyMain`" --windows-standalone-build --port 8199 --disable-cuda-malloc --preview-method auto$ComfyExtraArgs" `
    -PassThru -NoNewWindow `
    -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog
# The caller wants the process, to wait on and to shut down later.
$ComfyProc
