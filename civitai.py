"""Civitai 연동 — 로라 파일 해시로 모델 정보를 받아 metadata.json 을 만든다.

로라 라이브러리와 상세 창은 <로라이름>.metadata.json 의 civitai 블록을 읽는다.
지금까지는 그 파일을 다른 도구가 만들어줘야 했다. 여기서 직접 만든다.

파일 이름은 사람이 마음대로 바꾸므로 이름 대신 SHA256 해시로 모델을 찾는다.
해시는 한 번 구하면 metadata.json 에 남겨 두 번 계산하지 않는다.
"""

import asyncio
import hashlib
import json
import os
import re
import time
from urllib.parse import urlencode, urlparse

from aiohttp import web
from server import PromptServer

import folder_paths

from . import models
from .api import _read_settings, _write_settings

# 곁다리 파일 규칙은 종류마다 같다. models 가 종류별로 들고 있다.
PREVIEW_EXTS = models.PREVIEW_EXTS
MAX_PREVIEW_BYTES = models.MAX_PREVIEW_BYTES
_load_metadata = models.load_metadata
_save_metadata = models.save_metadata

routes = PromptServer.instance.routes

API_BASE = "https://civitai.com/api/v1"
# 한 번에 읽는 크기. 수백 MB 짜리 로라를 통째로 메모리에 올리지 않는다.
HASH_CHUNK = 4 * 1024 * 1024
# 연속 요청 사이 간격(초). 429(요청 과다)를 받지 않을 만큼만 띄운다.
REQUEST_GAP = 0.4
TIMEOUT = 30
# 진행 창에 남겨 보여줄 실패 기록 개수
MAX_ERRORS = 20


# Civitai 가 붙이는 종류 이름을 우리 종류로 옮긴다.
# 파생형(LoCon·DoRA)도 로라 폴더에 들어가므로 같이 묶는다.
TYPE_TO_KIND = {
    "LORA": "loras", "LoCon": "loras", "DoRA": "loras",
    "Checkpoint": "checkpoints",
    "VAE": "vae",
    "Controlnet": "controlnet",
    "Upscaler": "upscale_models",
    "TextualInversion": "embeddings",
    "Workflows": "workflows",
    "Wildcards": "wildcards",
}

# 모델 폴더가 아닌 것들. 압축을 풀어 제 폴더에 넣는다.
ARCHIVE_KINDS = ("workflows", "wildcards")


def kind_for_type(civitai_type):
    """Civitai 종류 이름 -> 우리 종류. 우리가 다루지 않는 것이면 빈 문자열."""
    return TYPE_TO_KIND.get(str(civitai_type or ""), "")


def kind_ok(kind):
    return models.known(kind) or kind in ARCHIVE_KINDS


class CivitaiError(Exception):
    """호출 실패. 메시지를 그대로 화면에 보여준다."""


class NotFound(CivitaiError):
    """해시가 Civitai 에 없다. 다시 시도해도 결과가 같다."""


# ---------------------------------------------------------------- 해시


def sha256_of(path):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(HASH_CHUNK), b""):
            digest.update(chunk)
    return digest.hexdigest()


async def sha256_async(path):
    """해시는 파일 전체를 읽는다. 루프에서 그냥 돌리면 ComfyUI 가 멈춘다."""
    return await asyncio.get_running_loop().run_in_executor(None, sha256_of, path)


# ---------------------------------------------------------------- HTTP


def _session_cookie():
    """브라우저 세션 쿠키. 없으면 None.

    로그인해야 받을 수 있는 글에만 쓴다. 평소 받기에는 필요 없다.
    """
    value = _read_settings().get("civitai_session")
    value = value.strip() if isinstance(value, str) else ""
    return value or None


def _api_key():
    key = _read_settings().get("civitai_api_key")
    return key.strip() if isinstance(key, str) and key.strip() else None


