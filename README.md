# FEDDA Hub v4.0

A local front end for [ComfyUI](https://github.com/comfyanonymous/ComfyUI). It
runs on your own machine and your own GPU. Nothing is uploaded, no server
processes your images, and there is no account to create.

FEDDA Hub is free.

## What it does

ComfyUI is powerful and its canvas is a lot to hold in your head when all you
want is a picture. FEDDA Hub puts a normal screen in front of a workflow: a
prompt box, a size, a seed, your LoRAs, and a button. The graph underneath is a
real ComfyUI workflow, unchanged, and you can open it in ComfyUI whenever you
want to see what it is doing.

It also installs itself: ComfyUI, PyTorch, the custom nodes a workflow needs,
and the model files it references. You point it at a folder and it fills it.

## Install

Download `FEDDA_Hub_v4.0_Installer.bat`, put it in an empty folder on a drive
with room, and run it. It brings its own Python and Git, so nothing has to be
set up first.

Requirements: Windows 10 or 11, an NVIDIA GPU, and enough disk space for the
models you choose to install. A 12 GB card runs the core pack comfortably.

## Core and boosters

The core pack is the app itself plus Z-Image text-to-image. Everything else -
other models, editing, ControlNet, video - installs as a separate module, and
the app runs correctly with none of them present. You add what you want and
skip the rest, rather than downloading two hundred gigabytes to find out which
five you use.

## Built on

ComfyUI, PyTorch and a set of community custom nodes, each under its own
licence. FEDDA Hub does not redistribute them; the installer clones them from
their own repositories.
