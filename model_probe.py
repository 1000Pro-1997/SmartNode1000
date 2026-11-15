"""파일을 열어보지 않고 무엇인지 알아낸다.

safetensors 는 맨 앞에 JSON 머리말이 붙어 있다 — 어떤 텐서가 들었는지,
가끔은 무슨 모델인지까지 적혀 있다. 몇십 KB 만 읽으면 되므로 수 GB 짜리도
곧바로 본다. GGUF 도 제 머리말이 있다.

무엇에 쓰는가.
    브라우저로 받아 둔 파일을 가져올 때, 이게 로라인지 체크포인트인지
    UNet 인지 사람이 고르게 하면 틀리기 쉽다. 해시로 Civitai 에 물어보면
    가장 정확하지만 거기 없는 파일도 많다(허깅페이스에서 받은 것들).
    그때 이 머리말이 답을 준다.

어떻게 가리는가.
    텐서 이름의 첫 칸(과 model. 아래 한 칸)을 센다. 이름 규칙이 종류마다 뚜렷하다.
        lora_down / lora_A / lora_unet ...       로라
        텐서 몇 개뿐                              임베딩
        몸통 + VAE/텍스트 인코더                 체크포인트(SAM 3 도)
        controlnet_blocks / control_blocks       컨트롤넷 / 모델 패치
        model.layers / embed_tokens / lm_head    텍스트 인코더(Qwen·Gemma 등 언어 모델)
        vision_model                             CLIP Vision
        blocks / double_blocks / t_embedder ...  UNet·DiT 단독
        encoder + decoder 만                     VAE
        encoder 만 (T5/CLIP 꼴)                  텍스트 인코더
    안을 봐도 모르면 파일 이름을 본다(name_hint). GGUF 는 머리말의 구조 이름을 본다.
    그래도 모르면 빈 문자열을 준다. 틀리게 찍는 것보다 모른다고 하는 편이 낫다.

    Comfy-Org 허깅페이스 저장소 파일 310개의 머리말로 맞춰 보았다.
"""

import json
import os
import re
import struct
from collections import Counter

# 머리말이 이보다 크면 읽지 않는다. 정상 파일은 수십 KB 를 넘지 않는다.
MAX_HEADER = 32 * 1024 * 1024

# 로라임을 알려주는 텐서 이름 조각.
#
# ".alpha" 는 넣으면 안 된다. LTX 같은 큰 모델의 어텐션 텐서에도 .alpha 가
# 붙어서 체크포인트를 로라로 잘못 찍는다. 로라 특유의 이름만 남긴다.
LORA_MARKS = ("lora_down", "lora_up", "lora_a.", "lora_b.", "lora_unet", "lora_te",
              "hada_w", "lokr_", "lora_magnitude", "lora.down", "lora.up")
# proj_lora1.down 처럼 이름 가운데 lora 가 낀 꼴(USO 등)
_LORA_RE = re.compile(r"[._]lora\d*[._]")

# 텐서 몇 개짜리 파일에서 임베딩임을 알려주는 이름
EMBEDDING_TOPS = {"emb_params", "string_to_param", "clip_l", "clip_g", "conditioning", "attention_mask"}
# 언어 모델(텍스트 인코더) 이 'model.' 아래에 두는 것들
LLM_PARTS = {"layers", "embed_tokens", "language_model", "lm_head", "visual", "vision_tower"}
# 그림·영상 만드는 몸통(DiT/UNet) 의 첫 칸
DIT_MARKS = {"blocks", "double_blocks", "single_blocks", "transformer_blocks", "single_transformer_blocks",
             "joint_blocks", "double_stream_blocks", "single_stream_blocks", "single_stream_layers",
             "double_stream_layers", "noise_refiner", "context_refiner", "t_embedder", "x_embedder",
             "time_embedding", "time_in", "time_text_embed", "patch_embedding", "diffusion_transformer",
             "input_blocks", "img_in", "final_layer", "t_embedding", "adaln_single"}