def _headers(api_key):
    headers = {"User-Agent": "comfy_FLA"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    return headers


async def _with_session(work):
    """ComfyUI 가 쓰던 세션을 빌려 쓰고, 없으면 잠깐 하나 연다."""
    session = getattr(PromptServer.instance, "client_session", None)
    if session is not None:
        return await work(session)
    import aiohttp
    async with aiohttp.ClientSession() as own:
        return await work(own)


async def _get_json(path, api_key, retries=2):
    import aiohttp

    url = f"{API_BASE}{path}"
    timeout = aiohttp.ClientTimeout(total=TIMEOUT)

    async def work(session):
        for attempt in range(retries + 1):
            try:
                async with session.get(url, headers=_headers(api_key), timeout=timeout) as res:
                    if res.status == 404:
                        raise NotFound("Civitai 에 없는 모델")
                    if res.status in (401, 403):
                        raise CivitaiError(f"권한 없음({res.status}) — API 키가 필요할 수 있음")
                    if res.status == 429:
                        # 잠깐 쉬었다 다시. 그래도 막히면 사용자에게 알린다.
                        if attempt < retries:
                            await asyncio.sleep(2 * (attempt + 1))
                            continue
                        raise CivitaiError("요청이 너무 잦음(429) — 잠시 뒤 다시")
                    if res.status != 200:
                        raise CivitaiError(f"HTTP {res.status}")
                    return await res.json()
            except (asyncio.TimeoutError, aiohttp.ClientError) as e:
                if attempt < retries:
                    await asyncio.sleep(1)
                    continue
                raise CivitaiError(str(e) or "연결 실패") from e
        raise CivitaiError("연결 실패")

    return await _with_session(work)


async def _download_image(url):
    """예시 이미지를 서버가 받아온다. 브라우저에서 받으면 교차 출처에 걸린다."""
    import aiohttp

    timeout = aiohttp.ClientTimeout(total=TIMEOUT)

    async def work(session):
        async with session.get(url, timeout=timeout) as res:
            if res.status != 200:
                raise CivitaiError(f"이미지 HTTP {res.status}")
            return await res.read()

    blob = await _with_session(work)
    if len(blob) > MAX_PREVIEW_BYTES:
        raise CivitaiError("이미지가 너무 큼")
    ext = os.path.splitext(urlparse(url).path)[1].lower()
    return blob, (ext if ext in PREVIEW_EXTS else ".png")


# ---------------------------------------------------------------- 메타데이터


def has_info(metadata):
    return bool(metadata.get("civitai"))


def pick_preview(version, still_only=False):
    """대표로 쓸 예시 하나를 고른다. Civitai 가 먼저 주는 것이 표지 이미지다.

    still_only 를 켜면 영상은 건너뛰고 정지 그림만 고른다. 워크플로우
    대표 그림이 그렇다 — 카드가 노드 그림과 번갈아 보여주는 자리라
    움직이는 것이 끼면 어지럽고, 저장 형식도 그림만 받는다.
    """
    fallback = None
    for image in version.get("images") or []:
        url = image.get("url")
        if not (isinstance(url, str) and url.startswith(("http://", "https://"))):
            continue
        if (image.get("type") or "image") == "video":
            fallback = fallback or image
            continue
        return image
    return None if still_only else fallback


def build_metadata(existing, version, model, full_path, sha256):
    """사용자가 손댄 값(즐겨찾기·메모·대표 이미지)은 그대로 두고 Civitai 정보만 덮는다."""
    data = dict(existing or {})

    civitai = dict(version)
    if isinstance(model, dict):
        # 설명·태그·제작자는 버전이 아니라 모델 쪽에만 있다
        merged = dict(civitai.get("model") or {})
        for key in ("name", "type", "nsfw", "poi", "description", "tags", "allowCommercialUse"):
            if model.get(key) is not None:
                merged[key] = model[key]
        civitai["model"] = merged
        if model.get("creator"):
            civitai["creator"] = model["creator"]
    data["civitai"] = civitai

    block = civitai.get("model") or {}
    data["model_name"] = block.get("name") or data.get("model_name") or ""
    data["file_name"] = os.path.basename(full_path)
    data["base_model"] = version.get("baseModel") or data.get("base_model") or ""
    data["model_type"] = block.get("type") or data.get("model_type") or ""
    data["sha256"] = sha256
    data["size"] = os.path.getsize(full_path)
    if version.get("trainedWords"):
        data["trained_words"] = version["trainedWords"]
    if block.get("tags"):
        data["tags"] = block["tags"]
    data["model_id"] = version.get("modelId")
    data["version_id"] = version.get("id")
    data["civitai_fetched_at"] = int(time.time())
    # 예전에 "없음" 으로 찍혔더라도 이번에 찾았으니 지운다
    data.pop("civitai_missing", None)
    return data


def _mark_missing(metadata_path, metadata, sha256):
    """Civitai 에 없는 파일. 다음 일괄 검사에서 건너뛰도록 표시만 남긴다."""
    data = dict(metadata or {})
    data["sha256"] = sha256
    data["civitai_missing"] = True
    data["civitai_checked_at"] = int(time.time())
    try:
        _save_metadata(metadata_path, data)
    except OSError:
        pass


# ---------------------------------------------------------------- 한 개 가져오기


async def fetch_version_by_hash(sha256, api_key):
    return await _get_json(f"/model-versions/by-hash/{sha256}", api_key)


async def fetch_model(model_id, api_key):
    return await _get_json(f"/models/{model_id}", api_key)


async def enrich(name, api_key, overwrite=False, set_preview=True, replace_preview=False,
                 kind=models.DEFAULT_KIND):
    """로라 하나를 Civitai 정보로 채운다.

    overwrite 가 거짓이면 이미 정보가 있는 파일은 건드리지 않는다.
    대표 이미지는 아직 없을 때만 받아온다. 사용자가 직접 고른 그림을
    말없이 바꾸지 않으려고, 정보를 새로 받을 때도 그림은 그대로 둔다
    (replace_preview 를 켜야 바꾼다).
    """
    full, metadata_path = models.paths(kind, name)
    if full is None or not os.path.isfile(full):
        raise CivitaiError("파일을 찾을 수 없음")

    metadata = _load_metadata(metadata_path)
    if has_info(metadata) and not overwrite:
        return {"updated": False, "skipped": True, "title": metadata.get("model_name") or ""}

    sha = metadata.get("sha256")
    if not isinstance(sha, str) or len(sha) != 64:
        sha = await sha256_async(full)

    try:
        version = await fetch_version_by_hash(sha, api_key)
    except NotFound:
        _mark_missing(metadata_path, metadata, sha)
        raise

    model = None
    if version.get("modelId"):
        try:
            model = await fetch_model(version["modelId"], api_key)
        except CivitaiError:
            # 버전 정보만으로도 이름·트리거·예시는 채워진다. 설명·태그만 빠진다.
            model = None

    data = build_metadata(metadata, version, model, full, sha)

    stem = os.path.splitext(full)[0]
    already = models.preview_path(kind, stem, metadata.get("preview_url")) is not None
    blob = None
    ext = None
    image = None
    if set_preview and (replace_preview or not already):
        image = pick_preview(version)
        if image:
            try:
                blob, ext = await _download_image(image["url"])
            except CivitaiError:
                blob = None  # 정보는 살리고 그림만 포기한다

    if blob is not None:
        level = image.get("nsfwLevel")
        data["preview_nsfw_level"] = level if isinstance(level, int) else 0

    try:
        _save_metadata(metadata_path, data)
    except OSError as e:
        raise CivitaiError(str(e)) from e

    stamp = None
    if blob is not None:
        # _write_preview 가 파일에서 메타데이터를 다시 읽으므로 저장한 뒤에 부른다
        _, error = models.write_preview(kind, name, blob, ext)
        if not error:
            stamp = int(time.time())

    return {
        "updated": True,
        "skipped": False,
        "title": data.get("model_name") or "",
        "stamp": stamp,
        "model_id": data.get("model_id"),
    }


# ---------------------------------------------------------------- 일괄 검사


_progress = {
    "running": False,
    "total": 0,
    "done": 0,
    "updated": 0,
    "missing": 0,
    "failed": 0,
    "current": "",
    "cancelled": False,
    "errors": [],
    "finished_at": 0,
    "kind": models.DEFAULT_KIND,
}
_task = None


def _reset_progress(total):
    _progress.update({
        "running": True,
        "total": total,
        "done": 0,
        "updated": 0,
        "missing": 0,
        "failed": 0,
        "current": "",
        "cancelled": False,
        "errors": [],
        "finished_at": 0,
    })


# 남은 개수는 진행 창이 0.7 초마다 물어본다. 매번 로라 전부의 metadata.json 을
# 읽으면(로라가 많을수록 오래 걸린다) 서버가 그만큼 멈춘다. 잠깐은 같은 값을 준다.
PENDING_TTL = 5.0
_pending = {}


def invalidate_pending():
    _pending.clear()


# 옛 이름. 다른 모듈이 아직 부른다.
_invalidate_pending = invalidate_pending


def pending_count(kind=models.DEFAULT_KIND):
    if not models.known(kind):
        return 0
    now = time.monotonic()
    slot = _pending.get(kind)
    if slot is None or now - slot[1] > PENDING_TTL:
        slot = (len(_targets(False, kind)), now)
        _pending[kind] = slot
    return slot[0]


def _targets(overwrite, kind=models.DEFAULT_KIND):
    """검사할 파일 목록. 기본은 아직 정보가 없는 것만 고른다."""
    names = []
    for name in models.names(kind):
        _, metadata_path = models.paths(kind, name)
        if metadata_path is None:
            continue
        metadata = _load_metadata(metadata_path)
        if overwrite:
            names.append(name)
            continue
        # 이미 채웠거나, 이전에 찾아봤는데 Civitai 에 없던 것은 건너뛴다
        if has_info(metadata) or metadata.get("civitai_missing") is True:
            continue
        names.append(name)
    return names


async def _scan(names, api_key, overwrite, set_preview, replace_preview, kind=models.DEFAULT_KIND):
    try:
        for name in names:
            if _progress["cancelled"]:
                break
            _progress["current"] = name
            try:
                result = await enrich(name, api_key, overwrite, set_preview, replace_preview, kind)
                if result["updated"]:
                    _progress["updated"] += 1
            except NotFound:
                _progress["missing"] += 1
            except CivitaiError as e:
                _progress["failed"] += 1
                if len(_progress["errors"]) < MAX_ERRORS:
                    _progress["errors"].append({"name": name, "error": str(e)})
            except Exception as e:  # 예상 못 한 오류 하나로 전체가 멈추지 않게
                _progress["failed"] += 1
                if len(_progress["errors"]) < MAX_ERRORS:
                    _progress["errors"].append({"name": name, "error": repr(e)})
            _progress["done"] += 1
            await asyncio.sleep(REQUEST_GAP)
    finally:
        _progress["running"] = False
        _progress["current"] = ""
        _progress["finished_at"] = int(time.time())
        _invalidate_pending()


# ---------------------------------------------------------------- 라우트


@routes.get("/fla/civitai/status")
async def get_civitai_status(request):
    kind = request.query.get("kind") or models.DEFAULT_KIND
    # 워크플로우도 이 창의 종류 단추에 들어온다. 해시로 정보를 채울 수 없는
    # 종류라 '아직 정보 없는 개수' 는 언제나 0 이다.
    if not kind_ok(kind):
        return web.json_response({"ok": False, "error": "Unknown kind"}, status=404)
    return web.json_response({
        "ok": True,
        "kind": kind,
        "has_key": _api_key() is not None,
        "has_session": _session_cookie() is not None,
        "pending": pending_count(kind),
        # 종류별 남은 개수를 한 번에 준다. 창 위쪽 종류 단추에 숫자를 찍는다.
        "pending_by_kind": {k: pending_count(k) for k in models.MAIN_KINDS},
        "progress": dict(_progress),
    })


@routes.post("/fla/civitai/key")
async def post_civitai_key(request):
    """API 키는 user_settings.json 에만 둔다(깃에 올라가지 않는 파일)."""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "Bad request"}, status=400)
    key = body.get("key")
    if not isinstance(key, str):
        return web.json_response({"ok": False, "error": "Bad request"}, status=400)
    settings = _read_settings()
    key = key.strip()
    if key:
        settings["civitai_api_key"] = key
    else:
        settings.pop("civitai_api_key", None)
    try:
        _write_settings(settings)
    except OSError as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)
    return web.json_response({"ok": True, "has_key": bool(key)})


