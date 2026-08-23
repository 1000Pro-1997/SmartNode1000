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
    텐서 이름의 첫 칸을 센다. 이름 규칙이 종류마다 뚜렷하다.
        lora_down / lora_A / lora_unet ...   로라
        first_stage_model + conditioner      체크포인트(SDXL)
        model.diffusion_model + cond_stage   체크포인트(SD1.5)
        diffusion_model 만                   UNet 단독
        encoder + decoder 만                 VAE
        encoder 만 (T5/CLIP 꼴)              텍스트 인코더
    확실하지 않으면 빈 문자열을 준다. 틀리게 찍는 것보다 모른다고 하는 편이 낫다.
"""

import json
import os
import struct
from collections import Counter

# 머리말이 이보다 크면 읽지 않는다. 정상 파일은 수십 KB 를 넘지 않는다.
MAX_HEADER = 32 * 1024 * 1024

# 로라임을 알려주는 텐서 이름 조각.
#
# ".alpha" 는 넣으면 안 된다. LTX 같은 큰 모델의 어텐션 텐서에도 .alpha 가
# 붙어서 체크포인트를 로라로 잘못 찍는다. 로라 특유의 이름만 남긴다.
LORA_MARKS = ("lora_down", "lora_up", "lora_a.", "lora_b.", "lora_unet", "lora_te",
              "hada_w", "lokr_", "lora_magnitude")


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


def _gguf_name(path):
    """GGUF 인지만 본다. 머리말 구조가 복잡해 이름만 확인한다."""
    try:
        with open(path, "rb") as f:
            return f.read(4) == b"GGUF"
    except OSError:
        return False


def _guess_kind(keys, meta):
    """텐서 이름으로 종류를 가린다. 모르면 빈 문자열."""
    lowered = [k.lower() for k in keys]
    joined = " ".join(lowered)

    # 로라는 이름에 표시가 뚜렷하다. 텐서 수도 적다.
    if any(mark in joined for mark in LORA_MARKS):
        return "loras"

    tops = Counter(k.split(".")[0] for k in lowered)
    has = lambda name: tops.get(name, 0) > 0  # noqa: E731

    # CLIP Vision 은 vision_model 하나로 뚜렷하다. 텍스트 인코더보다 먼저 본다.
    if has("vision_model"):
        return "clip_vision"

    # 여러 벌을 한 파일에 담은 것이 체크포인트다 — 그림 만드는 몸통에
    # VAE 나 텍스트 인코더가 딸려 있다. 이름 규칙이 판마다 다르다.
    body = has("model") or has("diffusion_model") or has("model_ema")
    vae_part = has("first_stage_model") or has("vae") or has("audio_vae")
    text_part = has("conditioner") or has("cond_stage_model") or has("text_encoders")
    if body and (vae_part or text_part):
        return "checkpoints"

    # 몸통만 있으면 UNet 단독. 요즘 영상 모델이 대개 이 꼴이다.
    if has("diffusion_model") or any(k.startswith("model.diffusion_model.") for k in lowered):
        return "diffusion_models"

    # VAE 는 encoder 와 decoder 가 짝으로 있다
    if has("encoder") and has("decoder") and len(tops) <= 4:
        return "vae"
    if has("decoder") and not has("encoder") and len(tops) <= 3:
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

    if ext == ".safetensors":
        head = _safetensors_header(path)
        if head is None:
            out["note"] = "머리말을 읽지 못함"
            return out
        out["format"] = "safetensors"
        meta = head.get("__metadata__") if isinstance(head.get("__metadata__"), dict) else {}
        keys = [k for k in head if k != "__metadata__"]
        out["tensors"] = len(keys)
        out["kind"] = _guess_kind(keys, meta)
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
        # GGUF 는 대개 UNet 을 줄여 담은 것이다. 이름으로 로라를 가려낸다.
        low = os.path.basename(path).lower()
        out["kind"] = "loras" if "lora" in low else "diffusion_models"
        return out

    if ext in (".pt", ".pth", ".bin", ".ckpt"):
        out["format"] = ext.lstrip(".")
        low = os.path.basename(path).lower()
        # 절인 토치 파일이라 안을 못 본다(열면 코드가 돌 수도 있어 열지 않는다).
        # 이름 말고는 볼 것이 없으므로 확실할 때만 찍는다.
        import re
        if re.match(r"^\d+x[-_ ]", low) or any(
                w in low for w in ("esrgan", "upscal", "remacri", "ultrasharp", "swinir",
                                   "nmkd", "animesharp", "lanczos", "realesr")):
            out["kind"] = "upscale_models"
        elif "controlnet" in low or low.startswith("control_") or low.startswith("control-"):
            out["kind"] = "controlnet"
        elif "vae" in low:
            out["kind"] = "vae"
        elif "lora" in low:
            out["kind"] = "loras"
        return out

    out["format"] = ext.lstrip(".")
    return out