# 시간(노이즈 단계) 을 받는 칸. 몸통인지, 몸통에 끼우는 부품인지를 가른다.
TIME_MARKS = {"time_embedding", "time_in", "t_embedder", "time_text_embed", "t_embedding",
              "time_embed", "time_embedder", "adaln_single", "emb_in", "tmlp", "time_caption_embed"}
# VAE 에 붙어 오는 것들. 이것 말고 다른 것이 있으면 VAE 가 아니다.
VAE_TOPS = {"encoder", "decoder", "quant_conv", "post_quant_conv", "bn", "latents_mean", "latents_std",
            "conv1", "conv2", "pre_block", "dec_in_proj", "logs_proj"}


def _safetensors_header(path):
    """맨 앞 JSON 머리말. 못 읽으면 None."""
    try:
        with open(path, "rb") as f:
            raw = f.read(8)
            if len(raw) < 8:
                return None
            size = struct.unpack("<Q", raw)[0]
            if size <= 0 or size > MAX_HEADER:
                return None
            body = f.read(size)
        data = json.loads(body.decode("utf-8"))
    except (OSError, ValueError, struct.error, UnicodeDecodeError):
        return None
    return data if isinstance(data, dict) else None


# 파일 이름으로 종류를 짐작할 때 쓰는 낱말. 위에서부터 먼저 맞는 것이 이긴다
# (qwen_image_vae 는 vae, qwen_lora 는 로라).
NAME_HINTS = (
    ("loras", ("lora", "locon", "lycoris", "dora_")),
    ("upscale_models", ("esrgan", "upscal", "remacri", "ultrasharp", "swinir", "nmkd",
                        "animesharp", "realesr", "lanczos")),
    ("controlnet", ("controlnet", "control_", "control-", "t2i-adapter", "t2iadapter", "coadapter")),
    ("clip_vision", ("clip_vision", "clip-vision", "clipvision", "siglip", "dino_v", "dinov")),
    ("vae", ("vae",)),
    ("text_encoders", ("t5xxl", "umt5", "clip_l", "clip_g", "text_encoder", "byt5", "qwen",
                       "gemma", "llama", "mistral", "llava")),
    ("checkpoints", ("sam3",)),
    ("sams", ("sam_vit", "mobile_sam")),
)

# GGUF 구조 이름 가운데 언어 모델(텍스트 인코더) 인 것. 나머지는 몸통으로 본다
# (city96 판 GGUF 는 flux·wan·sdxl 같은 이름을 적는다).
GGUF_TEXT = ("llama", "qwen", "gemma", "mistral", "t5", "phi", "glm", "clip", "bert")


def name_hint(path):
    """파일 이름으로 짐작한 종류. 모르면 빈 문자열."""
    low = os.path.basename(path).lower()
    if re.match(r"^\d+x[-_ ]", low):
        return "upscale_models"
    for kind, words in NAME_HINTS:
        if any(word in low for word in words):
            return kind
    return ""


def _gguf_architecture(path):
    """GGUF 머리말의 general.architecture. 첫 항목에 있을 때만 읽는다."""
    try:
        with open(path, "rb") as f:
            head = f.read(24)
            if len(head) < 24 or head[:4] != b"GGUF":
                return ""
            size = struct.unpack("<Q", f.read(8))[0]
            if size > 256:
                return ""
            key = f.read(size).decode("utf-8", "replace")
            kind = struct.unpack("<I", f.read(4))[0]
            if key != "general.architecture" or kind != 8:  # 8 = 문자열
                return ""
            size = struct.unpack("<Q", f.read(8))[0]
            if size > 256:
                return ""
            return f.read(size).decode("utf-8", "replace").strip().lower()
    except (OSError, struct.error):
        return ""


def _gguf_name(path):
    """GGUF 인지만 본다. 머리말 구조가 복잡해 이름만 확인한다."""
    try:
        with open(path, "rb") as f:
            return f.read(4) == b"GGUF"
    except OSError:
        return False