@routes.post("/fla/civitai/session")
async def post_civitai_session(request):
    """브라우저 세션 쿠키를 저장한다(비우면 지운다).

    API 키와 같은 파일에 둔다 — 깃에 올라가지 않는 user_settings.json.
    이 값은 계정 로그인과 같은 힘을 가지므로 화면에도 되돌려 주지 않는다.
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "Bad request"}, status=400)
    value = body.get("session")
    if not isinstance(value, str):
        return web.json_response({"ok": False, "error": "Bad request"}, status=400)

    settings = _read_settings()
    value = value.strip()
    if value:
        # 사람들이 "Cookie: a=b" 통째로 붙여넣는다. 앞머리는 떼어낸다.
        if value.lower().startswith("cookie:"):
            value = value[len("cookie:"):].strip()
        settings["civitai_session"] = value
    else:
        settings.pop("civitai_session", None)
    try:
        _write_settings(settings)
    except OSError as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)
    return web.json_response({"ok": True, "has_session": bool(value)})


@routes.post("/fla/civitai/fetch")
async def post_civitai_fetch(request):
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "Bad request"}, status=400)

    kind = body.get("kind") or models.DEFAULT_KIND
    if not models.known(kind):
        return web.json_response({"ok": False, "error": "Unknown kind"}, status=404)
    name = body.get("name", "")
    if models.paths(kind, name)[0] is None:
        return web.json_response({"ok": False, "error": "Model not found"}, status=404)

    try:
        # 버튼으로 직접 부른 것이니 이미 정보가 있어도 새로 받는다
        result = await enrich(
            name,
            _api_key(),
            overwrite=body.get("overwrite") is not False,
            set_preview=body.get("set_preview") is not False,
            replace_preview=body.get("replace_preview") is True,
            kind=kind,
        )
    except NotFound as e:
        return web.json_response({"ok": False, "missing": True, "error": str(e)}, status=404)
    except CivitaiError as e:
        return web.json_response({"ok": False, "error": str(e)}, status=502)

    _invalidate_pending()
    return web.json_response({"ok": True, **result})


@routes.post("/fla/civitai/scan")
async def post_civitai_scan(request):
    global _task
    if _progress["running"]:
        return web.json_response(
            {"ok": False, "error": "이미 검사 중", "progress": dict(_progress)}, status=409)

    try:
        body = await request.json()
    except Exception:
        body = {}
    kind = body.get("kind") or models.DEFAULT_KIND
    if not models.known(kind):
        return web.json_response({"ok": False, "error": "Unknown kind"}, status=404)
    overwrite = body.get("overwrite") is True
    set_preview = body.get("set_preview") is not False
    replace_preview = body.get("replace_preview") is True

    names = _targets(overwrite, kind)
    _reset_progress(len(names))
    _progress["kind"] = kind
    if not names:
        _progress["running"] = False
        _progress["finished_at"] = int(time.time())
        return web.json_response({"ok": True, "progress": dict(_progress)})

    _task = asyncio.create_task(
        _scan(names, _api_key(), overwrite, set_preview, replace_preview, kind))
    return web.json_response({"ok": True, "progress": dict(_progress)})


@routes.post("/fla/civitai/cancel")
async def post_civitai_cancel(request):
    # 지금 처리 중인 파일까지는 마치고 멈춘다(반쯤 쓴 파일을 남기지 않는다)
    _progress["cancelled"] = True
    return web.json_response({"ok": True, "progress": dict(_progress)})


# ---------------------------------------------------------------- 검색
#
# Civitai 목록을 그대로 넘기면 한 페이지가 수 MB 다(버전마다 예시 이미지가 수십 장).
# 카드에 그릴 것만 추려서 넘긴다.

SEARCH_LIMIT = 24
# 카드 하나에 보여줄 예시 이미지 수
SEARCH_IMAGES = 6
# 상세 창 이미지 넘김판에 담을 수
DETAIL_IMAGES = 20
# 이미 가진 로라 목록을 다시 훑는 간격(초)
INSTALLED_TTL = 10.0

# 종류별로 따로 담는다. 로라 목록과 체크포인트 목록이 서로를 덮으면
# 검색 결과의 '있음' 표시가 엉킨다.
_installed = {}


def _installed_index(kind=models.DEFAULT_KIND):
    """이미 가진 파일의 해시와 이름. 검색 결과에 '있음' 을 찍는 데 쓴다.

    해시가 없는 파일도 있으므로(아직 한 번도 안 채운 것) 이름도 같이 본다.
    어느 파일이었는지도 같이 담아둔다(버전 목록에서 지울 때 쓴다).
    """
    if not models.known(kind):
        return set(), set()
    now = time.monotonic()
    slot = _installed.get(kind)
    if slot is None or now - slot["at"] > INSTALLED_TTL:
        by_hash = {}
        by_name = {}
        for name in models.names(kind):
            by_name.setdefault(os.path.basename(name).lower(), name)
            _, metadata_path = models.paths(kind, name)
            sha = models.load_metadata(metadata_path).get("sha256")
            if isinstance(sha, str) and len(sha) == 64:
                by_hash.setdefault(sha.lower(), name)
        slot = {"hashes": set(by_hash), "names": set(by_name),
                "by_hash": by_hash, "by_name": by_name, "at": now}
        _installed[kind] = slot
    return slot["hashes"], slot["names"]


def installed_name(sha, file_name, kind=models.DEFAULT_KIND):
    """이미 가진 파일이면 목록에서 쓰는 이름(폴더 포함). 없으면 빈 문자열."""
    _installed_index(kind)
    slot = _installed.get(kind)
    if slot is None:
        return ""
    if sha:
        found = slot["by_hash"].get(sha.lower())
        if found:
            return found
    if file_name:
        return slot["by_name"].get(file_name.lower(), "")
    return ""


def invalidate_installed():
    _installed.clear()


# 옛 이름. 다른 모듈이 아직 부른다.
_invalidate_installed = invalidate_installed


def _trim_image(image):
    return {
        "url": image.get("url"),
        "width": image.get("width"),
        "height": image.get("height"),
        "type": image.get("type") or "image",
        "nsfw_level": image.get("nsfwLevel") if isinstance(image.get("nsfwLevel"), int) else 0,
    }


def _primary_file(version):
    """내려받을 파일. 로라는 보통 Model 하나뿐이지만 VAE 가 딸려 오기도 한다."""
    files = [f for f in (version.get("files") or []) if f.get("type") == "Model"]
    if not files:
        return None
    return next((f for f in files if f.get("primary")), files[0])


def _review_label(up, down):
    """Civitai 가 별점 대신 쓰는 말. 엄지 비율로 정한다."""
    total = (up or 0) + (down or 0)
    if not total:
        return "", 0
    ratio = (up or 0) / total
    if ratio >= 0.9:
        name = "veryPositive"
    elif ratio >= 0.75:
        name = "positive"
    elif ratio >= 0.4:
        name = "mixed"
    else:
        name = "negative"
    return name, total


def _trim_version(version, hashes, names, model=None, folders=None, max_images=SEARCH_IMAGES,
                  kind=models.DEFAULT_KIND):
    primary = _primary_file(version) or {}
    sha = ((primary.get("hashes") or {}).get("SHA256") or "").lower()
    file_name = primary.get("name") or ""
    stats = version.get("stats") or {}
    review, reviews = _review_label(stats.get("thumbsUpCount"), stats.get("thumbsDownCount"))
    model_id = version.get("modelId") or (model or {}).get("id")
    folder_pick = (suggest_folder_full(model or {}, version, folders, kind)
                   if folders is not None else ("", False))
    return {
        "id": version.get("id"),
        "name": version.get("name") or "",
        "base_model": version.get("baseModel") or "",
        "published": version.get("publishedAt") or version.get("createdAt") or "",
        "size_kb": primary.get("sizeKB"),
        "file_name": file_name,
        "sha256": sha,
        "downloadable": bool(primary),
        "installed": bool((sha and sha in hashes) or (file_name and file_name.lower() in names)),
        # 이미 가진 파일이면 그 이름. 버전 목록에서 지울 때 이 이름으로 부른다.
        "installed_name": installed_name(sha, file_name, kind),
        "trained_words": version.get("trainedWords") or [],
        # 어느 폴더에 둘지 미리 골라둔다(화면에서 바꿀 수 있다)
        "folder": folder_pick[0],
        # 없는 폴더를 제안했으면 화면이 '새로 만듭니다' 라고 알려준다
        "folder_is_new": folder_pick[1],
        "downloads": stats.get("downloadCount"),
        "review": review,
        "reviews": reviews,
        # Civitai 가 모델을 가리키는 이름표. 화면에서 복사할 수 있게 넘긴다.
        "air": f"civitai:{model_id}@{version.get('id')}" if model_id else "",
        # 공개 API 는 아직 이 값을 안 주는 일이 많다. 있을 때만 표에 넣는다.
        "clip_skip": version.get("clipSkip"),
        "images": [_trim_image(i) for i in (version.get("images") or [])[:max_images]
                   if isinstance(i.get("url"), str)],
    }


def _trim_model(model, hashes=None, names=None, folders=None, full=False, cache=None):
    """카드 하나로 줄인다.

    "전체" 로 훑으면 결과에 로라와 체크포인트가 섞여 온다. 그래서 넘겨받은
    목록을 그대로 쓰지 않고 모델마다 제 종류의 목록을 본다. cache 는
    한 번의 요청 안에서 종류별 조회를 한 번씩만 하려고 쓴다.
    """
    kind = kind_for_type(model.get("type"))
    if cache is None:
        cache = {}
    if kind not in cache:
        if models.known(kind):
            folders = library_folders(kind)
        elif kind in ARCHIVE_KINDS:
            # 워크플로우·와일드카드는 모델 폴더가 아니지만 하위 폴더는 있다
            folders = _archive_folders(kind)
        else:
            folders = []
        cache[kind] = {
            "index": _installed_index(kind) if models.known(kind) else (set(), set()),
            "folders": folders,
        }
    hashes, names = cache[kind]["index"]
    folders = cache[kind]["folders"]

    stats = model.get("stats") or {}
    versions = [_trim_version(v, hashes, names, model, folders,
                              DETAIL_IMAGES if full else SEARCH_IMAGES, kind)
                for v in (model.get("modelVersions") or [])]
    return {
        "id": model.get("id"),
        "name": model.get("name") or "",
        "type": model.get("type") or "",
        # 우리가 받아둘 자리를 아는 종류인지. 빈 값이면 화면이 받기 버튼을 끈다.
        "kind": kind,
        "nsfw": model.get("nsfw") is True,
        "nsfw_level": model.get("nsfwLevel") if isinstance(model.get("nsfwLevel"), int) else 0,
        "tags": model.get("tags") or [],
        "creator": (model.get("creator") or {}).get("username") or "",
        "downloads": stats.get("downloadCount"),
        "likes": stats.get("thumbsUpCount"),
        # 설명은 길다(수 KB). 목록에는 싣지 않고 상세를 열 때만 준다.
        "description": (model.get("description") or "") if full else "",
        "versions": versions,
        # 어느 버전이든 하나라도 있으면 카드에 표시한다
        "installed": any(v["installed"] for v in versions),
    }


@routes.get("/fla/civitai/search")
async def get_civitai_search(request):
    """Civitai 모델 목록을 대신 불러온다.

    브라우저에서 직접 부르면 교차 출처에 걸리고 API 키도 노출된다.
    """
    query = request.query
    params = {"limit": SEARCH_LIMIT}
    # "전체" 를 고르면 types 를 아예 붙이지 않는다(Civitai 가 모든 종류를 준다)
    types = (query.get("types") or "").strip()
    if types and types.lower() != "all":
        params["types"] = types
    for key, name in (("query", "query"), ("tag", "tag"), ("username", "username"),
                      ("sort", "sort"), ("period", "period"), ("baseModels", "baseModels")):
        value = query.get(name, "").strip()
        if value:
            params[key] = value
    if query.get("nsfw") in ("true", "false"):
        params["nsfw"] = query["nsfw"]
    cursor = query.get("cursor", "").strip()
    if cursor:
        params["cursor"] = cursor

    try:
        data = await _get_json(f"/models?{urlencode(params)}", _api_key())
    except CivitaiError as e:
        return web.json_response({"ok": False, "error": str(e)}, status=502)

    # 종류별 조회는 한 번씩만 하고 모든 결과에 돌려 쓴다
    cache = {}
    items = [_trim_model(m, cache=cache) for m in (data.get("items") or [])]
    return web.json_response({
        "ok": True,
        "items": items,
        "next_cursor": (data.get("metadata") or {}).get("nextCursor") or "",
    })


@routes.get("/fla/civitai/model")
async def get_civitai_model(request):
    """모델 하나를 자세히. 카드를 고르면 부른다.

    설명과 예시 이미지는 목록에 싣기에 너무 크다. 열어본 것만 받아온다.
    """
    try:
        model_id = int(request.query.get("id", ""))
    except (TypeError, ValueError):
        return web.json_response({"ok": False, "error": "Bad id"}, status=400)

    try:
        model = await fetch_model(model_id, _api_key())
    except NotFound as e:
        return web.json_response({"ok": False, "error": str(e)}, status=404)
    except CivitaiError as e:
        return web.json_response({"ok": False, "error": str(e)}, status=502)

    return web.json_response({
        "ok": True,
        "model": _trim_model(model, full=True),
    })


# ---------------------------------------------------------------- 저장 폴더
#
# 받은 파일을 아무 데나 던져두면 나중에 찾지 못한다. 태그와 기반 모델을 보고
# 이미 쓰고 있는 폴더 중 하나를 골라 제안한다. 없는 폴더는 제안하지 않는다.

# 성인 등급으로 보는 nsfwLevel 하한(api.py 의 ADULT_LEVEL 과 같다)
ADULT_NSFW = 4

# 앞에 있는 규칙이 이긴다. 영상 모델은 기반 모델이 다르면 아예 못 쓰므로 먼저 본다.
FOLDER_RULES = [
    ("base", ("wan",), ("Wan2.2", "Wan2.1", "Wan", "Video")),
    ("base", ("ltx",), ("LTX-Video", "LTXV", "LTX", "Video")),
    ("base", ("hunyuan",), ("Hunyuan", "Video")),
    ("tag", ("character", "characters", "celebrity", "actress", "idol", "person"),
     ("Characters", "Character", "Char")),
    ("tag", ("poses", "pose"), ("Poses", "Pose")),
    ("tag", ("expression", "expressions", "emotion", "facial expression"),
     ("Expressions", "Expression", "Exp")),
    ("tag", ("background", "backgrounds", "scenery", "landscape", "location", "environment"),
     ("Locations", "Location", "Background", "Backgrounds")),
    ("tag", ("clothing", "clothes", "outfit", "dress", "costume", "uniform"),
     ("Clothing", "Clothes", "Outfit", "Dress")),
    ("nsfw", (), ("Adult", "NSFW", "18")),
    ("tag", ("style", "artstyle", "art style", "anime", "artist"), ("Anime", "Styles", "Style")),
    ("tag", ("concept", "tool", "helper"), ("Recipes", "Concepts", "Tools")),
]


# 기반 모델로 나누는 규칙. 앞에 있는 것이 이긴다.
# 영상 계열을 먼저 본다 — 기반이 다르면 아예 못 쓰므로 가장 중요한 갈래다.
# 후보는 사람들이 실제로 쓰는 폴더 이름들이다(한글 폴더도 함께 본다).
BASE_RULES = [
    (("wan",), ("Wan2.2", "Wan2.1", "Wan", "영상", "Video")),
    (("ltx",), ("LTX-Video", "LTXV", "LTX", "영상", "Video")),
    (("hunyuan",), ("Hunyuan", "영상", "Video")),
    (("minimax",), ("MiniMax", "영상", "Video")),
    (("cogvideo", "mochi", "svd", "animatediff", "framepack"), ("영상", "Video")),
    (("flux", "kontext"), ("FLUX", "Flux", "이미지", "Image")),
    (("qwen",), ("Qwen", "이미지", "Image")),
    (("illustrious", "noobai"), ("Illustrious", "SDXL", "이미지", "Image")),
    (("pony",), ("Pony", "SDXL", "이미지", "Image")),
    (("sdxl", "sd xl"), ("SDXL", "이미지", "Image")),
    (("sd 3", "sd3"), ("SD3", "이미지", "Image")),
    (("sd 2", "sd2"), ("SD2.1", "SD2", "이미지", "Image")),
    (("sd 1", "sd1"), ("SD1.5", "SD15", "이미지", "Image")),
]


def _leaf_index(folders):
    """폴더 이름의 마지막 칸으로 찾을 수 있게 만든다.

    폴더 이름은 대소문자만 다를 수 있다(SDXL vs sdxl). 마지막 칸으로 견준다.
    'SDXL/Illustrious' 는 illustrious 로도 찾힌다.
    """
    by_leaf = {}
    for folder in folders:
        by_leaf.setdefault(folder.split("/")[-1].lower(), folder)
    return by_leaf


def _match_base(base, by_leaf):
    """기반 모델에 맞는 폴더. (찾은 폴더, 새로 만들 이름) 을 준다.

    이미 있는 폴더를 먼저 찾는다. 없으면 첫 후보를 새 폴더로 제안한다.
    """
    low = str(base or "").lower()
    if not low:
        return "", ""
    for needles, candidates in BASE_RULES:
        if not any(needle in low for needle in needles):
            continue
        for candidate in candidates:
            found = by_leaf.get(candidate.lower())
            if found:
                return found, ""
        return "", candidates[0]
    return "", ""


def library_folders(kind=models.DEFAULT_KIND):
    """이미 파일이 들어 있는 하위 폴더 목록."""
    folders = set()
    for name in models.names(kind):
        parent = os.path.dirname(name).replace("\\", "/")
        parts = [p for p in parent.split("/") if p]
        for depth in range(1, len(parts) + 1):
            folders.add("/".join(parts[:depth]))
    return sorted(folders)


def suggest_folder(model, version, folders=None, kind=models.DEFAULT_KIND):
    """받은 것을 어느 폴더에 둘지 고른다. 마땅한 곳이 없으면 빈 문자열."""
    return suggest_folder_full(model, version, folders, kind)[0]


def suggest_folder_full(model, version, folders=None, kind=models.DEFAULT_KIND):
    """(폴더, 새로 만들어야 하나) 를 준다.

    이미 쓰고 있는 폴더를 먼저 찾는다. 없으면 새로 만들 이름을 제안한다 —
    받기 화면이 '새 폴더' 라고 알려 주고, 사용자가 지우면 뿌리에 떨어진다.
    """
    if folders is None:
        folders = _archive_folders(kind) if kind in ARCHIVE_KINDS else library_folders(kind)
    by_leaf = _leaf_index(folders)

    tags = {str(tag).lower() for tag in (model.get("tags") or [])}
    base = str(version.get("baseModel") or "")
    adult = model.get("nsfw") is True or (model.get("nsfwLevel") or 0) >= ADULT_NSFW

    # 로라는 쓰임새(캐릭터·포즈·의상)로 나눈다. 그 규칙을 먼저 본다.
    # 체크포인트·워크플로우는 그런 식으로 나누지 않으므로 건너뛴다.
    if kind == "loras":
        for rule_kind, needles, candidates in FOLDER_RULES:
            if rule_kind == "base":
                hit = any(needle in base.lower() for needle in needles)
            elif rule_kind == "tag":
                hit = bool(tags & set(needles))
            else:
                hit = adult
            if not hit:
                continue
            for candidate in candidates:
                found = by_leaf.get(candidate.lower())
                if found:
                    return found, False

    # 기반 모델로 나누기. 체크포인트는 이것이 본줄기고, 로라는 마지막 기댈 곳이다.
    found, fresh = _match_base(base, by_leaf)
    if found:
        return found, False
    if fresh:
        return fresh, True

    # 성인물은 따로 모아 두는 사람이 많다. 폴더가 이미 있을 때만 쓴다.
    if adult:
        for candidate in ("Adult", "NSFW", "18", "성인"):
            got = by_leaf.get(candidate.lower())
            if got:
                return got, False
    return "", False


@routes.get("/fla/civitai/folders")
async def get_civitai_folders(request):
    kind = request.query.get("kind") or models.DEFAULT_KIND
    if not kind_ok(kind):
        return web.json_response({"ok": False, "error": "Unknown kind"}, status=404)
    if kind in ARCHIVE_KINDS:
        root, folders = _archive_root(kind), _archive_folders(kind)
        return web.json_response({"ok": True, "root": root or "", "folders": folders})
    roots = models.roots(kind)
    return web.json_response({
        "ok": True,
        "root": roots[0] if roots else "",
        "folders": library_folders(kind),
    })


# ---------------------------------------------------------------- 내려받기

# 한 번에 읽는 크기. 너무 잘게 나누면 진행률만 자주 바뀌고 느려진다.
DOWNLOAD_CHUNK = 1024 * 1024
# 연결이 끊긴 채 매달려 있지 않도록. 전체 시간에는 제한을 두지 않는다(큰 파일).
DOWNLOAD_READ_TIMEOUT = 120

# 관리창에 보여줄 만큼만 기억한다. 다 쌓아 두면 창을 열 때마다 무거워진다.
MAX_DONE = 40

_dl = {
    "running": False,
    "queue": [],
    "recent": [],
    "current": None,
    "received": 0,
    "total": 0,
    "done": 0,
    "failed": 0,
    "cancelled": False,
    "errors": [],
    "finished_at": 0,
}
_dl_task = None


class Cancelled(CivitaiError):
    """사용자가 멈췄다. 실패로 세지 않는다."""


class LoginNeeded(CivitaiError):
    """브라우저로 로그인해야 받을 수 있다. API 키로는 안 된다.

    글쓴이가 '로그인해야 다운로드' 를 켜 두면 이렇게 된다. 키를 등록해도
    똑같이 막히므로, 키를 등록하라고 하면 안 된다."""

    def __init__(self, message, had_session=False):
        super().__init__(message)
        # 세션까지 들고 갔는데도 막혔나(그러면 세션이 만료된 것이다)
        self.had_session = had_session


# 그런 경우 화면에 보여줄 말. Civitai 가 아무 말도 안 해줄 때 쓴다.
_LOGIN_HINT = "글쓴이가 로그인한 사람만 받게 해 두었습니다 — Civitai 에서 직접 받으세요"


def _looks_like_page(res, head):
    """받아온 것이 모델 파일이 아니라 웹 화면인가."""
    kind = (res.headers.get("Content-Type") or "").lower()
    if kind.startswith(("text/html", "application/json")):
        return True
    return head[:15].lstrip().lower().startswith((b"<!doctype", b"<html"))


async def _refuse_reason(res):
    """거절당한 이유. Civitai 가 주는 말을 그대로 쓴다(번역보다 정확하다)."""
    try:
        body = await res.json()
        said = (body or {}).get("message") or ""
    except Exception:
        said = ""
    return said.strip() or _LOGIN_HINT


def _safe_component(text):
    """경로를 뚫고 나갈 수 있는 글자를 걷어낸다."""
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", str(text or "")).strip(" .")
    return cleaned[:120]


def _archive_root(kind):
    """워크플로우·와일드카드를 풀어 놓을 자리. 없으면 None.

    워크플로우는 ComfyUI 의 user 폴더 아래에 있다. 자리를 직접 계산하지 않고
    user_manager 에게 묻는다(사용자를 여럿 쓰는 설정에서도 제 폴더를 보게).
    """
    if kind == "workflows":
        manager = getattr(PromptServer.instance, "user_manager", None)
        if manager is None:
            return None
        try:
            return manager.get_request_user_filepath(None, "workflows", create_dir=True)
        except Exception:
            # 요청 없이 부르면 실패할 수 있다. 기본 사용자 자리로 물러난다.
            try:
                return os.path.join(folder_paths.get_user_directory(), "default", "workflows")
            except Exception:
                return None
    if kind == "wildcards":
        try:
            from . import wildcards
            found = wildcards.find_roots()
        except Exception:
            return None
        return found[0] if found else None
    return None


def _archive_folders(kind):
    """이미 쓰고 있는 하위 폴더 목록. 받을 자리를 고르는 데 쓴다."""
    root = _archive_root(kind)
    if not root or not os.path.isdir(root):
        return []
    found = set()
    for folder, dirs, _files in os.walk(root):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        rel = os.path.relpath(folder, root).replace(os.sep, "/")
        if rel not in (".", ""):
            found.add(rel)
    return sorted(found)


def _resolve_target(folder, file_name, kind=models.DEFAULT_KIND):
    """<루트>/<folder>/<파일> 경로를 만든다. 루트 밖으로 나가면 거절한다."""
    if kind in ARCHIVE_KINDS:
        base = _archive_root(kind)
        roots = [base] if base else []
    else:
        roots = models.roots(kind)
    if not roots:
        raise CivitaiError(f"{kind} 폴더가 없음")
    root = os.path.abspath(roots[0])

    parts = [_safe_component(p) for p in str(folder or "").replace("\\", "/").split("/")]
    parts = [p for p in parts if p]
    target_dir = os.path.abspath(os.path.join(root, *parts)) if parts else root
    if os.path.commonpath([target_dir, root]) != root:
        raise CivitaiError("폴더가 로라 폴더 밖을 가리킴")

    name = _safe_component(file_name) or ("download.zip" if kind in ARCHIVE_KINDS else "model.safetensors")
    if not os.path.splitext(name)[1]:
        name += ".zip" if kind in ARCHIVE_KINDS else ".safetensors"

    os.makedirs(target_dir, exist_ok=True)
    # 같은 이름이 있으면 덮지 않고 번호를 붙인다
    stem, ext = os.path.splitext(name)
    candidate = os.path.join(target_dir, name)
    index = 2
    while os.path.exists(candidate):
        candidate = os.path.join(target_dir, f"{stem} ({index}){ext}")
        index += 1
    return candidate


async def _stream_to_file(url, api_key, path, on_progress):
    """받은 만큼 바로 디스크에 쓴다. 로라는 수백 MB 라 메모리에 담지 않는다."""
    import aiohttp

    # 전체 제한은 두지 않는다. 대신 한동안 아무것도 안 오면 끊는다.
    timeout = aiohttp.ClientTimeout(total=None, connect=30, sock_read=DOWNLOAD_READ_TIMEOUT)
    # 내려받기 주소는 CDN 으로 넘어간다. 그쪽에 Authorization 헤더를 들고 가면
    # 서명과 충돌하므로 키는 쿼리로 붙인다(Civitai 가 권하는 방식).
    params = {"token": api_key} if api_key else None
    # 로그인해야 받을 수 있는 글은 키로 안 된다. 세션을 등록해 두었으면 같이 든다.
    headers = {"User-Agent": "comfy_FLA"}
    session_cookie = _session_cookie()
    if session_cookie:
        headers["Cookie"] = session_cookie

    async def work(session):
        async with session.get(url, params=params, headers=headers, timeout=timeout) as res:
            if res.status in (401, 403):
                raise LoginNeeded(await _refuse_reason(res), had_session=bool(session_cookie))
            if res.status != 200:
                raise CivitaiError(f"HTTP {res.status}")

            total = int(res.headers.get("Content-Length") or 0)
            on_progress(0, total)
            received = 0
            first = True
            with open(path, "wb") as f:
                async for chunk in res.content.iter_chunked(DOWNLOAD_CHUNK):
                    if _dl["cancelled"]:
                        raise Cancelled("취소함")
                    if first:
                        first = False
                        # 인증에 걸리면 200 과 함께 로그인 화면이 오기도 한다.
                        # 그걸 모델 파일로 저장하면 나중에 안 열리는데 파일은
                        # 멀쩡해 보인다. 첫 조각을 보고 걸러낸다.
                        if _looks_like_page(res, chunk):
                            raise LoginNeeded(_LOGIN_HINT)
                    f.write(chunk)
                    received += len(chunk)
                    on_progress(received, total)
            if total and received != total:
                raise CivitaiError(f"받다가 끊김 ({received}/{total})")
            return received

    return await _with_session(work)


# 압축을 풀 때 꺼낼 것. 이것 말고는 버린다(실행 파일이 섞여 들어오지 않게).
ARCHIVE_KEEP = {
    "workflows": (".json",),
    "wildcards": (".txt", ".yaml", ".yml", ".json"),
}
# 풀어낸 것 전부의 상한. zip 폭탄으로 디스크를 채우지 않으려고 둔다.
MAX_EXTRACT_BYTES = 512 * 1024 * 1024
MAX_EXTRACT_FILES = 2000


def _extract_archive(path, root, kind):
    """받은 zip 에서 쓸 만한 것만 꺼낸다. 꺼낸 상대 경로 목록을 준다.

    zip 안의 이름은 남이 지은 것이라 ../ 로 폴더 밖을 가리킬 수 있다.
    실제로 만들 경로를 뿌리와 견줘 한 번 더 막는다.
    """
    import zipfile

    keep = ARCHIVE_KEEP.get(kind, (".json",))
    stem = os.path.splitext(os.path.basename(path))[0]
    # 한 글에 파일이 여럿이면 폴더로 묶어야 섞이지 않는다
    base = os.path.join(os.path.dirname(path), _safe_component(stem) or "download")
    made = []
    written = 0

    try:
        with zipfile.ZipFile(path) as archive:
            entries = [e for e in archive.infolist()
                       if not e.is_dir() and os.path.splitext(e.filename)[1].lower() in keep]
            if not entries:
                raise CivitaiError("압축 안에 쓸 만한 파일이 없음")
            if len(entries) > MAX_EXTRACT_FILES:
                raise CivitaiError(f"압축 안 파일이 너무 많음 ({len(entries)})")
            # 파일이 하나뿐이면 폴더를 만들지 않고 그 자리에 둔다
            target_root = os.path.dirname(path) if len(entries) == 1 else base

            for entry in entries:
                parts = [_safe_component(part) for part in entry.filename.replace(chr(92), "/").split("/")]
                parts = [part for part in parts if part and part not in (".", "..")]
                if not parts:
                    continue
                out = os.path.abspath(os.path.join(target_root, *parts))
                if os.path.commonpath([out, os.path.abspath(root)]) != os.path.abspath(root):
                    continue  # 뿌리 밖을 가리키는 것은 버린다
                written += entry.file_size
                if written > MAX_EXTRACT_BYTES:
                    raise CivitaiError("압축을 풀면 너무 커짐")
                os.makedirs(os.path.dirname(out), exist_ok=True)
                # 같은 이름이 있으면 덮지 않고 번호를 붙인다
                head, ext = os.path.splitext(out)
                index = 2
                while os.path.exists(out):
                    out = f"{head} ({index}){ext}"
                    index += 1
                with archive.open(entry) as src, open(out, "wb") as dst:
                    dst.write(src.read())
                made.append(os.path.relpath(out, root).replace(os.sep, "/"))
    except zipfile.BadZipFile:
        raise CivitaiError("압축 파일이 아니거나 깨져 있음")

    return made


async def _remember_workflows(names, root, version, model, folder):
    """받은 워크플로우마다 출처·원본·대표 이미지를 곁에 남긴다.

    한 글(zip) 에 워크플로우가 여럿 들어 있는 일이 흔하다. 모두 같은
    글에서 왔으므로 같은 출처를 적는다. 새 버전이 나오면 다 같이 걸린다.
    """
    from . import workflow_store

    store = workflow_store.root(None, create=True)
    if not store:
        return

    owner = model or version.get("model") or {}
    stamp = {
        "source": "civitai",
        "model_id": version.get("modelId") or owner.get("id"),
        "model_name": owner.get("name") or "",
        "version_id": version.get("id"),
        "version_name": version.get("name") or "",
        "creator": (owner.get("creator") or {}).get("username") or "",
        "published": version.get("publishedAt") or version.get("createdAt") or "",
        "folder": folder or "",
        "got_at": int(time.time()),
    }

    # 대표 이미지는 한 번만 받아서 모두에게 나눠 쓴다
    cover = None
    image = pick_preview(version, still_only=True)
    if image:
        try:
            cover = await _download_image(image["url"])
        except (CivitaiError, OSError):
            cover = None

    for name in names:
        workflow_store.set_meta(store, name, stamp)
        path = os.path.join(root, *name.split("/"))
        try:
            with open(path, "r", encoding="utf-8") as f:
                workflow_store.set_base_graph(store, name, json.load(f))
        except (OSError, ValueError):
            pass  # 원본을 못 남기면 나중에 두 갈래 머지로 물러선다
        if cover:
            blob, ext = cover
            workflow_store.write_image(store, workflow_store.COVER_DIR, name, blob, ext)


async def _write_sidecars(path, version, model, sha256):
    """받은 파일 옆에 metadata.json 과 대표 이미지를 놓는다."""
    stem = os.path.splitext(path)[0]
    data = build_metadata({}, version, model, path, sha256)

    image = pick_preview(version)
    if image:
        try:
            blob, ext = await _download_image(image["url"])
            with open(stem + ".preview" + ext, "wb") as f:
                f.write(blob)
            data["preview_url"] = os.path.basename(stem + ".preview" + ext)
            level = image.get("nsfwLevel")
            data["preview_nsfw_level"] = level if isinstance(level, int) else 0
        except (CivitaiError, OSError):
            pass  # 정보는 살리고 그림만 포기한다

    _save_metadata(stem + ".metadata.json", data)


async def download_version(version_id, folder, api_key, verify=True, kind=None):
    """버전 하나를 받아 폴더에 넣는다.

    모델(로라·체크포인트)이면 곁다리 정보까지 채운다. 워크플로우·와일드카드는
    zip 으로 오므로 풀어서 .json/.txt 만 꺼내고 압축 파일은 지운다.
    """
    version = await _get_json(f"/model-versions/{version_id}", api_key)
    if not kind:
        kind = kind_for_type((version.get("model") or {}).get("type")) or models.DEFAULT_KIND
    if not kind_ok(kind):
        raise CivitaiError("받아둘 자리를 모르는 종류")
    primary = _primary_file(version)
    if not primary:
        raise CivitaiError("받을 파일이 없음")

    expected = ((primary.get("hashes") or {}).get("SHA256") or "").lower()
    url = primary.get("downloadUrl") or version.get("downloadUrl")
    if not url:
        raise CivitaiError("내려받기 주소가 없음")

    path = _resolve_target(folder, primary.get("name") or f"{version_id}.safetensors", kind)
    part = path + ".part"

    _dl["current"] = {
        "version_id": version_id,
        "title": (version.get("model") or {}).get("name") or version.get("name") or "",
        "file_name": os.path.basename(path),
        "folder": folder or "/",
        "kind": kind,
    }

    def progress(received, total):
        _dl["received"] = received
        _dl["total"] = total

    try:
        await _stream_to_file(url, api_key, part, progress)

        sha = expected
        if verify:
            # 끊긴 파일을 정상으로 기록해두면 나중에 원인을 못 찾는다
            sha = await sha256_async(part)
            if expected and sha != expected:
                raise CivitaiError("받은 파일이 손상됨(해시 불일치)")

        os.replace(part, path)
    except BaseException:
        # 반쯤 받은 파일을 남기지 않는다
        try:
            if os.path.exists(part):
                os.remove(part)
        except OSError:
            pass
        raise

    if kind in ARCHIVE_KINDS:
        # 압축을 풀고 원본 zip 은 남기지 않는다. 워크플로우 목록에 zip 이
        # 끼어 있으면 눈에만 걸린다.
        root = _archive_root(kind)
        made = _extract_archive(path, root, kind)
        try:
            os.remove(path)
        except OSError:
            pass
        if kind == "workflows":
            # 어디서 받았는지와 받았을 때의 모습을 남긴다. 나중에 새 버전을
            # 합칠 때(머지) 이 원본이 있어야 내가 고친 것을 가려낼 수 있다.
            await _remember_workflows(made, root, version, model, folder)
        return {"path": root, "files": made, "kind": kind,
                "file_name": os.path.basename(path), "folder": folder}

    model = None
    if version.get("modelId"):
        try:
            model = await fetch_model(version["modelId"], api_key)
        except CivitaiError:
            model = None
    try:
        await _write_sidecars(path, version, model, sha)
    except OSError:
        pass  # 파일은 이미 받았다. 정보는 나중에 다시 채울 수 있다.

    models.invalidate(kind)
    invalidate_installed()
    invalidate_pending()
    return {"path": path, "file_name": os.path.basename(path), "folder": folder, "kind": kind}


def _job_name(job):
    """오류 줄에 쓸 이름."""
    return job.get("title") or job.get("path") or str(job.get("version_id") or "?")


def _remember_done(job, got=None, error="", login_needed=False):
    """끝난 것을 관리창에 보여줄 만큼만 남긴다."""
    _dl["recent"].append({
        # 막힌 것은 브라우저로 가야 한다. 갈 곳을 함께 남긴다.
        "url": job.get("url") or "",
        "login_needed": login_needed,
        "title": job.get("title") or (got or {}).get("file_name") or "",
        "file_name": (got or {}).get("file_name") or "",
        "folder": job.get("folder") or "",
        "kind": job.get("kind") or (got or {}).get("kind") or "",
        "source": job.get("source") or "civitai",
        "error": error,
        "at": int(time.time()),
    })
    del _dl["recent"][:-MAX_DONE]


async def _download_one(job, api_key):
    """대기열의 일 하나. 어디서 받는지에 따라 길이 갈린다."""
    if job.get("source") == "huggingface":
        from . import huggingface
        return await huggingface.grab(job)
    if job.get("source") == "import":
        from . import imports
        return await imports.take(job)
    return await download_version(job["version_id"], job.get("folder") or "", api_key,
                                  kind=job.get("kind") or None)


def enqueue(job, api_key=None):
    """받을 것을 줄에 넣는다. 돌고 있지 않으면 깨운다."""
    global _dl_task
    import asyncio as _asyncio

    _dl["queue"].append(job)
    if not _dl["running"]:
        _dl["running"] = True
        _dl["cancelled"] = False
        _dl["done"] = 0
        _dl["failed"] = 0
        _dl["errors"] = []
        _dl["finished_at"] = 0
        _dl_task = _asyncio.create_task(_download_loop(api_key if api_key is not None else _api_key()))
    return _public_download()


async def _download_loop(api_key):
    try:
        while _dl["queue"] and not _dl["cancelled"]:
            job = _dl["queue"].pop(0)
            _dl["received"] = 0
            _dl["total"] = 0
            try:
                got = await _download_one(job, api_key)
                _dl["done"] += 1
                _remember_done(job, got)
            except Cancelled:
                break
            except LoginNeeded as e:
                _dl["failed"] += 1
                _remember_done(job, error=str(e), login_needed=True)
                if len(_dl["errors"]) < MAX_ERRORS:
                    _dl["errors"].append({"name": _job_name(job), "error": str(e),
                                          "login_needed": True, "url": job.get("url") or ""})
            except CivitaiError as e:
                _dl["failed"] += 1
                _remember_done(job, error=str(e))
                if len(_dl["errors"]) < MAX_ERRORS:
                    _dl["errors"].append({"name": _job_name(job), "error": str(e)})
            except Exception as e:
                _dl["failed"] += 1
                _remember_done(job, error=repr(e))
                if len(_dl["errors"]) < MAX_ERRORS:
                    _dl["errors"].append({"name": _job_name(job), "error": repr(e)})
    finally:
        _dl["running"] = False
        _dl["current"] = None
        _dl["received"] = 0
        _dl["total"] = 0
        _dl["finished_at"] = int(time.time())


@routes.post("/fla/civitai/download")
async def post_civitai_download(request):
    global _dl_task
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "Bad request"}, status=400)

    try:
        version_id = int(body.get("version_id"))
    except (TypeError, ValueError):
        return web.json_response({"ok": False, "error": "Bad version"}, status=400)

    kind = body.get("kind") or ""
    if kind and not kind_ok(kind):
        return web.json_response({"ok": False, "error": "Unknown kind"}, status=404)

    return web.json_response({"ok": True, "download": enqueue({
        "source": "civitai",
        "version_id": version_id,
        "folder": body.get("folder") or "",
        "title": body.get("title") or "",
        # 막혔을 때 화면이 "Civitai 에서 받기" 로 보낼 곳
        "url": f"https://civitai.com/models/{body['model_id']}" if body.get("model_id") else "",
        # 안 주면 받을 때 Civitai 가 알려주는 종류로 정한다
        "kind": kind,
    })})


def _public_download():
    return {
        "running": _dl["running"],
        "queued": len(_dl["queue"]),
        # 무엇이 기다리는지. 관리창이 목록으로 보여준다.
        "queue": [dict(job) for job in _dl["queue"]],
        "recent": list(reversed(_dl["recent"])),
        "current": _dl["current"],
        "received": _dl["received"],
        "total": _dl["total"],
        "done": _dl["done"],
        "failed": _dl["failed"],
        "cancelled": _dl["cancelled"],
        "errors": list(_dl["errors"]),
        "finished_at": _dl["finished_at"],
    }


@routes.get("/fla/civitai/download-status")
async def get_civitai_download_status(request):
    return web.json_response({"ok": True, "download": _public_download()})


@routes.post("/fla/civitai/download-cancel")
async def post_civitai_download_cancel(request):
    # 받던 파일은 지우고 대기열도 비운다
    _dl["cancelled"] = True
    _dl["queue"].clear()
    return web.json_response({"ok": True, "download": _public_download()})
