import json
import os
import re
import requests
import threading
import time
from pathlib import Path
from typing import Optional, Dict, List, Any

class ModelDownloader:
    def __init__(self, root_dir: Path):
        self.root_dir = root_dir
        self.comfy_models_dir = root_dir / "ComfyUI" / "models"
        self.progress: Dict[str, dict] = {}
        self.lock = threading.Lock()
        self._active_downloads: Dict[str, threading.Thread] = {}

        # Named for the first workflow that needed it; it is now the table of
        # every model any shipped graph names, and the download preflight looks
        # each filename up here. A graph that names a file absent from this
        # table reports as unavailable in the UI rather than failing at run.
        self.zimage_core_specs: Dict[str, Dict[str, Any]] = {
            # --- MiniMax H3 ------------------------------------------------
            # Sizes verified against the origin before these went in: 19.53,
            # 14.61, 4.85 and 0.56 GB. Roughly 40 GB for one workflow, which is
            # twice the whole Z-Image core pack - the reason this is a booster
            # module and not part of core.
            #
            # diffusion_models and text_encoders rather than unet and clip:
            # ComfyUI maps each pair to the same search list, so both work, and
            # these are the names on the model card the workflow was built from.
            # ref2va animates a reference image; fl2va goes from a first frame
            # (and optionally a last one). Different models, same size, and the
            # graphs pick one or the other - first-frame, fflf and director all
            # load fl2va. It was absent from this table for a while, and the
            # symptom was not an error: the file simply had no URL, so the
            # dialog showed it missing at size "-" and the Download button
            # started nothing at all.
            "minimax_h3_fl2va_pruned_int8_convrot.safetensors": {
                "relative_dir": Path("diffusion_models"),
                "url": "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors",
                "min_bytes": 1024 * 1024 * 1024,
            },
            "minimax_h3_ref2va_pruned_int8_convrot.safetensors": {
                "relative_dir": Path("diffusion_models"),
                "url": "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors",
                "min_bytes": 1024 * 1024 * 1024,
            },
            # 315 MB. The 4-step distill LoRA. Every MiniMax graph samples at
            # 8 steps with cfg 1, which is a setting that only works with this
            # present - v3 baked it in and v4 arrived without it, so the same
            # eight steps were doing a job that normally takes twenty.
            # The rest of the MiniMax turbo family. 1.96 GB each.

            # The ref2v distill, for the six graphs that load ref2va. 4 steps.
            "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors": {
                "relative_dir": Path("loras"),
                "url": "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
                "min_bytes": 100 * 1024 * 1024,
            },

            # v1.0 of the fl2v distill, tuned at 768p. 4 steps.
            "minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors": {
                "relative_dir": Path("loras"),
                "url": "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/loras/minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors",
                "min_bytes": 100 * 1024 * 1024,
            },

            # The same at 8 steps, which is what these graphs sample at.
            "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors": {
                "relative_dir": Path("loras"),
                "url": "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/loras/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors",
                "min_bytes": 100 * 1024 * 1024,
            },

            "minimax_h3_fl2v_lightx2v_turbo_4step_v0.1_comfy_resized_avg_rank_21_bf16.safetensors": {
                "relative_dir": Path("loras"),
                "url": "https://huggingface.co/Kijai/MiniMax-H3_comfy/resolve/main/loras/minimax_h3_fl2v_lightx2v_turbo_4step_v0.1_comfy_resized_avg_rank_21_bf16.safetensors",
                "min_bytes": 100 * 1024 * 1024,
            },
            # 15.6 GB each. The GGUF builds, for cards that cannot hold the
            # 19.5 GB originals. Q3_K_M is the smallest quant published for
            # this model - there is no Q2 - so this is the floor, and with
            # ComfyUI-GGUF offloading layers it is what makes a 12 GB card
            # able to run MiniMax at all.
            #
            # The text encoder is deliberately not the GGUF one: these graphs
            # reuse qwen3vl_32b_minimax_h3_nvfp4_awq, so anyone who already has
            # MiniMax downloads one file rather than another 14.6 GB encoder.
            # --- smaller MiniMax quants, for cards under 24 GB ----------
            # Q3_K_M below is 15.6 GB and wants a 24 GB card. These are the
            # same model at a third of that. Not in any graph by default -
            # download one and it appears in the workflow's model picker.

            # 8.1 GB. 8 GB cards. Dynamic quant - better than plain Q2 at the same size.
            "minimax_h3_fl2va_pruned-UD-Q2_K_XL.gguf": {
                "relative_dir": Path("unet"),
                "url": "https://huggingface.co/unsloth/MiniMax-H3-GGUF/resolve/main/minimax_h3_fl2va_pruned-UD-Q2_K_XL.gguf",
                "min_bytes": 1024 * 1024 * 1024,
            },

            # 8.1 GB. The ref2va half of the same.
            "minimax_h3_ref2va_pruned-UD-Q2_K_XL.gguf": {
                "relative_dir": Path("unet"),
                "url": "https://huggingface.co/unsloth/MiniMax-H3-GGUF/resolve/main/minimax_h3_ref2va_pruned-UD-Q2_K_XL.gguf",
                "min_bytes": 1024 * 1024 * 1024,
            },

            # 9.6 GB. 12 GB cards, and the best quality under 10 GB.
            "minimax_h3_fl2va_pruned-UD-Q3_K_XL.gguf": {
                "relative_dir": Path("unet"),
                "url": "https://huggingface.co/unsloth/MiniMax-H3-GGUF/resolve/main/minimax_h3_fl2va_pruned-UD-Q3_K_XL.gguf",
                "min_bytes": 1024 * 1024 * 1024,
            },

            # 9.6 GB. The ref2va half of the same.
            "minimax_h3_ref2va_pruned-UD-Q3_K_XL.gguf": {
                "relative_dir": Path("unet"),
                "url": "https://huggingface.co/unsloth/MiniMax-H3-GGUF/resolve/main/minimax_h3_ref2va_pruned-UD-Q3_K_XL.gguf",
                "min_bytes": 1024 * 1024 * 1024,
            },

            # 11.4 GB. 16 GB cards. Close to the full build.
            "minimax_h3_fl2va_pruned-Q4_K.gguf": {
                "relative_dir": Path("unet"),
                "url": "https://huggingface.co/unsloth/MiniMax-H3-GGUF/resolve/main/minimax_h3_fl2va_pruned-Q4_K.gguf",
                "min_bytes": 1024 * 1024 * 1024,
            },

            # 11.4 GB. The ref2va half of the same.
            "minimax_h3_ref2va_pruned-Q4_K.gguf": {
                "relative_dir": Path("unet"),
                "url": "https://huggingface.co/unsloth/MiniMax-H3-GGUF/resolve/main/minimax_h3_ref2va_pruned-Q4_K.gguf",
                "min_bytes": 1024 * 1024 * 1024,
            },

            "MiniMax-H3-Ref2VA-Q3_K_M.gguf": {
                "relative_dir": Path("unet"),
                "url": "https://huggingface.co/Abiray/MiniMax-H3-GGUF/resolve/main/unet/MiniMax-H3-Ref2VA-Q3_K_M.gguf",
                "min_bytes": 1024 * 1024 * 1024,
            },
            "MiniMax-H3-FL2VA-Q3_K_M.gguf": {
                "relative_dir": Path("unet"),
                "url": "https://huggingface.co/Abiray/MiniMax-H3-GGUF/resolve/main/unet/MiniMax-H3-FL2VA-Q3_K_M.gguf",
                "min_bytes": 1024 * 1024 * 1024,
            },
            "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors": {
                "relative_dir": Path("text_encoders"),
                "url": "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
                "min_bytes": 1024 * 1024 * 1024,
            },
            "minimax_h3_video_vae_fp16.safetensors": {
                "relative_dir": Path("vae"),
                "url": "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_video_vae_fp16.safetensors",
                "min_bytes": 100 * 1024 * 1024,
            },
            "minimax_h3_audio_vae_fp32.safetensors": {
                "relative_dir": Path("vae"),
                "url": "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_audio_vae_fp32.safetensors",
                "min_bytes": 100 * 1024 * 1024,
            },

            # --- LTX 2.3 ---------------------------------------------------
            # Sizes are what the origin reported when these went in. The core
            # path is about 52 GB - the UNet and gemma together are most of it
            # - which makes this the heaviest module in the app.
            #
            # Every URL here is the one the source canvas carries in its own
            # HuggingFaceDownloader node, so the workflow states where its
            # models come from and this table is not a second opinion.

            # 23.5 GB. The distilled 22B, quantised int8 with ConvRot. Every
            # graph samples at 4 steps, which is what "distilled" buys.
            "ltx-2.3-22b-distilled-1.1-int8-ConvRot.safetensors": {
                "relative_dir": Path("diffusion_models"),
                "url": "https://huggingface.co/obsxrver/ComfyUI-Native-INT8_ConvRot/resolve/main/checkpoints/ltx-2.3-22b-distilled-1.1-int8-ConvRot.safetensors",
                "min_bytes": 1024 * 1024 * 1024,
            },

            # 24.4 GB text encoder, and 2.3 GB of projection beside it.
            "gemma_3_12B_it.safetensors": {
                "relative_dir": Path("text_encoders"),
                "url": "https://huggingface.co/Comfy-Org/ltx-2/resolve/main/split_files/text_encoders/gemma_3_12B_it.safetensors",
                "min_bytes": 1024 * 1024 * 1024,
            },
            # 9.4 GB. The fp4 build, which only First frame styler asks for.
            "gemma_3_12B_it_fp4_mixed.safetensors": {
                "relative_dir": Path("text_encoders"),
                "url": "https://huggingface.co/datasets/comfyuistudio/gemma/resolve/main/gemma_3_12B_it_fp4_mixed.safetensors",
                "min_bytes": 1024 * 1024 * 1024,
            },
            "ltx-2.3_text_projection_bf16.safetensors": {
                "relative_dir": Path("text_encoders"),
                "url": "https://huggingface.co/Kijai/LTX2.3_comfy/resolve/main/text_encoders/ltx-2.3_text_projection_bf16.safetensors",
                "min_bytes": 100 * 1024 * 1024,
            },

            # Two VAEs: LTX 2.3 renders picture and sound in one pass, so the
            # audio one is not optional.
            "LTX23_video_vae_bf16.safetensors": {
                "relative_dir": Path("vae"),
                "url": "https://huggingface.co/Kijai/LTX2.3_comfy/resolve/main/vae/LTX23_video_vae_bf16.safetensors",
                "min_bytes": 100 * 1024 * 1024,
            },
            "LTX23_audio_vae_bf16.safetensors": {
                "relative_dir": Path("vae"),
                "url": "https://huggingface.co/Kijai/LTX2.3_comfy/resolve/main/vae/LTX23_audio_vae_bf16.safetensors",
                "min_bytes": 100 * 1024 * 1024,
            },

            # One LoRA per specialised graph, each baked on in the canvas.
            "ltx2.3-transition.safetensors": {
                "relative_dir": Path("loras"),
                "url": "https://huggingface.co/valiantcat/LTX-2.3-Transition-LORA/resolve/main/ltx2.3-transition.safetensors",
                "min_bytes": 100 * 1024 * 1024,
            },
            "ltx23_edit_anything_global_rank128_v1_9000steps_adamw.safetensors": {
                "relative_dir": Path("loras"),
                "url": "https://huggingface.co/Alissonerdx/LTX-LoRAs/resolve/main/ltx23_edit_anything_global_rank128_v1_9000steps_adamw.safetensors",
                "min_bytes": 100 * 1024 * 1024,
            },
            # Both Video to Video graphs steer with this one. It only became
            # visible once the converter learned to read LTXICLoRALoaderModelOnly's
            # widgets - before that the graphs named no LoRA at all and
            # validate_models passed them.
            "ltx-2.3-22b-ic-lora-union-control-ref0.5.safetensors": {
                "relative_dir": Path("loras"),
                "url": "https://huggingface.co/Lightricks/LTX-2.3-22b-IC-LoRA-Union-Control/resolve/main/ltx-2.3-22b-ic-lora-union-control-ref0.5.safetensors",
                "min_bytes": 100 * 1024 * 1024,
            },
            "ltx-2.3-22b-ic-lora-outpaint.safetensors": {
                "relative_dir": Path("loras"),
                "url": "https://huggingface.co/oumoumad/LTX-2.3-22b-IC-LoRA-Outpaint/resolve/main/ltx-2.3-22b-ic-lora-outpaint.safetensors",
                "min_bytes": 100 * 1024 * 1024,
            },

            # First frame styler restyles one frame with FLUX 2 Klein before
            # LTX animates it, so that graph needs a 9.4 GB image model too.
            "flux-2-klein-9b-fp8mixed.safetensors": {
                "relative_dir": Path("diffusion_models"),
                "url": "https://huggingface.co/silveroxides/FLUX.2-dev-fp8_scaled/resolve/main/flux-2-klein-9b-fp8mixed.safetensors",
                "min_bytes": 1024 * 1024 * 1024,
            },

            # --- Z-Image ---------------------------------------------------
            "z_image_turbo_bf16.safetensors": {
                "relative_dir": Path("unet"),
                "url": "https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/diffusion_models/z_image_turbo_bf16.safetensors",
                "min_bytes": 10 * 1024 * 1024,
            },
            "qwen_3_4b.safetensors": {
                "relative_dir": Path("clip"),
                "url": "https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/text_encoders/qwen_3_4b.safetensors",
                "min_bytes": 10 * 1024 * 1024,
            },
            "z-image-vae.safetensors": {
                "relative_dir": Path("vae"),
                "url": "https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors",
                "min_bytes": 5 * 1024 * 1024,
            },
            # Smaller builds of the two files above, from the same repository
            # and offered as optional downloads rather than defaults.
            #
            # Z-Image needs 13.9 GB resident as shipped, and the UNet is what
            # drives that - 11.5 of it. That puts the whole model family out of
            # reach of an 8 GB card and of the 11 GB 2080 Ti, which stream from
            # system RAM instead and crawl. int8 is 5.8 GB and the fp8 encoder
            # 5.2, which brings the peak to roughly 8.2 GB: comfortable on 11 GB
            # and borderline rather than hopeless on 8.
            #
            # NVFP4 builds exist too and are smaller still, but FP4 is Blackwell
            # hardware - on anything older it has to be dequantised on the way
            # through, so it would be offered as a saving and land as a
            # slowdown. Left out until there is a card here to measure it on.
            "z_image_turbo_int8_convrot.safetensors": {
                "relative_dir": Path("unet"),
                "url": "https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/diffusion_models/z_image_turbo_int8_convrot.safetensors",
                "min_bytes": 10 * 1024 * 1024,
            },
            "qwen_3_4b_fp8_mixed.safetensors": {
                "relative_dir": Path("clip"),
                "url": "https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/text_encoders/qwen_3_4b_fp8_mixed.safetensors",
                "min_bytes": 10 * 1024 * 1024,
            },
            "Z-Image-Turbo-Fun-Controlnet-Union.safetensors": {
                "relative_dir": Path("model_patches"),
                "url": "https://huggingface.co/alibaba-pai/Z-Image-Turbo-Fun-Controlnet-Union/resolve/main/Z-Image-Turbo-Fun-Controlnet-Union.safetensors",
                "min_bytes": 10 * 1024 * 1024,
            },
            # ---------------------------------------------------------------
            # FLUX Krea. Sizes are what the server reported when these were
            # added, and they are here so a wrong file is obvious rather than
            # merely slow.
            # ---------------------------------------------------------------

            # 11.3 GB. Gated: Black Forest Labs asks you to accept the licence
            # first. Comfy-Org publishes a repackaged fp8_scaled build openly,
            # and it is deliberately not used here - the graph loads this at
            # weight_dtype fp8_e4m3fn, so feeding it an already-scaled file
            # would quantise twice and lose quality for no reason anyone could
            # see from the UI.
            "flux1-krea-dev.safetensors": {
                "relative_dir": Path("unet"),
                "url": "https://huggingface.co/black-forest-labs/FLUX.1-Krea-dev/resolve/main/flux1-krea-dev.safetensors",
                "min_bytes": 100 * 1024 * 1024,
                "gated": True,
            },

            # 12.1 GB. What five of the six Krea graphs actually load - the
            # quantised build, which is the point of the GGUF variants. city96
            # gates its copy; QuantStack serves the same quantisation openly.
            "flux1-krea-dev-Q8_0.gguf": {
                "relative_dir": Path("unet"),
                "url": "https://huggingface.co/QuantStack/FLUX.1-Krea-dev-GGUF/resolve/main/flux1-krea-dev-Q8_0.gguf",
                "min_bytes": 100 * 1024 * 1024,
            },

            # 319 MB. The FLUX autoencoder. Black Forest Labs gates its own
            # copy, so this comes from the Lumina 2.0 repack, which carries the
            # same file - checked byte for byte against a known-good local copy
            # rather than assumed: 335304388 both.
            "ae.safetensors": {
                "relative_dir": Path("vae"),
                "url": "https://huggingface.co/Comfy-Org/Lumina_Image_2.0_Repackaged/resolve/main/split_files/vae/ae.safetensors",
                "min_bytes": 100 * 1024 * 1024,
            },

            # 4.6 GB text encoder.
            "t5xxl_fp8_e4m3fn.safetensors": {
                "relative_dir": Path("clip"),
                "url": "https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp8_e4m3fn.safetensors",
                "min_bytes": 100 * 1024 * 1024,
            },

            # 234 MB. The graph calls it clip_l-for-gguf; upstream it is just
            # clip_l, and the same bytes either way - the downloader saves
            # under the destination name, so the rename costs nothing.
            "clip_l-for-gguf.safetensors": {
                "relative_dir": Path("clip"),
                "url": "https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/clip_l.safetensors",
                "min_bytes": 10 * 1024 * 1024,
            },

            # 4.0 GB. One ControlNet serving depth, pose and normal alike.
            "FLUX.1-dev-ControlNet-Union-Pro-2.0.safetensors": {
                "relative_dir": Path("controlnet"),
                "url": "https://huggingface.co/Shakker-Labs/FLUX.1-dev-ControlNet-Union-Pro-2.0/resolve/main/diffusion_pytorch_model.safetensors",
                "min_bytes": 100 * 1024 * 1024,
            },
            # The name the ControlNet graph actually asks for. Its repo is
            # gated: without an accepted licence and a Hugging Face token the
            # URL answers 401, which is why this needs a source of its own
            # rather than being quietly served the disparity weights - those
            # predict disparity, not depth, and swapping one for the other
            # behind the user's back would change what the workflow does.
            "lotus-depth-g-v2-0.safetensors": {
                "relative_dir": Path("unet"),
                "url": "https://huggingface.co/jingheya/lotus-depth-g-v2-0/resolve/main/unet/diffusion_pytorch_model.safetensors",
                "min_bytes": 10 * 1024 * 1024,
                "gated": True,
            },
            "lotus-depth-g-v2-0-disparity.safetensors": {
                "relative_dir": Path("unet"),
                "url": "https://huggingface.co/jingheya/lotus-depth-g-v2-0-disparity/resolve/main/unet/diffusion_pytorch_model.safetensors",
                "min_bytes": 10 * 1024 * 1024,
            },
            "vae-ft-mse-840000-ema-pruned.safetensors": {
                "relative_dir": Path("vae"),
                "url": "https://huggingface.co/stabilityai/sd-vae-ft-mse-original/resolve/main/vae-ft-mse-840000-ema-pruned.safetensors",
                "min_bytes": 5 * 1024 * 1024,
            },
            "yolox_l.onnx": {
                "root_relative_path": Path("ComfyUI") / "custom_nodes" / "comfyui_controlnet_aux" / "ckpts" / "yzd-v" / "DWPose" / "yolox_l.onnx",
                "url": "https://huggingface.co/yzd-v/DWPose/resolve/main/yolox_l.onnx",
                "min_bytes": 10 * 1024 * 1024,
            },
            "dw-ll_ucoco_384_bs5.torchscript.pt": {
                "root_relative_path": Path("ComfyUI") / "custom_nodes" / "comfyui_controlnet_aux" / "ckpts" / "hr16" / "DWPose-TorchScript-BatchSize5" / "dw-ll_ucoco_384_bs5.torchscript.pt",
                "url": "https://huggingface.co/hr16/DWPose-TorchScript-BatchSize5/resolve/main/dw-ll_ucoco_384_bs5.torchscript.pt",
                "min_bytes": 10 * 1024 * 1024,
            },
            # ---------------------------------------------------------------
            # Detailer and upscale, used by Z-Image Detailed.
            #
            # Some of these a node pack fetches for itself the first time it
            # runs. Those carry `fetched_by` and no url, so the dialog can say
            # who is bringing them instead of listing a file with no size and
            # a Download button that starts nothing - which is what a missing
            # entry looks like from the UI, and it looks exactly like a bug.
            # ---------------------------------------------------------------

            # 67 MB. Nothing fetches this one, so we do.
            "4x_foolhardy_Remacri.pth": {
                "relative_dir": Path("upscale_models"),
                "url": "https://huggingface.co/FacehugmanIII/4x_foolhardy_Remacri/resolve/main/4x_foolhardy_Remacri.pth",
                "min_bytes": 10 * 1024 * 1024,
            },

            # Impact-Subpack downloads this into ultralytics/bbox on first
            # import; Impact-Pack does the same for the SAM below. Verified on
            # this install - both were on disk before either was ever asked
            # for.
            "face_yolov8m.pt": {
                "relative_dir": Path("ultralytics/bbox"),
                "fetched_by": "ComfyUI-Impact-Subpack",
                "min_bytes": 10 * 1024 * 1024,
            },
            "sam_vit_b_01ec64.pth": {
                "relative_dir": Path("sams"),
                "fetched_by": "ComfyUI-Impact-Pack",
                "min_bytes": 100 * 1024 * 1024,
            },

            # SeedVR2 keeps its weights in models/SEEDVR2 - its own folder,
            # registered with folder_paths at import - and downloads both the
            # moment the upscaler node first runs. 16.5 GB and 501 MB.
            "seedvr2_ema_7b_sharp_fp16.safetensors": {
                "relative_dir": Path("SEEDVR2"),
                "fetched_by": "ComfyUI-SeedVR2_VideoUpscaler",
                "min_bytes": 1024 * 1024 * 1024,
            },
            "ema_vae_fp16.safetensors": {
                "relative_dir": Path("SEEDVR2"),
                "fetched_by": "ComfyUI-SeedVR2_VideoUpscaler",
                "min_bytes": 100 * 1024 * 1024,
            },
        }
        self.wan_core_specs: Dict[str, Dict[str, Any]] = {
            "clip_vision_h.safetensors": {
                "relative_dir": Path("clip_vision"),
                "url": "https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/clip_vision/clip_vision_h.safetensors",
                "min_bytes": 10 * 1024 * 1024,
            },
            "vitpose-l-wholebody.onnx": {
                "relative_dir": Path("detection"),
                "url": "https://huggingface.co/JunkyByte/easy_ViTPose/resolve/main/onnx/wholebody/vitpose-l-wholebody.onnx",
                "min_bytes": 10 * 1024 * 1024,
            },
            "yolov10m.onnx": {
                "relative_dir": Path("detection"),
                "url": "https://huggingface.co/onnx-community/yolov10m/resolve/main/onnx/model.onnx",
                "min_bytes": 10 * 1024 * 1024,
            },
        }
        self.flux2klein_core_specs: Dict[str, Dict[str, Any]] = {
            "flux-2-klein-9b-fp8.safetensors": {
                "relative_dir": Path("diffusion_models"),
                "url": "https://huggingface.co/black-forest-labs/FLUX.2-klein-9b-fp8/resolve/main/flux-2-klein-9b-fp8.safetensors",
                "min_bytes": 10 * 1024 * 1024,
            },
            "qwen_3_8b_fp8mixed.safetensors": {
                "relative_dir": Path("text_encoders"),
                "url": "https://huggingface.co/Comfy-Org/flux2-klein-9B/resolve/main/split_files/text_encoders/qwen_3_8b_fp8mixed.safetensors",
                "min_bytes": 10 * 1024 * 1024,
            },
            "flux2-vae.safetensors": {
                "relative_dir": Path("vae"),
                "url": "https://huggingface.co/Comfy-Org/flux2-dev/resolve/main/split_files/vae/flux2-vae.safetensors",
                "min_bytes": 5 * 1024 * 1024,
            },

        }

        # One place to ask "where does this file come from".
        #
        # The three tables above are v3's, one per pack, and each is read only
        # by its own ensure_* method. The model dialog read zimage_core_specs
        # alone, so a file listed in either of the others had no URL as far as
        # the UI was concerned - it drew as missing at size "-" with a Download
        # button that started nothing. Every table a graph can name has to be
        # in the lookup, or adding one is adding a way to be silently wrong.
        self.all_specs: Dict[str, Dict[str, Any]] = {}
        for table in (self.zimage_core_specs, self.wan_core_specs,
                      self.flux2klein_core_specs):
            self.all_specs.update(table)

    def spec_for(self, filename: str) -> Optional[Dict[str, Any]]:
        """Where this model comes from, across every table."""
        return self.all_specs.get(filename)

    def get_progress(self, filename: str) -> dict:
        with self.lock:
            return self.progress.get(filename, {"status": "idle", "progress": 0})

    def _update_progress(self, filename: str, status: str, progress: int = 0, error: str = None):
        with self.lock:
            self.progress[filename] = {
                "status": status,
                "progress": progress,
                "error": error,
                "timestamp": time.time()
            }

    def start_url_download(self, url: str, dest_path: Path, filename: str,
                           min_bytes: int = 10240, headers: Optional[dict] = None) -> str:
        """Public entry: begin a background download unless the file is already valid.
        Returns "completed" or "downloading"."""
        return self._start_download_if_needed(filename, dest_path, url, min_bytes, headers=headers)

    def download_direct(self, url: str, dest_path: Path, filename: str, headers: Optional[dict] = None):
        """Standard HTTP download with progress tracking.

        Downloads to a .fedda_tmp sidecar first; only renames to dest_path on
        full success.  This prevents a partial file from ever being mistaken for
        a valid model on subsequent calls.
        """
        tmp_path = dest_path.with_suffix(dest_path.suffix + ".fedda_tmp")
        try:
            dest_path.parent.mkdir(parents=True, exist_ok=True)

            # Resume whatever a previous attempt already fetched. A 28 GB
            # checkpoint restarting from zero because the app was restarted is
            # hours thrown away, and the sidecar is right there on disk.
            resume_from = tmp_path.stat().st_size if tmp_path.exists() else 0
            req_headers = dict(headers or {})
            if resume_from > 0:
                req_headers["Range"] = f"bytes={resume_from}-"

            response = requests.get(url, stream=True, timeout=30, headers=req_headers)

            # A gated Hugging Face repo answers 401 or 403, and
            # raise_for_status turns that into "401 Client Error: Unauthorized
            # for url: https://..." - which reads like the app is broken rather
            # than like a licence nobody has accepted yet. Two clicks fix it,
            # and the message has to be the thing that says which two.
            if response.status_code in (401, 403) and "huggingface.co" in url:
                repo = url.split("/resolve/")[0].replace("https://huggingface.co/", "")
                raise PermissionError(
                    f"{filename} is a gated model. Open "
                    f"https://huggingface.co/{repo} and accept its licence, then "
                    f"add your Hugging Face token in the top bar."
                    + ("" if req_headers.get("Authorization") else " No token is saved yet."))

            response.raise_for_status()

            # 206 means the server honoured the range; anything else means it
            # sent the whole file, so the partial has to go or the two would be
            # concatenated into a corrupt blob.
            resuming = resume_from > 0 and response.status_code == 206
            if resume_from > 0 and not resuming:
                resume_from = 0

            content_length = int(response.headers.get("content-length", 0))
            total_size = content_length + resume_from if content_length else 0
            downloaded_size = resume_from
            self._update_progress(
                filename, "downloading",
                int(resume_from / total_size * 100) if total_size else 0,
            )

            with open(tmp_path, "ab" if resuming else "wb") as f:
                for chunk in response.iter_content(chunk_size=65536):
                    if chunk:
                        f.write(chunk)
                        downloaded_size += len(chunk)
                        if total_size > 0:
                            prog = int((downloaded_size / total_size) * 100)
                            if prog % 5 == 0:
                                self._update_progress(filename, "downloading", prog)

            # Validate we got what we expected before promoting
            if total_size > 0 and downloaded_size < total_size:
                raise IOError(
                    f"Download truncated: got {downloaded_size} of {total_size} bytes"
                )

            # Atomic-ish rename: removes stale dest if it somehow exists
            if dest_path.exists():
                dest_path.unlink()
            tmp_path.rename(dest_path)

            self._update_progress(filename, "completed", 100)
            return True
        except Exception as e:
            self._update_progress(filename, "error", 0, str(e))
            # The sidecar is deliberately kept: it is what the next attempt
            # resumes from. Only a half-written destination is dangerous,
            # because that is the name everything else treats as a real model.
            try:
                if dest_path.exists():
                    dest_path.unlink()
            except OSError:
                pass
            return False
        finally:
            with self.lock:
                self._active_downloads.pop(filename, None)

    def _is_valid_file(self, path: Path, min_bytes: int = 10240) -> bool:
        """Return True only for a fully-committed (non-.fedda_tmp) file of sufficient size."""
        try:
            # Never count the temp sidecar as valid
            if path.suffix == ".fedda_tmp":
                return False
            return path.exists() and path.stat().st_size >= min_bytes
        except Exception:
            return False

    def _dest_path_for_spec(self, spec: Dict[str, Any], filename: str) -> Path:
        """Where a download would go. Always FEDDA's own tree, never the
        user's library - we read from that folder and do not write to it."""
        if spec.get("root_relative_path"):
            return self.root_dir / spec["root_relative_path"]
        return self.comfy_models_dir / spec["relative_dir"] / filename

    def _extra_models_dir(self) -> Optional[Path]:
        """The library the user pointed at in Settings > Folders, if any."""
        try:
            settings = json.loads(
                (self.root_dir / "config" / "runtime_settings.json")
                .read_text(encoding="utf-8-sig"))
        except (OSError, ValueError):
            return None
        raw = str(settings.get("extra_models_path") or "").strip()
        if not raw:
            return None
        path = Path(raw)
        return path if path.is_dir() else None

    def _already_present(self, spec: Dict[str, Any], filename: str,
                         min_bytes: int) -> bool:
        """Is this model anywhere ComfyUI can see it?

        Both roots, because a file in the user's library is as loadable as one
        in ours - ComfyUI is given both as search paths at launch. Asking only
        about our own folder is what made an install with a library attached
        refuse to generate and then download what it already had.
        """
        if self._is_valid_file(self._dest_path_for_spec(spec, filename), min_bytes):
            return True
        extra = self._extra_models_dir()
        if not extra or spec.get("root_relative_path"):
            return False
        # The same layout, one folder up: the yaml gives both trees the same
        # folder names, so a spec's relative_dir applies to either.
        return self._is_valid_file(extra / spec["relative_dir"] / filename, min_bytes)

    def _start_download_if_needed(self, filename: str, dest_path: Path, url: str, min_bytes: int,
                                  headers: Optional[dict] = None,
                                  present: bool = False) -> str:
        if present or self._is_valid_file(dest_path, min_bytes=min_bytes):
            self._update_progress(filename, "completed", 100)
            return "completed"

        with self.lock:
            existing = self._active_downloads.get(filename)
            if existing and existing.is_alive():
                return "downloading"

            # Clean up any stale .fedda_tmp left by a previous interrupted run
            tmp_path = dest_path.with_suffix(dest_path.suffix + ".fedda_tmp")
            try:
                if tmp_path.exists():
                    tmp_path.unlink()
            except OSError:
                pass

            t = threading.Thread(
                target=self.download_direct,
                args=(url, dest_path, filename, headers),
                daemon=True,
            )
            self._active_downloads[filename] = t
            t.start()
            return "downloading"

    def ensure_zimage_core_models(self, required_filenames: Optional[List[str]] = None) -> Dict[str, Any]:
        """
        Ensure required Z-Image core models are present.
        Starts background downloads for missing files and returns a status summary.
        """
        names = required_filenames or list(self.zimage_core_specs.keys())
        file_states: List[Dict[str, Any]] = []

        for filename in names:
            spec = self.zimage_core_specs.get(filename)
            if not spec:
                file_states.append({
                    "filename": filename,
                    "status": "unknown",
                    "error": "No download spec found for this model",
                })
                continue

            dest_path = self._dest_path_for_spec(spec, filename)
            min_bytes = int(spec.get("min_bytes", 10240))
            status = self._start_download_if_needed(
                filename, dest_path, str(spec["url"]), min_bytes,
                present=self._already_present(spec, filename, min_bytes))
            progress = self.get_progress(filename)

            file_states.append({
                "filename": filename,
                "status": status,
                "progress": int(progress.get("progress", 0)),
                "path": str(dest_path),
                # Both trees, like the download gate above. Asking only
                # about our own folder here was what kept `ready` false
                # even once the file had been found in the library - the
                # status said completed and this said missing.
                "exists": self._already_present(spec, filename, min_bytes),
                "error": progress.get("error"),
            })

        ready = bool(file_states) and all(f["status"] == "completed" and f["exists"] for f in file_states)
        return {
            "success": True,
            "ready": ready,
            "files": file_states,
        }

    def ensure_wan_core_models(self, required_filenames: Optional[List[str]] = None) -> Dict[str, Any]:
        """Ensure WAN models that Comfy validates before downloader nodes can run."""
        names = required_filenames or list(self.wan_core_specs.keys())
        file_states: List[Dict[str, Any]] = []

        for filename in names:
            spec = self.wan_core_specs.get(filename)
            if not spec:
                file_states.append({
                    "filename": filename,
                    "status": "unknown",
                    "error": "No download spec found for this model",
                })
                continue

            dest_path = self._dest_path_for_spec(spec, filename)
            min_bytes = int(spec.get("min_bytes", 10240))
            status = self._start_download_if_needed(
                filename, dest_path, str(spec["url"]), min_bytes,
                present=self._already_present(spec, filename, min_bytes))
            progress = self.get_progress(filename)

            file_states.append({
                "filename": filename,
                "status": status,
                "progress": int(progress.get("progress", 0)),
                "path": str(dest_path),
                # Both trees, like the download gate above. Asking only
                # about our own folder here was what kept `ready` false
                # even once the file had been found in the library - the
                # status said completed and this said missing.
                "exists": self._already_present(spec, filename, min_bytes),
                "error": progress.get("error"),
            })

        ready = bool(file_states) and all(f["status"] == "completed" and f["exists"] for f in file_states)
        return {
            "success": True,
            "ready": ready,
            "files": file_states,
        }

    def ensure_flux2klein_core_models(self, required_filenames: Optional[List[str]] = None) -> Dict[str, Any]:
        """Ensure FLUX2-Klein core model files are present before queueing Comfy."""
        names = required_filenames or list(self.flux2klein_core_specs.keys())
        file_states: List[Dict[str, Any]] = []

        for filename in names:
            spec = self.flux2klein_core_specs.get(filename)
            if not spec:
                file_states.append({
                    "filename": filename,
                    "status": "unknown",
                    "error": "No download spec found for this model",
                })
                continue

            dest_path = self._dest_path_for_spec(spec, filename)
            min_bytes = int(spec.get("min_bytes", 10240))
            status = self._start_download_if_needed(
                filename, dest_path, str(spec["url"]), min_bytes,
                present=self._already_present(spec, filename, min_bytes))
            progress = self.get_progress(filename)

            file_states.append({
                "filename": filename,
                "status": status,
                "progress": int(progress.get("progress", 0)),
                "path": str(dest_path),
                # Both trees, like the download gate above. Asking only
                # about our own folder here was what kept `ready` false
                # even once the file had been found in the library - the
                # status said completed and this said missing.
                "exists": self._already_present(spec, filename, min_bytes),
                "error": progress.get("error"),
            })

        ready = bool(file_states) and all(f["status"] == "completed" and f["exists"] for f in file_states)
        return {
            "success": True,
            "ready": ready,
            "files": file_states,
        }

    def sync_hf_repo(self, repo_id: str, subfolder: str, limit: Optional[int] = None):
        """Syncs all .safetensors from a HuggingFace repo to models/loras/<subfolder>."""
        try:
            dest_dir = self.comfy_models_dir / "loras" / subfolder
            dest_dir.mkdir(parents=True, exist_ok=True)

            # 1. Fetch file list from HF API
            url = f"https://huggingface.co/api/models/{repo_id}/tree/main"
            resp = requests.get(url, timeout=10)
            resp.raise_for_status()
            
            items = resp.json()
            files = [item["path"] for item in items if item["path"].lower().endswith(".safetensors")]
            
            if limit:
                files = files[:limit]

            # 2. Download loop
            # For brevity, we process sequentially in a thread
            def _task():
                for f in files:
                    filename = Path(f).name
                    local_path = dest_dir / filename
                    if local_path.exists() and local_path.stat().st_size > 10000:
                        continue # Skip existing
                    
                    file_url = f"https://huggingface.co/{repo_id}/resolve/main/{f}"
                    self.download_direct(file_url, local_path, filename)
            
            threading.Thread(target=_task, daemon=True).start()
            return {"success": True, "total_files": len(files)}
        except Exception as e:
            return {"success": False, "error": str(e)}

# Instance for shared use
model_downloader = ModelDownloader(Path(__file__).parent.parent)