def _guess_kind(keys, meta):
    """텐서 이름으로 종류를 가린다. 모르면 빈 문자열.

    차례가 중요하다. 여러 벌을 담은 것(로라·체크포인트)을 먼저 가리고,
    그다음 생김새가 뚜렷한 것부터 본다.
    """
    lowered = [k.lower() for k in keys]
    joined = " ".join(lowered)

    # 로라는 이름에 표시가 뚜렷하다
    if any(mark in joined for mark in LORA_MARKS) or _LORA_RE.search(joined):
        return "loras"

    tops = Counter(k.split(".")[0] for k in lowered)
    has = lambda name: tops.get(name, 0) > 0  # noqa: E731
    # 'model.' 아래로 한 번 더 감싼 꼴이 흔하다(model.language_model.…, model.encoder.…)
    inner = Counter(k.split(".")[1] for k in lowered if k.startswith("model.") and k.count(".") >= 2)

    # 텐서 몇 개뿐인 것은 임베딩(텍스추얼 인버전·미리 계산한 조건)
    if len(keys) <= 6 and (tops.keys() & EMBEDDING_TOPS or all("." not in k for k in lowered)):
        return "embeddings"

    # SAM 3 는 detector + tracker 를 한 파일에, 예전 SAM 은 세 부분으로 온다
    if has("detector") and has("tracker"):
        return "checkpoints"
    if has("image_encoder") and has("mask_decoder"):
        return "sams"

    # 여러 벌을 한 파일에 담은 것이 체크포인트다 — 그림 만드는 몸통에
    # VAE 나 텍스트 인코더가 딸려 있다.
    body = has("model") or has("diffusion_model") or has("model_ema")
    vae_part = has("first_stage_model") or has("vae") or has("audio_vae") or has("pretransform")
    text_part = has("conditioner") or has("cond_stage_model") or has("text_encoders")
    if body and (vae_part or text_part):
        return "checkpoints"
    # 언어 모델에 그림 만드는 머리를 붙인 것(HiDream-O1 꼴)
    if inner.keys() & LLM_PARTS and inner.keys() & DIT_MARKS:
        return "checkpoints"

    # 컨트롤넷. 몸통 없이 제어 블록만 있으면 모델 패치(DiffSynth·Fun 계열).
    # 디퓨저스 꼴(controlnet_down_blocks·controlnet_cond_embedding)도 컨트롤넷이다.
    diffusers_cn = any(t.startswith("controlnet_") and t != "controlnet_blocks" for t in tops)
    if has("controlnet_blocks") or has("input_hint_block") or has("control_model") or diffusers_cn:
        if (has("transformer_blocks") or has("input_blocks") or has("input_hint_block")
                or has("control_model") or diffusers_cn):
            return "controlnet"
        return "model_patches"
    if has("control_blocks") or any(t.startswith("lllite_") for t in tops):
        return "model_patches"

    # 소리 인코더(wav2vec2·Whisper). 언어 모델과 이름이 겹쳐 먼저 본다.
    if has("wav2vec2") or ("encoder_attn" in joined and ".conv1." in joined):
        return "audio_encoders"

    # 언어 모델(Qwen·Gemma·Mistral·Llama). 요즘 텍스트 인코더는 대개 이 꼴이다.
    # 비전 칸이 딸려 와도(VL) 텍스트 인코더 자리에 넣는다.
    if (inner.keys() & LLM_PARTS or "embed_tokens" in joined or has("lm_head")
            or has("thinker")):
        return "text_encoders"
    if has("model") and inner.keys() >= {"encoder", "decoder"} and has("spiece_model"):
        return "text_encoders"  # T5Gemma
    if has("model") and "encoder" in inner and not ("decoder" in inner):
        return "text_encoders"  # jina-clip 등

    # CLIP Vision. 언어 모델이 딸린 것은 위에서 이미 걸렀다.
    if has("vision_model") or (has("layer") and has("embeddings") and len(tops) <= 4):
        return "clip_vision"

    # 몸통만 있으면 UNet/DiT 단독. 요즘 영상·이미지 모델이 대개 이 꼴이다.
    if has("diffusion_model") or any(k.startswith("model.diffusion_model.") for k in lowered):
        return "diffusion_models"
    timed = tops.keys() & TIME_MARKS or inner.keys() & TIME_MARKS
    # 잠재 공간 업스케일러: 시간 칸 없이 들어가고 나가는 합성곱만 있다
    if (not timed and tops.keys() & {"in_conv", "conv_in", "initial_conv"}
            and tops.keys() & {"out_conv", "conv_out", "final_conv"} and len(tops) <= 6):
        return "latent_upscale_models"
    # 영상 모델에 끼우는 소리 패치(InfiniteTalk 꼴)
    if has("blocks") and has("audio_proj") and not timed:
        return "model_patches"
    if tops.keys() & DIT_MARKS or inner.keys() & DIT_MARKS:
        return "diffusion_models"
    if has("model") and len(inner) <= 6 and sum(inner.values()) >= 200 and not tops.keys() - {"model"}:
        return "diffusion_models"  # model.model.… 나 model.<부품>.blocks… 로 한 번 더 싼 것

    # 업스케일러(ESRGAN·SwinIR 꼴)
    if has("conv_first") or has("rrdb_trunk"):
        return "upscale_models"

    # VAE 는 encoder 와 decoder 가 짝으로 있다
    others = set(tops) - VAE_TOPS
    if has("decoder") and not others and (has("encoder") or len(tops) <= 3):
        return "vae"

    # 텍스트 인코더(T5·CLIP)는 encoder 쪽만 있다
    if has("encoder") and not has("decoder"):
        return "text_encoders"
    if has("text_model") or has("logit_scale"):
        return "text_encoders"

    # 곁다리 정보가 알려주기도 한다
    said = " ".join(str(v).lower() for v in (meta or {}).values())
    if "lora" in said:
        return "loras"
    return ""


