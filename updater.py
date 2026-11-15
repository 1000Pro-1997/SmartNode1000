"""SM1000 스스로 업데이트하기.

새 판은 Comfy Registry 에 올린다. 허브가 열릴 때 거기에 물어 더 새 판이
있으면 "업데이트" 단추를 보여주고, 누르면 여기서 받아 바꿔 끼운다.
바꾼 코드는 ComfyUI 를 다시 띄워야 읽히므로 끝나면 재시작을 권한다.

깔린 모양이 둘이다.
    git 으로 받은 것(.git 이 있다)  — git pull --ff-only 로 당겨온다.
        내가 고친 것과 겹치면 git 이 멈추고 그 말을 그대로 보여준다.
    Registry/Manager 로 받은 것     — node.zip 을 받아 덮어쓴다.
        ComfyUI-Manager 와 같은 방식이다(.tracking 에 적힌 옛 파일 가운데
        새 판에 없는 것은 지운다). 다만 사용자가 고쳐 쓰는 파일(해상도 목록,
        설정, 즐겨찾기, 프리셋) 은 이미 있으면 덮지 않는다.
"""

import asyncio
import io
import os
import re
import shutil
import subprocess
import time
import zipfile

from aiohttp import web
from server import PromptServer

routes = PromptServer.instance.routes

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
NODE_ID = "fastloramaster"
INSTALL_API = f"https://api.comfy.org/nodes/{NODE_ID}/install"
# 받을 곳은 Registry 의 CDN 만 믿는다
DOWNLOAD_PREFIX = "https://cdn.comfy.org/"
TIMEOUT = 30
MAX_ZIP_BYTES = 64 * 1024 * 1024
# 한 번 물어본 답을 이만큼 쓴다. 허브를 열 때마다 묻지 않으려고.
CHECK_TTL = 10 * 60

# 이미 있으면 덮지 않는 사용자 파일·폴더
KEEP_FILES = {"resolutions.json", "user_settings.json", "wildcard_favorites.json",
              "civitai_updates.json", "civitai_updates_checkpoints.json",
              "workflow_favorites.json", ".env"}
KEEP_DIRS = ("presets/",)

_check = {"at": 0, "result": None}
_busy = asyncio.Lock()


def current_version():
    """pyproject.toml 에 적힌 지금 판."""
    try:
        with open(os.path.join(BASE_DIR, "pyproject.toml"), "r", encoding="utf-8") as f:
            found = re.search(r'^version\s*=\s*"([^"]+)"', f.read(), re.MULTILINE)
    except OSError:
        return ""
    return found.group(1) if found else ""


def _parts(version):
    """'1.6.0' -> (1, 6, 0). 숫자가 아닌 꼬리는 버린다."""
    return tuple(int(n) for n in re.findall(r"\d+", version or "")[:3])


def is_newer(latest, current):
    return bool(latest) and _parts(latest) > _parts(current)


def install_mode():
    return "git" if os.path.isdir(os.path.join(BASE_DIR, ".git")) else "zip"


async def _with_session(work):
    session = getattr(PromptServer.instance, "client_session", None)
    if session is not None:
        return await work(session)
    import aiohttp
    async with aiohttp.ClientSession() as own:
        return await work(own)


async def _latest():
    """Registry 가 주는 최신 판과 받을 주소."""
    import aiohttp

    async def work(session):
        async with session.get(INSTALL_API, headers={"User-Agent": "comfy_SM1000"},
                               timeout=aiohttp.ClientTimeout(total=TIMEOUT)) as res:
            if res.status != 200:
                raise RuntimeError(f"Registry HTTP {res.status}")
            return await res.json()
    data = await _with_session(work)
    return str(data.get("version") or ""), str(data.get("downloadUrl") or "")


async def check(force=False):
    now = time.time()
    if not force and _check["result"] and now - _check["at"] < CHECK_TTL:
        return _check["result"]
    current = current_version()
    latest, _url = await _latest()
    result = {"current": current, "latest": latest, "available": is_newer(latest, current),
              "mode": install_mode()}
    _check.update(at=now, result=result)
    return result


# -------------------------------------------------- git 으로 받은 것


def _git_pull():
    git = shutil.which("git")
    if not git:
        raise RuntimeError("git 을 찾을 수 없습니다")
    done = subprocess.run([git, "-C", BASE_DIR, "pull", "--ff-only"], capture_output=True,
                          text=True, encoding="utf-8", errors="replace", timeout=180)
    if done.returncode != 0:
        said = (done.stderr or done.stdout or "").strip().splitlines()
        raise RuntimeError(" / ".join(said[-3:]) or f"git pull 실패 ({done.returncode})")


