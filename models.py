"""모델 폴더(로라·체크포인트)를 다루는 공용 계층.

곁다리 규칙은 한 가지다 — 모델 파일 옆에 <이름>.metadata.json 과
<이름>.preview.<확장자> 를 둔다. 로라 창이 쓰던 규칙 그대로이고,
LoRA Manager 가 만들어 둔 파일도 같은 모양이라 그대로 읽힌다.

api.py 와 civitai.py 가 로라만 알던 시절의 헬퍼들을 여기로 모았다.
종류를 kind 로 받으므로 체크포인트도 같은 길을 탄다. 종류를 늘릴 때는
KINDS 에 한 줄 더한다.

여기서는 우리 패키지의 다른 모듈을 가져오지 않는다. api.py 와 civitai.py 가
이 파일을 가져다 쓰므로, 반대로 물면 서로 물고 도는 임포트가 된다.
"""

import json
import os
import subprocess
import sys
import time
from urllib.parse import quote, urlparse

from aiohttp import web
from server import PromptServer

import folder_paths

routes = PromptServer.instance.routes

# 다루는 모델 종류.
#   folder  : folder_paths 가 아는 폴더 이름
#   label   : 카드 배지에 붙는 말("Checkpoint | SDXL")
#   civitai : Civitai API 의 types 값
#
# ComfyUI 판이나 깔린 확장에 따라 없는 폴더가 있다(ipadapter·sams 등은
# 확장이 등록한다). 등록되지 않은 폴더의 종류는 없는 것으로 친다(known).
KINDS = {
    "loras": {"folder": "loras", "label": "LoRA", "civitai": "LORA"},
    "checkpoints": {"folder": "checkpoints", "label": "Checkpoint", "civitai": "Checkpoint"},
    "diffusion_models": {"folder": "diffusion_models", "label": "UNet", "civitai": ""},
    "vae": {"folder": "vae", "label": "VAE", "civitai": "VAE"},
    "text_encoders": {"folder": "text_encoders", "label": "Text encoder", "civitai": ""},
    "clip_vision": {"folder": "clip_vision", "label": "CLIP Vision", "civitai": ""},
    "controlnet": {"folder": "controlnet", "label": "ControlNet", "civitai": "Controlnet"},
    "model_patches": {"folder": "model_patches", "label": "Model patch", "civitai": ""},
    "upscale_models": {"folder": "upscale_models", "label": "Upscaler", "civitai": "Upscaler"},
    "latent_upscale_models": {"folder": "latent_upscale_models", "label": "Latent upscaler", "civitai": ""},
    "embeddings": {"folder": "embeddings", "label": "Embedding", "civitai": "TextualInversion"},
    "hypernetworks": {"folder": "hypernetworks", "label": "Hypernetwork", "civitai": "Hypernetwork"},
    "style_models": {"folder": "style_models", "label": "Style model", "civitai": ""},
    "audio_encoders": {"folder": "audio_encoders", "label": "Audio encoder", "civitai": ""},
    "photomaker": {"folder": "photomaker", "label": "PhotoMaker", "civitai": ""},
    "gligen": {"folder": "gligen", "label": "GLIGEN", "civitai": ""},
    "detection": {"folder": "detection", "label": "Detection", "civitai": ""},
    "background_removal": {"folder": "background_removal", "label": "Background removal", "civitai": ""},
    "frame_interpolation": {"folder": "frame_interpolation", "label": "Frame interpolation", "civitai": ""},
    "vae_approx": {"folder": "vae_approx", "label": "VAE approx", "civitai": ""},
    # 확장이 등록하는 폴더
    "ipadapter": {"folder": "ipadapter", "label": "IPAdapter", "civitai": ""},
    "sams": {"folder": "sams", "label": "SAM", "civitai": ""},
    "ultralytics_bbox": {"folder": "ultralytics_bbox", "label": "YOLO bbox", "civitai": "Detection"},
    "ultralytics_segm": {"folder": "ultralytics_segm", "label": "YOLO segm", "civitai": ""},
    "animatediff_models": {"folder": "animatediff_models", "label": "Motion module", "civitai": "MotionModule"},
    "animatediff_motion_lora": {"folder": "animatediff_motion_lora", "label": "Motion LoRA", "civitai": ""},
    "insightface": {"folder": "insightface", "label": "InsightFace", "civitai": ""},
    "facerestore_models": {"folder": "facerestore_models", "label": "Face restore", "civitai": ""},
}