def probe(path):
    """파일 하나를 들여다본다. 알아낸 것만 담아 준다."""
    out = {"kind": "", "base_model": "", "tensors": 0, "format": "",
           "title": "", "note": ""}
    ext = os.path.splitext(path)[1].lower()

    if ext in (".safetensors", ".sft"):  # .sft 는 이름만 다른 safetensors
        head = _safetensors_header(path)
        if head is None:
            out["note"] = "머리말을 읽지 못함"
            return out
        out["format"] = "safetensors"
        meta = head.get("__metadata__") if isinstance(head.get("__metadata__"), dict) else {}
        keys = [k for k in head if k != "__metadata__"]
        out["tensors"] = len(keys)
        out["kind"] = _guess_kind(keys, meta) or name_hint(path)
        # 만든 사람이 적어 둔 것이 있으면 그대로 쓴다
        for key in ("modelspec.title", "ss_output_name", "title"):
            if isinstance(meta.get(key), str) and meta[key].strip():
                out["title"] = meta[key].strip()[:120]
                break
        for key in ("base_model", "modelspec.architecture", "ss_base_model_version",
                    "ss_sd_model_name"):
            if isinstance(meta.get(key), str) and meta[key].strip():
                out["base_model"] = meta[key].strip()[:80]
                break
        return out

    if ext == ".gguf" or _gguf_name(path):
        out["format"] = "gguf"
        # 구조 이름이 언어 모델이면 텍스트 인코더, 아니면 줄여 담은 몸통이다
        arch = _gguf_architecture(path)
        out["base_model"] = arch
        if "lora" in os.path.basename(path).lower():
            out["kind"] = "loras"
        elif arch.startswith(GGUF_TEXT) or (not arch and name_hint(path) == "text_encoders"):
            out["kind"] = "text_encoders"
        else:
            out["kind"] = "diffusion_models"
        return out

    if ext in (".pt", ".pth", ".bin", ".ckpt", ".onnx"):
        out["format"] = ext.lstrip(".")
        # 절인 토치 파일이라 안을 못 본다(열면 코드가 돌 수도 있어 열지 않는다).
        # 이름 말고는 볼 것이 없으므로 확실할 때만 찍는다.
        out["kind"] = name_hint(path)
        return out

    out["format"] = ext.lstrip(".")
    return out
