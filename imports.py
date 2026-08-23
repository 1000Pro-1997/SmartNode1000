"""브라우저로 받은 파일을 모델 폴더로 가져온다.

왜 필요한가.
    Civitai 에는 글쓴이가 '로그인한 사람만 다운로드' 를 켜 둔 글이 있다.
    그런 글은 API 키로 못 받는다 — 브라우저 세션이 있어야 한다. 그래서
    브라우저로 받으면 파일은 다운로드 폴더에 떨어지고, 사람이 손으로
    옮기고 이름을 확인하고 정보를 채워야 한다. 그 뒤를 여기서 잇는다.

무엇을 하는가.
    다운로드 폴더를 훑어 모델처럼 생긴 파일을 보여준다. 하나 고르면
    해시를 구해 Civitai 에 물어보고, 그 답으로 갈 폴더를 정한 뒤 옮긴다.
    곁다리 정보와 대표 이미지도 그때 같이 채운다.

    해시로 물어보므로 파일 이름이 무엇이든 상관없다. 이름을 바꿔 받았거나
    (1).safetensors 가 붙어도 제 것을 찾아간다.

무엇을 하지 않는가.
    파일을 복사하지 않고 옮긴다(수십 GB 를 두 벌 두지 않는다). 그래서
    옮기기 전에 갈 곳을 정하고, 같은 이름이 있으면 번호를 붙인다.
    훑는 폴더 밖의 경로는 받지 않는다.
"""

import os
import shutil
import sys
import time

from aiohttp import web
from server import PromptServer

from . import models

routes = PromptServer.instance.routes

# 가져올 만한 것으로 볼 확장자
MODEL_EXTS = (".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".gguf", ".sft", ".onnx")
# 한 폴더에서 보여줄 최대 개수. 오래된 것부터 잘라낸다.
MAX_FOUND = 60
# 아직 받는 중인 파일은 건드리지 않는다(브라우저가 붙이는 꼬리표들)
PARTIAL_EXTS = (".part", ".crdownload", ".download", ".tmp", ".!ut")


def _download_dir():
    """윈도우는 다운로드 폴더를 옮겨 둘 수 있다. 등록된 자리를 먼저 묻는다."""
    if sys.platform == "win32":
        try:
            import winreg
            key = winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                r"Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders")
            found, _ = winreg.QueryValueEx(key, "{374DE290-123F-4565-9164-39C4925E467B}")
            if found and os.path.isdir(found):
                return os.path.realpath(found)
        except Exception:
            pass
    return os.path.realpath(os.path.expanduser("~/Downloads"))


def watched_dirs():
    """훑을 폴더들. 사용자가 설정에 더 적어 둘 수 있다."""
    found = [_download_dir()]
    try:
        from .api import _read_settings
        extra = _read_settings().get("import_folders")
        if isinstance(extra, list):
            for path in extra:
                if isinstance(path, str) and os.path.isdir(path):
                    found.append(os.path.realpath(path))
    except Exception:
        pass
    # 같은 폴더를 두 번 훑지 않는다
    return list(dict.fromkeys(p for p in found if os.path.isdir(p)))


def _inside_watched(path):
    """훑는 폴더 안의 파일인가. 밖이면 None."""
    resolved = os.path.realpath(path)
    for root in watched_dirs():
        try:
            if os.path.commonpath([resolved, root]) == root:
                return resolved
        except ValueError:
            continue
    return None


# 들여다본 결과. (수정 시각, 크기) 가 그대로면 다시 읽지 않는다.
_PROBE_CACHE = {}


def look_inside(path, stat):
    """파일이 무엇인지 알아본다. 머리말만 읽으므로 수 GB 짜리도 곧바로 본다."""
    key = (int(stat.st_mtime), stat.st_size)
    hit = _PROBE_CACHE.get(path)
    if hit and hit[0] == key:
        return hit[1]
    from . import model_probe
    try:
        found = model_probe.probe(path)
    except Exception:
        found = {"kind": "", "base_model": "", "tensors": 0, "format": "", "title": ""}
    _PROBE_CACHE[path] = (key, found)
    return found