# '내 모델' 탭에서 오갈 수 있는 종류. 해시로 정보를 채우고 업데이트를
# 확인하는 자리라 이 둘만 뜻이 있다. 나머지는 담아 두기만 하는 자리다.
MAIN_KINDS = ("loras", "checkpoints")

DEFAULT_KIND = "loras"

# 대표 이미지로 쓸 수 있는 형식
PREVIEW_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".webm")
VIDEO_EXTS = (".mp4", ".webm")
PREVIEW_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                 ".webp": "image/webp", ".gif": "image/gif",
                 ".mp4": "video/mp4", ".webm": "video/webm"}
# 대표 이미지 맨 뒤에 붙이는 꼬리표(<이름>.preview.jpeg.node).
# 탐색기가 모르는 확장자라 썸네일을 그리지 않는다 — 성인물 대표 이미지가
# 모델 폴더를 열 때마다 그대로 보이지 않게 하려는 것이다.
HIDE_SUFFIX = ".node"
# 업로드 상한. 예시 영상이 몇 MB 씩 하므로 넉넉히 잡는다.
MAX_PREVIEW_BYTES = 64 * 1024 * 1024
# Civitai nsfwLevel 비트마스크에서 R 등급(4) 이상이면 성인물로 본다.
ADULT_LEVEL = 4


# -------------------------------------------------- 종류


def _registered(folder):
    return bool(folder) and folder in folder_paths.folder_names_and_paths


def known(kind):
    """아는 종류이고 ComfyUI 에 그 폴더가 등록되어 있는지."""
    entry = KINDS.get(kind)
    return bool(entry) and _registered(entry["folder"])


def available():
    """지금 쓸 수 있는 종류들. KINDS 순서 그대로."""
    return [kind for kind in KINDS if known(kind)]


def folder_of(kind):
    """folder_paths 폴더 이름. 모르거나 등록되지 않은 종류면 None."""
    entry = KINDS.get(kind)
    return entry["folder"] if entry and _registered(entry["folder"]) else None


def label_of(kind):
    entry = KINDS.get(kind)
    return entry["label"] if entry else ""


def civitai_type(kind):
    entry = KINDS.get(kind)
    return entry["civitai"] if entry else ""


def names(kind):
    folder = folder_of(kind)
    return folder_paths.get_filename_list(folder) if folder else []


def roots(kind):
    folder = folder_of(kind)
    return folder_paths.get_folder_paths(folder) if folder else []


def invalidate(kind):
    """목록 캐시를 버린다. 파일을 넣거나 뺀 뒤에 부른다."""
    folder = folder_of(kind)
    if folder:
        folder_paths.filename_list_cache.pop(folder, None)


# -------------------------------------------------- 경로


def inside_roots(kind, path):
    """모델 폴더 안의 경로인지 본다. 밖이면 None.

    심볼릭 링크로 폴더 밖을 가리키는 곁다리 파일을 지우거나 내려보내지
    않으려고, 지우기·읽기 전에 항상 여기를 한 번 통과시킨다.
    """
    if not folder_of(kind):
        return None
    resolved = os.path.realpath(path)
    for root in roots(kind):
        try:
            if os.path.commonpath([resolved, os.path.realpath(root)]) == os.path.realpath(root):
                return resolved
        except ValueError:
            continue  # 윈도우에서 드라이브가 다르면 비교가 안 된다
    return None