# -------------------------------------------------- node.zip 으로 받은 것


def _kept(name):
    """이미 있으면 덮지 않을 사용자 파일인가."""
    return name in KEEP_FILES or name.startswith(KEEP_DIRS)


def _apply_zip(blob):
    """받은 node.zip 을 이 폴더에 풀어 덮는다. 새로 깐 파일 목록을 준다."""
    try:
        archive = zipfile.ZipFile(io.BytesIO(blob))
    except zipfile.BadZipFile:
        raise RuntimeError("받은 파일이 zip 이 아닙니다")
    with archive:
        names = [e.filename for e in archive.infolist() if not e.is_dir()]
        if "pyproject.toml" not in names or "__init__.py" not in names:
            raise RuntimeError("SM1000 패키지가 아닙니다")
        root = os.path.realpath(BASE_DIR)
        extracted = []
        for entry in archive.infolist():
            if entry.is_dir():
                continue
            name = entry.filename.replace("\\", "/")
            out = os.path.realpath(os.path.join(root, *name.split("/")))
            if os.path.commonpath([out, root]) != root:
                continue  # 폴더 밖을 가리키는 이름은 버린다
            extracted.append(name)
            if _kept(name) and os.path.exists(out):
                continue
            os.makedirs(os.path.dirname(out), exist_ok=True)
            with archive.open(entry) as src, open(out + ".new", "wb") as dst:
                shutil.copyfileobj(src, dst)
            os.replace(out + ".new", out)

    # 옛 판에만 있던 파일은 지운다(남은 .js 는 ComfyUI 가 그대로 읽어 버린다).
    # 무엇이 옛 판 것인지는 Manager 가 남기는 .tracking 으로 안다.
    tracking = os.path.join(BASE_DIR, ".tracking")
    if os.path.isfile(tracking):
        with open(tracking, "r", encoding="utf-8") as f:
            before = {line.strip() for line in f if line.strip()}
        for name in before - set(extracted):
            if _kept(name):
                continue
            path = os.path.realpath(os.path.join(BASE_DIR, *name.split("/")))
            if os.path.commonpath([path, os.path.realpath(BASE_DIR)]) == os.path.realpath(BASE_DIR) \
                    and os.path.isfile(path):
                os.remove(path)
    with open(tracking, "w", encoding="utf-8") as f:
        f.write("\n".join(extracted))
    return extracted


async def _download(url):
    import aiohttp

    async def work(session):
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=300)) as res:
            if res.status != 200:
                raise RuntimeError(f"HTTP {res.status}")
            blob = bytearray()
            # read(n) 은 한 조각만 준다. 끝까지 모으되 상한을 넘으면 멈춘다.
            async for chunk in res.content.iter_chunked(1024 * 1024):
                blob.extend(chunk)
                if len(blob) > MAX_ZIP_BYTES:
                    raise RuntimeError("패키지가 너무 큽니다")
            return bytes(blob)
    return await _with_session(work)


async def apply():
    current = current_version()
    latest, url = await _latest()
    if not is_newer(latest, current):
        return {"current": current, "latest": latest, "updated": False}
    if install_mode() == "git":
        await asyncio.to_thread(_git_pull)
    else:
        if not url.startswith(DOWNLOAD_PREFIX):
            raise RuntimeError("받을 주소가 Registry 가 아닙니다")
        blob = await _download(url)
        await asyncio.to_thread(_apply_zip, blob)
    _check.update(at=0, result=None)
    return {"current": current_version(), "latest": latest, "updated": True}


# -------------------------------------------------- 라우트


@routes.get("/fla/update/check")
async def get_update_check(request):
    try:
        result = await check(force=request.query.get("force") == "1")
    except Exception as e:
        return web.json_response({"ok": False, "current": current_version(), "error": str(e)}, status=502)
    return web.json_response({"ok": True, **result})


@routes.post("/fla/update/apply")
async def post_update_apply(request):
    """새 판으로 바꿔 끼운다. 끝나면 재시작해야 읽힌다.

    재시작과 마찬가지로 JSON 으로만 받는다(다른 사이트의 폼이 못 보내게).
    """
    if request.content_type != "application/json":
        return web.json_response({"ok": False, "error": "Bad request"}, status=400)
    if _busy.locked():
        return web.json_response({"ok": False, "error": "이미 업데이트하는 중입니다"}, status=409)
    async with _busy:
        try:
            result = await apply()
        except Exception as e:
            return web.json_response({"ok": False, "error": str(e)}, status=500)
    return web.json_response({"ok": True, **result})