def scan():
    """가져올 만한 파일들. 새로 받은 것이 앞에 온다."""
    found = []
    for root in watched_dirs():
        try:
            names = os.listdir(root)
        except OSError:
            continue
        for name in names:
            if name.startswith("."):
                continue
            path = os.path.join(root, name)
            stem, ext = os.path.splitext(name)
            if ext.lower() in PARTIAL_EXTS:
                continue  # 아직 받는 중
            if ext.lower() not in MODEL_EXTS:
                continue
            try:
                stat = os.stat(path)
            except OSError:
                continue
            if not os.path.isfile(path):
                continue
            inside = look_inside(path, stat)
            guess = inside.get("kind") or ""
            # 카드가 "어디로 갈지" 를 미리 보여줄 수 있게 계산해 둔다.
            # 가져올 때 Civitai 가 더 나은 답을 주면 그쪽이 이긴다.
            going = folder_for(guess, inside.get("base_model") or name) if guess else ""
            found.append({
                "path": path,
                "name": name,
                "where": root,
                "size": stat.st_size,
                "modified": int(stat.st_mtime),
                # 파일 안을 보고 짐작한 것들. 카드에 그대로 보여준다.
                "guess": inside.get("kind") or "",
                "base_model": inside.get("base_model") or "",
                "title": inside.get("title") or "",
                "tensors": inside.get("tensors") or 0,
                "format": inside.get("format") or "",
                # 지금 아는 것만으로 정한 갈 곳. 빈 값이면 그 종류의 뿌리.
                "folder": going,
            })
    found.sort(key=lambda item: item["modified"], reverse=True)
    return found[:MAX_FOUND]


def folder_for(kind, hint, allow_new=None):
    """이 종류 안에서 어느 하위 폴더로 보낼지. 마땅한 곳이 없으면 빈 문자열.

    hint 는 기반 모델 이름이거나 파일 이름이다. "wan2.2", "MiniMax-H3",
    "sdxl_..." 같은 것에서 계열을 읽어낸다.

    새 폴더는 그 종류를 이미 폴더로 나눠 쓸 때만 제안한다. 평평하게 쓰는
    사람에게 폴더를 만들어 주는 것은 정리가 아니라 참견이다.
    """
    from . import civitai

    existing = civitai.library_folders(kind)
    if allow_new is None:
        allow_new = bool(existing)
    found, fresh = civitai._match_base(hint or "", civitai._leaf_index(existing))
    if found:
        return found
    return fresh if (fresh and allow_new) else ""


def move_in(path, kind, folder, file_name=None):
    """파일을 모델 폴더로 옮긴다. 옮긴 자리의 상대 이름을 준다."""
    from . import civitai

    target = civitai._resolve_target(folder or "", file_name or os.path.basename(path), kind)
    # 같은 드라이브면 이름만 바꾸면 되고, 아니면 실제로 옮겨진다
    shutil.move(path, target)
    models.invalidate(kind)
    roots = models.roots(kind)
    return os.path.relpath(target, roots[0]).replace(os.sep, "/") if roots else os.path.basename(target)