def paths(kind, name):
    """모델 파일 경로와 곁다리 메타데이터 경로. 없으면 (None, None).

    목록 캐시를 보지 않고 folder_paths 에 직접 묻는다. 방금 받은 파일도
    바로 찾을 수 있어야 하기 때문이다.
    """
    folder = folder_of(kind)
    if not folder or not isinstance(name, str) or not name:
        return None, None
    full = folder_paths.get_full_path(folder, name)
    if full is None or not os.path.isfile(full):
        return None, None
    return full, os.path.splitext(full)[0] + ".metadata.json"


def preview_file(stem, ext):
    """이 모델의 대표 이미지를 새로 쓸 자리."""
    return stem + ".preview" + ext + HIDE_SUFFIX


def preview_ext(path):
    """대표 이미지의 진짜 확장자. 숨김 꼬리표는 떼고 본다."""
    if path.lower().endswith(HIDE_SUFFIX):
        path = path[:-len(HIDE_SUFFIX)]
    return os.path.splitext(path)[1].lower()


def is_video_preview(path):
    return bool(path) and preview_ext(path) in VIDEO_EXTS


def preview_files(stem):
    """이 모델 옆에 있을 수 있는 대표 이미지 이름 전부. 숨긴 것이 앞이다."""
    return ([preview_file(stem, e) for e in PREVIEW_EXTS]
            + [stem + ".preview" + e for e in PREVIEW_EXTS]
            + [stem + e for e in PREVIEW_EXTS])


def _hide(stem, path):
    """드러나 있는 <이름>.preview.<확장자> 를 숨긴 이름으로 바꾼다.

    LoRA Manager 가 쓰는 <이름>.jpeg 처럼 .preview 가 없는 것은 그 도구의
    파일이거나 사용자 파일이라 건드리지 않는다.
    바꾸지 못하면 원래 경로를 그대로 준다.
    """
    ext = os.path.splitext(path)[1].lower()
    if ext not in PREVIEW_EXTS or os.path.normcase(path) != os.path.normcase(stem + ".preview" + ext):
        return path
    target = preview_file(stem, ext)
    try:
        os.replace(path, target)
    except OSError:
        return path
    metadata_path = stem + ".metadata.json"
    metadata = load_metadata(metadata_path)
    configured = metadata.get("preview_url")
    # 이름만 적혀 있을 수도, 절대 경로로 적혀 있을 수도 있다. 적힌 꼴을 지킨다.
    if isinstance(configured, str) and os.path.basename(configured.replace("\\", "/")).lower() \
            == os.path.basename(path).lower():
        metadata["preview_url"] = target if os.path.isabs(configured) else os.path.basename(target)
        try:
            save_metadata(metadata_path, metadata)
        except OSError:
            pass  # 못 고쳐도 숨긴 이름을 후보로 찾으므로 계속 보인다
    return target


def preview_path(kind, stem, configured=None):
    """대표 이미지 파일을 찾는다. 메타데이터가 가리키는 것을 먼저 본다.

    드러난 이름으로 놓인 것을 찾으면 그 자리에서 숨긴 이름으로 바꾼다.
    """
    if isinstance(configured, str) and not os.path.isabs(configured):
        configured = os.path.join(os.path.dirname(stem), configured)
    candidates = ([configured] if isinstance(configured, str) else []) + preview_files(stem)
    for candidate in candidates:
        if not candidate or candidate.startswith(("http://", "https://")):
            continue
        resolved = inside_roots(kind, candidate)
        if resolved and os.path.isfile(resolved):
            # 심볼릭 링크를 따라간 실제 자리 기준으로 이름을 맞춘다
            return _hide(os.path.join(os.path.dirname(resolved), os.path.basename(stem)), resolved)
    return None


def preview_response(path):
    """대표 이미지를 내려보낸다. 꼬리표 때문에 형식을 짐작하지 못하므로 직접 적는다."""
    kind = PREVIEW_TYPES.get(preview_ext(path), "application/octet-stream")
    return web.FileResponse(path, headers={"Content-Type": kind})


# -------------------------------------------------- 곁다리 파일


