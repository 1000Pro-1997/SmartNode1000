"""허깅페이스에서 없는 모델 찾아 받기.

Civitai 에 없는 모델이 꽤 있다. 특히 요즘 영상 모델과 텍스트 인코더·VAE 는
허깅페이스에만 올라온다. 워크플로우를 받아 열었더니 모델이 없다고 할 때,
이름만 들고 여기서 찾아볼 수 있게 한다.

Civitai 쪽과 다른 점이 둘 있다.
    글 하나에 파일이 수십 개 들어 있다(모델 한 벌이 통째로 올라온다).
    그래서 글을 고른 다음 파일을 한 번 더 고르게 한다.
    해시로 찾을 수 없다. 이름으로만 찾는다.

받는 자리는 Civitai 와 같다 — models.KINDS 가 아는 폴더.
"""

import asyncio
import os
import re
import time
from urllib.parse import quote, urlencode

from aiohttp import web
from server import PromptServer

from . import models

routes = PromptServer.instance.routes

API = "https://huggingface.co/api"
SITE = "https://huggingface.co"
TIMEOUT = 30
SEARCH_LIMIT = 20
# 받을 만한 것으로 볼 확장자. 나머지(설정·README)는 목록에서 뺀다.
MODEL_EXTS = (".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".gguf", ".sft", ".onnx")
DOWNLOAD_CHUNK = 1024 * 1024
DOWNLOAD_READ_TIMEOUT = 120


class HuggingError(Exception):
    """호출 실패. 메시지를 그대로 화면에 보여준다."""


async def _with_session(work):
    """ComfyUI 가 들고 있는 세션을 빌려 쓴다. 없으면 잠깐 하나 만든다."""
    session = getattr(PromptServer.instance, "client_session", None)
    if session is not None:
        return await work(session)
    import aiohttp
    async with aiohttp.ClientSession() as own:
        return await work(own)


async def _get_json(path):
    async def work(session):
        import aiohttp
        try:
            async with session.get(f"{API}{path}", headers={"User-Agent": "comfy_SM1000"},
                                   timeout=aiohttp.ClientTimeout(total=TIMEOUT)) as res:
                if res.status == 404:
                    raise HuggingError("찾을 수 없음")
                if res.status != 200:
                    raise HuggingError(f"HTTP {res.status}")
                return await res.json()
        except asyncio.TimeoutError:
            raise HuggingError("응답이 없음")
    return await _with_session(work)


def _pretty(bytes_or_none):
    if not bytes_or_none:
        return ""
    value = float(bytes_or_none)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024 or unit == "GB":
            return f"{value:.1f} {unit}" if unit in ("MB", "GB") else f"{value:.0f} {unit}"
        value /= 1024
    return ""


def _trim_model(entry):
    return {
        "repo": entry.get("modelId") or entry.get("id") or "",
        "author": (entry.get("modelId") or "/").split("/")[0],
        "downloads": entry.get("downloads"),
        "likes": entry.get("likes"),
        "updated": (entry.get("lastModified") or "")[:10],
        "tags": [tag for tag in (entry.get("tags") or []) if isinstance(tag, str)][:8],
        "gated": entry.get("gated") not in (False, None),
        "url": f"{SITE}/{entry.get('modelId') or ''}",
    }


# -------------------------------------------------- 라우트


def _bad(message, status=400):
    return web.json_response({"ok": False, "error": message}, status=status)


async def _body(request):
    try:
        return await request.json()
    except Exception:
        return None


@routes.get("/fla/hf/search")
async def get_hf_search(request):
    """글 찾기. 브라우저에서 직접 부르면 교차 출처에 걸리므로 서버가 대신 부른다."""
    query = (request.query.get("q") or "").strip()
    if not query:
        return web.json_response({"ok": True, "items": []})
    params = {"search": query, "limit": SEARCH_LIMIT, "sort": "downloads", "direction": -1}
    tag = (request.query.get("tag") or "").strip()
    if tag:
        params["filter"] = tag
    try:
        data = await _get_json(f"/models?{urlencode(params)}")
    except HuggingError as e:
        return _bad(str(e), 502)
    items = [_trim_model(entry) for entry in (data or []) if isinstance(entry, dict)]
    return web.json_response({"ok": True, "items": items})


@routes.get("/fla/hf/files")
async def get_hf_files(request):
    """글 하나에 든 파일 목록. 받을 만한 것만 골라 준다."""
    repo = (request.query.get("repo") or "").strip().strip("/")
    # 글 이름은 <올린이>/<이름> 꼴이다. 그 밖의 글자는 받지 않는다.
    if not re.fullmatch(r"[A-Za-z0-9._-]+/[A-Za-z0-9._-]+", repo):
        return _bad("Bad repo")
    try:
        # blobs=true 를 붙여야 파일 크기와 해시가 같이 온다
        data = await _get_json(f"/models/{quote(repo)}?blobs=true")
    except HuggingError as e:
        return _bad(str(e), 404 if "찾을 수 없음" in str(e) else 502)

    files = []
    for entry in (data.get("siblings") or []):
        path = entry.get("rfilename")
        if not isinstance(path, str) or not path.lower().endswith(MODEL_EXTS):
            continue
        # 큰 파일은 lfs 로 올라온다. 그쪽 크기가 진짜다.
        lfs = entry.get("lfs") or {}
        size = lfs.get("size") or entry.get("size")
        files.append({
            "path": path,
            "name": path.split("/")[-1],
            "size": size,
            "size_text": _pretty(size),
            "sha256": lfs.get("sha256") or "",
            "url": f"{SITE}/{repo}/resolve/main/{quote(path)}",
        })
    files.sort(key=lambda f: f["path"])
    return web.json_response({
        "ok": True,
        "repo": repo,
        "gated": data.get("gated") not in (False, None),
        "url": f"{SITE}/{repo}",
        "files": files,
    })


# -------------------------------------------------- 받기
#
# Civitai 쪽 받기 줄(_dl)을 그대로 쓴다. 화면에서 진행률을 보는 곳이 하나뿐이라
# 두 벌을 만들면 섞인다.


@routes.post("/fla/hf/download")
async def post_hf_download(request):
    """파일 하나를 골라 모델 폴더에 받는다.

    실제로 받는 일은 Civitai 와 같은 대기열이 한다. 몇 GB 짜리를 요청 안에서
    받으면 그 요청이 그동안 매달려 있고 받기 관리창에도 안 보인다.
    """
    from . import civitai

    body = await _body(request)
    if body is None:
        return _bad("Bad request")

    kind = body.get("kind") or models.DEFAULT_KIND
    if not models.known(kind):
        return _bad("Unknown model kind", 404)

    repo = (body.get("repo") or "").strip().strip("/")
    path = (body.get("path") or "").strip()
    error = check_target(repo, path)
    if error:
        return _bad(error)

    return web.json_response({"ok": True, "download": civitai.enqueue({
        "source": "huggingface",
        "repo": repo,
        "path": path,
        "kind": kind,
        "folder": body.get("folder") or "",
        "title": path.split("/")[-1],
    })})


def check_target(repo, path):
    """글 이름과 파일 경로가 받을 만한 것인지. 괜찮으면 None."""
    # 글 이름은 <올린이>/<이름> 꼴이다. 그 밖의 글자는 받지 않는다.
    if not re.fullmatch(r"[A-Za-z0-9._-]+/[A-Za-z0-9._-]+", repo or ""):
        return "Bad repo"
    if not path or ".." in path.split("/") or path.startswith("/"):
        return "Bad file"
    if not path.lower().endswith(MODEL_EXTS):
        return "Bad file"
    return None


async def grab(job):
    """대기열이 부른다. 파일 하나를 받아 곁다리 정보까지 적는다."""
    from . import civitai

    repo = job.get("repo") or ""
    path = job.get("path") or ""
    kind = job.get("kind") or models.DEFAULT_KIND
    error = check_target(repo, path)
    if error or not models.known(kind):
        raise civitai.CivitaiError(error or "Unknown model kind")

    url = f"{SITE}/{repo}/resolve/main/{quote(path)}"
    folder = job.get("folder") or ""
    target = civitai._resolve_target(folder, path.split("/")[-1], kind)
    part = target + ".part"

    def progress(received, total):
        civitai._dl["received"] = received
        civitai._dl["total"] = total

    try:
        # 허깅페이스는 열린 파일이 대부분이라 키 없이 받는다
        await civitai._stream_to_file(url, None, part, progress)
        os.replace(part, target)
    except BaseException:
        _cleanup(part)
        raise

    # 어디서 왔는지 곁다리에 적어 둔다. 나중에 이 파일이 뭐였는지 알 수 있게.
    roots = models.roots(kind)
    rel = os.path.relpath(target, roots[0]).replace(os.sep, "/") if roots else ""
    _full, metadata_path = models.paths(kind, rel)
    if metadata_path:
        info = models.load_metadata(metadata_path)
        info.setdefault("model_name", os.path.splitext(os.path.basename(target))[0])
        info["source"] = "huggingface"
        info["huggingface"] = {"repo": repo, "path": path, "url": f"{SITE}/{repo}"}
        info["got_at"] = int(time.time())
        try:
            models.save_metadata(metadata_path, info)
        except OSError:
            pass  # 파일은 이미 받았다

    models.invalidate(kind)
    try:
        civitai.invalidate_installed()
    except Exception:
        pass
    return {"file_name": os.path.basename(target), "folder": folder, "kind": kind}


def _cleanup(path):
    """반쯤 받은 파일을 남기지 않는다."""
    try:
        if os.path.exists(path):
            os.remove(path)
    except OSError:
        pass