async def take(job):
    """대기열이 부른다. 무엇인지 알아내고, 갈 곳을 정해 옮긴 뒤 정보를 채운다."""
    from . import civitai

    path = _inside_watched(job.get("path") or "")
    if not path or not os.path.isfile(path):
        raise civitai.CivitaiError("파일을 찾을 수 없음")

    # 사용자가 손으로 고른 것이 있으면 그것이 이긴다. 자동이 틀릴 때
    # 바꿀 길이 없으면 곤란하다.
    chosen = job.get("kind") or ""
    chosen = chosen if models.known(chosen) else ""

    # 파일 안을 먼저 본다(빠르고 네트워크가 필요 없다)
    try:
        inside = look_inside(path, os.stat(path))
    except OSError:
        inside = {}
    guessed = inside.get("kind") or ""

    # 1) 해시. 큰 파일은 오래 걸리므로 진행률을 보여준다.
    total = os.path.getsize(path)
    civitai._dl["total"] = total
    civitai._dl["received"] = 0
    sha = await _hash_with_progress(path, total)

    # 2) Civitai 에 물어본다. 없어도 옮기기는 한다(그냥 정보 없는 파일이 된다).
    version = model = None
    said = ""
    folder = job.get("folder") or ""
    try:
        version = await civitai.fetch_version_by_hash(sha, civitai._api_key())
        if version.get("modelId"):
            try:
                model = await civitai.fetch_model(version["modelId"], civitai._api_key())
            except civitai.CivitaiError:
                model = None
        # 글쓴이가 붙인 종류가 가장 정확하다
        said = civitai.kind_for_type((model or version.get("model") or {}).get("type"))
    except civitai.NotFound:
        pass  # Civitai 에 없는 파일도 많다(허깅페이스에서 받은 것 등)
    except civitai.CivitaiError:
        pass  # 물어보기 실패. 옮기는 것까지는 해준다.

    # 고른 것 > Civitai 가 아는 것 > 파일이 말해주는 것 > 기본
    kind = chosen or (said if models.known(said) else "") or guessed or models.DEFAULT_KIND
    if not models.known(kind):
        kind = models.DEFAULT_KIND
    if not folder and version:
        folder = civitai.suggest_folder(model or version.get("model") or {}, version, None, kind)
    if not folder:
        # Civitai 가 모르는 파일이 훨씬 많다(허깅페이스에서 받은 것들).
        # 파일이 말해주는 기반 모델, 없으면 파일 이름을 단서로 삼는다.
        folder = folder_for(kind, inside.get("base_model") or os.path.basename(path))

    # 3) 옮긴다. 이름은 Civitai 가 아는 것이 있으면 그것을 쓴다.
    wanted = None
    if version:
        primary = civitai._primary_file(version) or {}
        if primary.get("name"):
            wanted = primary["name"]
    name = move_in(path, kind, folder, wanted)

    # 4) 곁다리 정보와 대표 이미지
    if version:
        full, metadata_path = models.paths(kind, name)
        if metadata_path:
            data = civitai.build_metadata({}, version, model, full, sha)
            try:
                models.save_metadata(metadata_path, data)
            except OSError:
                pass
            image = civitai.pick_preview(version)
            if image:
                try:
                    blob, ext = await civitai._download_image(image["url"])
                    models.write_preview(kind, name, blob, ext)
                except (civitai.CivitaiError, OSError):
                    pass  # 정보는 살리고 그림만 포기한다
    else:
        # 정보를 못 찾았어도 해시는 남긴다. 나중에 다시 물어볼 때 쓴다.
        _full, metadata_path = models.paths(kind, name)
        if metadata_path:
            data = models.load_metadata(metadata_path)
            data.setdefault("model_name", os.path.splitext(os.path.basename(name))[0])
            data["sha256"] = sha
            data["source"] = "import"
            data["got_at"] = int(time.time())
            try:
                models.save_metadata(metadata_path, data)
            except OSError:
                pass

    try:
        civitai.invalidate_installed()
        civitai.invalidate_pending()
    except Exception:
        pass
    return {"file_name": os.path.basename(name), "folder": os.path.dirname(name), "kind": kind,
            "found": bool(version),
            # 무엇을 보고 정했는지. 화면이 "Civitai 가 알려줌" 처럼 보여준다.
            "decided_by": "user" if chosen else ("civitai" if said else ("file" if guessed else "default"))}


async def _hash_with_progress(path, total):
    """해시를 구하면서 얼마나 읽었는지 알려준다. 수 GB 짜리는 한참 걸린다."""
    import asyncio
    import hashlib

    from . import civitai

    def work():
        digest = hashlib.sha256()
        read = 0
        with open(path, "rb") as f:
            while True:
                chunk = f.read(civitai.HASH_CHUNK)
                if not chunk:
                    break
                digest.update(chunk)
                read += len(chunk)
                civitai._dl["received"] = read
        return digest.hexdigest()

    return await asyncio.to_thread(work)


# -------------------------------------------------- 라우트


def _bad(message, status=400):
    return web.json_response({"ok": False, "error": message}, status=status)


@routes.get("/fla/import/scan")
async def get_import_scan(request):
    """다운로드 폴더에서 가져올 만한 파일을 찾아 준다."""
    found = scan()
    known = {kind: set(models.names(kind)) for kind in models.KINDS}
    items = []
    for item in found:
        base = item["name"].lower()
        # 이미 같은 이름이 모델 폴더에 있으면 알려 준다(두 벌 만들지 않게)
        already = ""
        for kind, names in known.items():
            if any(os.path.basename(n).lower() == base for n in names):
                already = kind
                break
        items.append({**item, "already": already})
    return web.json_response({"ok": True, "items": items, "folders": watched_dirs()})


@routes.post("/fla/import/take")
async def post_import_take(request):
    """고른 파일을 모델 폴더로 가져온다. 실제 일은 받기 대기열이 한다."""
    from . import civitai

    try:
        body = await request.json()
    except Exception:
        return _bad("Bad request")

    # 종류를 안 주면 스스로 정한다("자동"). 주면 그것이 이긴다.
    kind = body.get("kind") or ""
    if kind and not models.known(kind):
        return _bad("Unknown model kind", 404)
    path = _inside_watched(body.get("path") or "")
    if not path or not os.path.isfile(path):
        return _bad("File not found", 404)
    if os.path.splitext(path)[1].lower() not in MODEL_EXTS:
        return _bad("Bad file")

    return web.json_response({"ok": True, "download": civitai.enqueue({
        "source": "import",
        "path": path,
        "kind": kind,
        "folder": body.get("folder") or "",
        "title": os.path.basename(path),
    })})