def load_metadata(metadata_path):
    if not metadata_path or not os.path.isfile(metadata_path):
        return {}
    try:
        with open(metadata_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def save_metadata(metadata_path, data):
    """원자적으로 덮어쓴다. 쓰다 죽어도 기존 파일이 깨지지 않는다."""
    temp = metadata_path + ".tmp"
    with open(temp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(temp, metadata_path)


def write_preview(kind, name, blob, ext):
    """대표 이미지를 <이름>.preview.<확장자>.node 로 저장하고 메타데이터가 가리키게 한다.

    확장자가 바뀔 수 있으므로(png -> mp4) 예전 preview 파일은 지운다.
    돌려주는 값은 (저장한 경로, 오류 메시지) 이고 성공하면 오류가 None 이다.
    """
    full, metadata_path = paths(kind, name)
    if full is None:
        return None, "Model not found"
    stem = os.path.splitext(full)[0]

    for old_ext in PREVIEW_EXTS:
        for old_file in (stem + ".preview" + old_ext, preview_file(stem, old_ext)):
            if os.path.isfile(old_file):
                try:
                    os.remove(old_file)
                except OSError:
                    pass  # 못 지워도 메타데이터가 새 파일을 가리키게 된다

    target = preview_file(stem, ext)
    try:
        with open(target, "wb") as f:
            f.write(blob)
    except OSError as e:
        return None, str(e)

    metadata = load_metadata(metadata_path)
    metadata["preview_url"] = os.path.basename(target)
    try:
        save_metadata(metadata_path, metadata)
    except OSError as e:
        return None, str(e)
    return target, None


# -------------------------------------------------- 카드에 실을 것


def is_adult(metadata):
    level = metadata.get("preview_nsfw_level")
    if isinstance(level, int):
        return level >= ADULT_LEVEL
    civitai = metadata.get("civitai") or {}
    level = civitai.get("nsfwLevel")
    if isinstance(level, int):
        return level >= ADULT_LEVEL
    return (civitai.get("model") or {}).get("nsfw") is True


def trained_words(metadata):
    words = metadata.get("trained_words") or metadata.get("trigger_words")
    if not words:
        words = (metadata.get("civitai") or {}).get("trainedWords") or []
    if isinstance(words, str):
        words = [word.strip() for word in words.split(",")]
    return [word for word in words if isinstance(word, str) and word.strip()]


def info(kind, name):
    """카드 하나에 필요한 것만 추려 담는다."""
    full, metadata_path = paths(kind, name)
    if full is None:
        return None

    stem = os.path.splitext(full)[0]
    metadata = load_metadata(metadata_path)
    civitai = metadata.get("civitai") or {}

    found = preview_path(kind, stem, metadata.get("preview_url"))
    preview = None
    if found:
        # 대표 이미지를 바꾸면 URL 도 바뀌어야 브라우저가 새로 받아온다
        try:
            stamp = int(os.path.getmtime(found))
        except OSError:
            stamp = 0
        preview = f"/fla/model-preview?kind={quote(kind)}&name={quote(name)}&v={stamp}"

    try:
        size = os.path.getsize(full)
    except OSError:
        size = 0

    return {
        "name": name,
        "kind": kind,
        "folder": os.path.dirname(name).replace("\\", "/"),
        "title": metadata.get("model_name") or metadata.get("file_name") or os.path.splitext(os.path.basename(name))[0],
        "file_name": os.path.basename(name),
        "base_model": metadata.get("base_model") or civitai.get("baseModel") or "",
        "version": civitai.get("name") or "",
        "trained_words": trained_words(metadata),
        "tags": metadata.get("tags") or (civitai.get("model") or {}).get("tags") or [],
        "favorite": metadata.get("favorite") is True,
        "adult": is_adult(metadata),
        # Civitai 정보가 아직 없는 카드를 표시하려고 쓴다
        "has_info": bool(civitai),
        "size": metadata.get("size") or size,
        "preview": preview,
        "preview_type": "video" if is_video_preview(found) else "image",
    }


def detail(kind, name):
    """상세 창에 필요한 것만 추려서 준다.

    메타데이터 원본을 통째로 넘기면 수 MB 가 되기도 하므로(예시 이미지가
    수십 장씩 딸려 온다) 화면에 쓰는 항목만 골라 담는다.
    """
    full, metadata_path = paths(kind, name)
    if full is None:
        return None

    stem = os.path.splitext(full)[0]
    metadata = load_metadata(metadata_path)
    civitai = metadata.get("civitai") or {}
    model = civitai.get("model") or {}
    stats = civitai.get("stats") or {}

    found = preview_path(kind, stem, metadata.get("preview_url"))
    preview = None
    preview_type = "image"
    if found:
        try:
            stamp = int(os.path.getmtime(found))
        except OSError:
            stamp = 0
        preview = f"/fla/model-preview?kind={quote(kind)}&name={quote(name)}&v={stamp}"
        if is_video_preview(found):
            preview_type = "video"

    # 예시 이미지. 원격 URL 이라 등급을 함께 넘겨 화면에서 가릴 수 있게 한다.
    images = []
    for image in (civitai.get("images") or []):
        url = image.get("url")
        if not isinstance(url, str) or not url.startswith("http"):
            continue
        meta = image.get("meta") or {}
        images.append({
            "url": url,
            "width": image.get("width"),
            "height": image.get("height"),
            "type": image.get("type") or "image",
            "nsfw_level": image.get("nsfwLevel") if isinstance(image.get("nsfwLevel"), int) else 0,
            "prompt": meta.get("prompt") or "",
            "negative": meta.get("negativePrompt") or "",
            "sampler": meta.get("sampler") or "",
            "steps": meta.get("steps"),
            "cfg": meta.get("cfgScale"),
            "seed": meta.get("seed"),
        })

    try:
        size = os.path.getsize(full)
    except OSError:
        size = 0

    return {
        "name": name,
        "kind": kind,
        "title": metadata.get("model_name") or metadata.get("file_name") or os.path.basename(stem),
        "folder": os.path.dirname(name).replace("\\", "/"),
        "file_name": os.path.basename(full),
        "size": metadata.get("size") or size,
        "sha256": metadata.get("sha256") or "",
        "base_model": metadata.get("base_model") or civitai.get("baseModel") or "",
        "version": civitai.get("name") or "",
        "adult": is_adult(metadata),
        "preview": preview,
        "preview_type": preview_type,
        "notes": metadata.get("notes") or "",
        "description": model.get("description") or civitai.get("description") or "",
        "trained_words": trained_words(metadata),
        "tags": model.get("tags") or metadata.get("tags") or [],
        "creator": (civitai.get("creator") or {}).get("username") or "",
        "downloads": stats.get("downloadCount"),
        "likes": stats.get("thumbsUpCount"),
        "published": civitai.get("publishedAt") or civitai.get("createdAt") or "",
        "model_id": metadata.get("model_id") or civitai.get("modelId"),
        "version_id": metadata.get("version_id") or civitai.get("id"),
        "images": images,
    }


def library(kind):
    items = []
    for name in names(kind):
        item = info(kind, name)
        if item is not None:
            items.append(item)
    return items


def delete(kind, name):
    """모델 파일과 옆에 놓인 것들을 지운다. (지운 목록, 오류) 를 준다.

    곁다리 파일은 이름 규칙이 여럿이다(.preview.png.node, .preview.png, .png, ...).
    메타데이터가 딴 이름을 가리키고 있을 수도 있어 그것도 같이 본다.
    """
    full, metadata_path = paths(kind, name)
    if full is None:
        return None, "Model not found"
    full = inside_roots(kind, full)
    if full is None or not os.path.isfile(full):
        return None, "Model not found"

    stem = os.path.splitext(full)[0]
    targets = [full, metadata_path, *preview_files(stem)]
    configured = preview_path(kind, stem, load_metadata(metadata_path).get("preview_url"))
    if configured:
        targets.append(configured)

    removed = []
    for path in dict.fromkeys(targets):
        if not os.path.isfile(path):
            continue
        try:
            os.remove(path)
        except OSError as e:
            # 모델 파일을 못 지웠으면 실패다. 곁다리는 남아도 그냥 넘어간다.
            if os.path.realpath(path) == os.path.realpath(full):
                return None, str(e)
            continue
        removed.append(os.path.basename(path))

    invalidate(kind)
    return removed, None


def reveal(path):
    """파일이 든 폴더를 파일 탐색기로 연다. 오류 메시지를 주거나 None.

    서버(ComfyUI 가 도는 PC)에서 열리므로 원격 접속 중이면 소용이 없다.
    """
    target = os.path.dirname(path) if os.path.isfile(path) else path
    if not os.path.isdir(target):
        return "folder not found"
    try:
        if sys.platform == "win32":
            if os.path.isfile(path):
                # 폴더를 열면서 해당 파일을 골라둔다
                subprocess.Popen(["explorer", "/select,", os.path.normpath(path)])
            else:
                os.startfile(target)  # noqa: S606
        elif sys.platform == "darwin":
            subprocess.Popen(["open", "-R", path] if os.path.isfile(path) else ["open", target])
        else:
            subprocess.Popen(["xdg-open", target])
    except OSError as e:
        return str(e)
    return None


# -------------------------------------------------- 라우트


def _bad(message, status=400):
    return web.json_response({"ok": False, "error": message}, status=status)


async def _body(request):
    try:
        return await request.json()
    except Exception:
        return None


def _kind_of(source, default=DEFAULT_KIND):
    """요청에서 종류를 읽는다. 없으면 로라로 본다(옛 화면과 맞추려고)."""
    kind = (source.get("kind") or default) if isinstance(source, dict) else default
    return kind if known(kind) else None


@routes.get("/fla/model-kinds")
async def get_model_kinds(request):
    """화면이 종류 고르는 칸을 만들 때 쓴다. 폴더가 등록된 것만 준다."""
    return web.json_response({
        "ok": True,
        "kinds": [{"kind": k, "label": KINDS[k]["label"], "civitai": KINDS[k]["civitai"],
                   "main": k in MAIN_KINDS} for k in available()],
    })


@routes.get("/fla/model-library")
async def get_model_library(request):
    kind = _kind_of(dict(request.query))
    if kind is None:
        return _bad("Unknown model kind", 404)
    if request.query.get("refresh"):
        # 폴더에 파일을 새로 넣었을 수 있다. ComfyUI 를 다시 켜지 않아도 되게 한다.
        invalidate(kind)
    return web.json_response({"ok": True, "kind": kind, "label": label_of(kind), "items": library(kind)})


@routes.get("/fla/model-preview")
async def get_model_preview(request):
    kind = _kind_of(dict(request.query))
    if kind is None:
        raise web.HTTPNotFound()
    full, metadata_path = paths(kind, request.query.get("name", ""))
    if full is None:
        raise web.HTTPNotFound()
    stem = os.path.splitext(full)[0]
    found = preview_path(kind, stem, load_metadata(metadata_path).get("preview_url"))
    if not found:
        raise web.HTTPNotFound()
    return preview_response(found)


@routes.get("/fla/model-detail")
async def get_model_detail(request):
    kind = _kind_of(dict(request.query))
    if kind is None:
        return _bad("Unknown model kind", 404)
    found = detail(kind, request.query.get("name", ""))
    if found is None:
        return _bad("Model not found", 404)
    return web.json_response({"ok": True, **found})


@routes.post("/fla/model-preview-set")
async def post_model_preview_set(request):
    """예시 이미지 하나를 대표 이미지로 삼는다.

    화면이 주소만 넘기면 서버가 내려받는다. 브라우저에서 받아 올리면
    Civitai 의 교차 출처 정책에 걸릴 수 있어서 서버에서 처리한다.
    """
    body = await _body(request)
    if body is None:
        return _bad("Bad request")
    kind = _kind_of(body)
    if kind is None:
        return _bad("Unknown model kind", 404)
    name = body.get("name", "")
    if paths(kind, name)[0] is None:
        return _bad("Model not found", 404)
    url = body.get("url", "")
    if not isinstance(url, str) or not url.startswith(("http://", "https://")):
        return _bad("Bad url")

    ext = os.path.splitext(urlparse(url).path)[1].lower()
    if ext not in PREVIEW_EXTS:
        ext = ".png"

    try:
        session = getattr(PromptServer.instance, "client_session", None)
        if session is not None:
            async with session.get(url) as res:
                if res.status != 200:
                    return _bad(f"HTTP {res.status}", 502)
                blob = await res.read()
        else:
            import aiohttp
            async with aiohttp.ClientSession() as own:
                async with own.get(url) as res:
                    if res.status != 200:
                        return _bad(f"HTTP {res.status}", 502)
                    blob = await res.read()
    except Exception as e:
        return _bad(str(e), 502)

    if len(blob) > MAX_PREVIEW_BYTES:
        return _bad("Too large", 413)

    _target, error = write_preview(kind, name, blob, ext)
    if error:
        return _bad(error, 500)
    return web.json_response({"ok": True, "stamp": int(time.time())})


@routes.post("/fla/model-favorite")
async def post_model_favorite(request):
    body = await _body(request)
    if body is None:
        return _bad("Bad request")
    kind = _kind_of(body)
    if kind is None:
        return _bad("Unknown model kind", 404)
    full, metadata_path = paths(kind, body.get("name", ""))
    if full is None:
        return _bad("Model not found", 404)

    metadata = load_metadata(metadata_path)
    metadata["favorite"] = body.get("favorite") is True
    try:
        save_metadata(metadata_path, metadata)
    except OSError as e:
        return _bad(str(e), 500)
    return web.json_response({"ok": True, "favorite": metadata["favorite"]})


@routes.post("/fla/model-preview-upload")
async def post_model_preview_upload(request):
    """사용자가 고른 파일을 대표 이미지로 저장한다."""
    try:
        reader = await request.multipart()
    except Exception:
        return _bad("Bad request")

    kind_raw = DEFAULT_KIND
    name = ""
    blob = None
    ext = ".png"
    while True:
        part = await reader.next()
        if part is None:
            break
        if part.name == "kind":
            kind_raw = (await part.text()).strip()
        elif part.name == "name":
            name = (await part.text()).strip()
        elif part.name == "file":
            candidate = os.path.splitext(part.filename or "")[1].lower()
            if candidate in PREVIEW_EXTS:
                ext = candidate
            blob = await part.read(decode=False)

    if not known(kind_raw):
        return _bad("Unknown model kind", 404)
    if not blob:
        return _bad("No file")
    if len(blob) > MAX_PREVIEW_BYTES:
        return _bad("Too large", 413)

    target, error = write_preview(kind_raw, name, blob, ext)
    if error:
        return _bad(error, 404 if error == "Model not found" else 500)
    return web.json_response({"ok": True})


@routes.post("/fla/model-delete")
async def post_model_delete(request):
    """되돌릴 수 없으므로 화면에서 한 번 더 물어본 뒤 부른다."""
    body = await _body(request)
    if body is None:
        return _bad("Bad request")
    kind = _kind_of(body)
    if kind is None:
        return _bad("Unknown model kind", 404)
    name = body.get("name", "")
    removed, error = delete(kind, name)
    if error:
        return _bad(error, 404 if error == "Model not found" else 500)

    # Civitai 쪽이 들고 있는 '이미 가진 것' 목록도 새로 읽게 한다
    try:
        from . import civitai
        civitai.invalidate_installed()
        civitai.invalidate_pending()
    except Exception:
        pass  # Civitai 쪽이 없어도 삭제 자체는 끝났다

    return web.json_response({"ok": True, "name": name, "removed": removed})


@routes.post("/fla/model-reveal")
async def post_model_reveal(request):
    body = await _body(request)
    if body is None:
        return _bad("Bad request")
    kind = _kind_of(body)
    if kind is None:
        return _bad("Unknown model kind", 404)
    full, _ = paths(kind, body.get("name", ""))
    if full is None:
        return _bad("Model not found", 404)
    error = reveal(full)
    if error:
        return _bad(error, 404 if error == "folder not found" else 500)
    return web.json_response({"ok": True, "path": os.path.dirname(full)})
