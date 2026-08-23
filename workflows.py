"""저장해 둔 워크플로우를 훑어서 관리창에 넘긴다.

워크플로우는 ComfyUI 가 user/<사용자>/workflows 아래에 저장한다. 그 자리를
직접 계산하지 않고 ComfyUI 의 user_manager 에게 물어본다. 사용자를 여럿
쓰는 설정에서도 그래야 제 폴더를 본다.

카드에 뭘 보여줄지가 이 파일의 일이다. 파일 이름만으로는 어떤 워크플로우인지
알기 어려우므로 열어보지 않아도 알 만한 것을 뽑는다 — 노드 수, 쓰는 모델,
그리고 지금 설치본에 없는 노드. 마지막 것이 제일 쓸모 있다. 남의 워크플로우를
받아 두었다가 열어보고 나서야 빨간 노드를 보는 일을 미리 막아준다.

JSON 을 매번 다 읽으면 느리므로 (수정 시각, 크기) 가 그대로면 지난 결과를 쓴다.
"""

import json
import os
import subprocess
import sys
import time
from urllib.parse import quote

from aiohttp import web
from server import PromptServer

routes = PromptServer.instance.routes

FAVORITES_PATH = os.path.join(os.path.dirname(__file__), "workflow_favorites.json")

# 워크플로우로 볼 확장자. ComfyUI 가 저장하는 것은 .json 뿐이다.
EXTENSIONS = (".json",)
# 위젯 값이 이 확장자로 끝나면 모델 파일로 본다.
MODEL_EXTS = (".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".gguf", ".sft", ".onnx")
# 카드에 늘어놓을 최대 개수. 넘치면 화면만 지저분해진다.
MAX_MODELS = 8
MAX_MISSING = 12

# 파일 하나당 (수정 시각, 크기) -> 요약. 파일이 그대로면 다시 읽지 않는다.
_SUMMARY_CACHE = {}

# 대표 그림과 출처는 workflow_store 가 형제 폴더에 모아 둔다.
# workflows 폴더 안에 두면 ComfyUI 워크플로우 목록에 끼어 보인다.
PREVIEW_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".gif")
MAX_PREVIEW_BYTES = 32 * 1024 * 1024
# 메모 노드에서 긁어올 글자 수 상한
MAX_NOTE = 2000


# -------------------------------------------------- 폴더


def root_for(request):
    """이 요청을 보낸 사용자의 workflows 폴더. 없으면 None."""
    manager = getattr(PromptServer.instance, "user_manager", None)
    if manager is None:
        return None
    try:
        path = manager.get_request_user_filepath(request, "workflows", create_dir=False)
    except Exception:
        return None
    return path if path and os.path.isdir(path) else None


def _inside(path, root):
    try:
        return os.path.commonpath((os.path.realpath(path), os.path.realpath(root))) == os.path.realpath(root)
    except ValueError:
        return False


def _safe_name(name):
    """사용자가 준 이름을 workflows 아래 상대 경로로 정리한다.

    경로 탈출을 여기서 한 번, 실제 경로를 만든 뒤 _inside 로 한 번 더 막는다.
    """
    if not isinstance(name, str):
        return None
    value = name.strip().replace("\\", "/")
    # 뿌리부터 시작하는 경로는 앞의 / 를 떼면 상대 경로처럼 보인다.
    # 떼기 전에 먼저 걸러낸다. os.path.isabs 만으로는 부족하다 —
    # 윈도우 파이썬은 "/x" 를 드라이브 상대 경로로 보고 절대가 아니라고 답한다.
    if not value or value.startswith("/") or os.path.isabs(value):
        return None
    if ":" in value.split("/")[0]:
        return None
    if ".." in value.split("/"):
        return None
    # 빈 칸, 점 하나, 그리고 숨김 이름(.index.json 같은 ComfyUI 내부 파일)은 막는다
    if any(part in ("", ".") or part.startswith(".") for part in value.split("/")):
        return None
    if any(character in value for character in '<>:"|?*'):
        return None
    if any(ord(character) < 32 for character in value):
        return None
    return value


def resolve(root, name):
    """상대 경로를 실제 파일 경로로. 폴더 밖이거나 없으면 None."""
    clean = _safe_name(name)
    if not clean or not root:
        return None
    if not clean.lower().endswith(EXTENSIONS):
        clean += ".json"
    path = os.path.join(root, *clean.split("/"))
    if not _inside(path, root) or not os.path.isfile(path):
        return None
    return path


def preview_root(request, create=False):
    """곁다리 뿌리. workflow_store 가 자리를 안다."""
    from . import workflow_store
    return workflow_store.root(request, create=create)


def user_preview(store, name):
    from . import workflow_store
    return workflow_store.shot_path(store, name)


def cover_preview(store, name):
    from . import workflow_store
    return workflow_store.cover_path(store, name)


def drop_user_preview(store, name):
    from . import workflow_store
    return workflow_store.drop_image(store, workflow_store.SHOT_DIR, name)


def auto_preview(store, path):
    """미니맵을 그려 두고 그 경로를 준다. 못 그리면 None.

    파일을 고치면 캐시 이름이 바뀌므로 그림도 새로 그려진다.
    """
    if not store:
        return None
    from . import workflow_store, workflow_thumb

    folder = os.path.join(store, workflow_store.AUTO_DIR)
    target = os.path.join(folder, workflow_thumb.cache_name(path))
    if os.path.isfile(target):
        return target

    try:
        with open(path, "r", encoding="utf-8") as f:
            graph = json.load(f)
    except (OSError, ValueError):
        return None
    try:
        blob = workflow_thumb.render(graph)
    except Exception:
        return None  # 그림 하나 때문에 목록이 안 뜨면 곤란하다
    if not blob:
        return None

    try:
        os.makedirs(folder, exist_ok=True)
        temp = target + ".tmp"
        with open(temp, "wb") as f:
            f.write(blob)
        os.replace(temp, target)
    except OSError:
        return None
    return target


# -------------------------------------------------- 즐겨찾기


def _read_favorites():
    if not os.path.isfile(FAVORITES_PATH):
        return set()
    try:
        with open(FAVORITES_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return set()
    return set(data) if isinstance(data, list) else set()


def _write_favorites(names):
    temp = FAVORITES_PATH + ".tmp"
    with open(temp, "w", encoding="utf-8") as f:
        json.dump(sorted(names), f, ensure_ascii=False, indent=2)
    os.replace(temp, FAVORITES_PATH)


def set_favorite(name, favorite):
    names = _read_favorites()
    if favorite:
        names.add(name)
    else:
        names.discard(name)
    _write_favorites(names)
    return name in names


# -------------------------------------------------- 워크플로우 읽기


def _known_types():
    """지금 설치본이 아는 노드 종류.

    ComfyUI 의 nodes.py 를 가져온다. 우리 쪽에도 nodes.py 가 있지만
    파이썬 3 는 절대 임포트가 기본이라 여기서는 ComfyUI 것이 잡힌다.
    """
    try:
        import nodes as comfy_nodes
        return set(comfy_nodes.NODE_CLASS_MAPPINGS)
    except Exception:
        return set()


def _walk_graphs(data):
    """그래프 본체와 그 안의 서브그래프 정의를 하나씩 내놓는다."""
    stack = [data]
    while stack:
        graph = stack.pop()
        if not isinstance(graph, dict):
            continue
        yield graph
        definitions = graph.get("definitions")
        if isinstance(definitions, dict):
            for subgraph in definitions.get("subgraphs") or []:
                stack.append(subgraph)


def _walk_nodes(data):
    """모든 그래프의 노드와, 서브그래프 id 모음을 함께 준다.

    서브그래프 정의(definitions.subgraphs)는 그 자체가 노드 종류가 되므로
    id 를 먼저 다 모아 둔다. 그래야 깊이 박힌 서브그래프를 쓰는 노드를
    '없는 노드' 로 잘못 세지 않는다.
    """
    graphs = list(_walk_graphs(data))
    subgraphs = {graph.get("id") for graph in graphs if isinstance(graph.get("id"), str)}
    nodes = []
    for graph in graphs:
        for node in graph.get("nodes") or []:
            if isinstance(node, dict):
                nodes.append(node)
    return nodes, subgraphs


# 메모를 적어두는 노드들. 카드와 상세 창에 그대로 보여준다.
NOTE_TYPES = ("Note", "MarkdownNote", "Note Plus (mtb)", "PrimitiveNode")


def _note_text(node):
    """메모 노드에 적힌 글."""
    if node.get("type") not in NOTE_TYPES:
        return ""
    values = node.get("widgets_values")
    if isinstance(values, dict):
        values = list(values.values())
    if not isinstance(values, list):
        return ""
    parts = [v.strip() for v in values if isinstance(v, str) and v.strip()]
    return "\n".join(parts)[:MAX_NOTE]


def _model_values(node):
    """위젯 값 중 모델 파일처럼 보이는 것."""
    values = node.get("widgets_values")
    if isinstance(values, dict):
        values = list(values.values())
    if not isinstance(values, list):
        return
    for value in values:
        if isinstance(value, str) and value.lower().endswith(MODEL_EXTS):
            yield value.replace("\\", "/")


def summarize(path):
    """워크플로우 하나를 훑어 카드에 쓸 것만 뽑는다.

    깨진 파일이라도 예외를 올리지 않는다. 목록 하나 때문에 창 전체가
    안 뜨면 곤란하다. 대신 broken 을 켜서 화면이 표시하게 한다.
    """
    try:
        stat = os.stat(path)
    except OSError:
        return {"nodes": 0, "models": [], "missing": [], "broken": True, "size": 0, "modified": 0}

    key = (path, int(stat.st_mtime), stat.st_size)
    cached = _SUMMARY_CACHE.get(path)
    if cached and cached[0] == key:
        return cached[1]

    summary = {"nodes": 0, "models": [], "missing": [], "broken": False,
               "size": stat.st_size, "modified": int(stat.st_mtime)}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        summary["broken"] = True
        _SUMMARY_CACHE[path] = (key, summary)
        return summary

    known = _known_types()
    nodes, subgraphs = _walk_nodes(data)
    models = []
    missing = []
    for node in nodes:
        for value in _model_values(node):
            if value not in models:
                models.append(value)
        kind = node.get("type")
        # 끈 노드(NEVER=2, BYPASS=4)는 없어도 실행에 지장이 없다
        if not isinstance(kind, str) or node.get("mode") in (2, 4):
            continue
        if known and kind not in known and kind not in subgraphs and kind not in missing:
            missing.append(kind)

    summary["nodes"] = len(nodes)
    summary["models"] = models[:MAX_MODELS]
    summary["model_count"] = len(models)
    summary["missing"] = sorted(missing)[:MAX_MISSING]
    summary["missing_count"] = len(missing)
    _SUMMARY_CACHE[path] = (key, summary)
    return summary


def library(root, previews=None):
    """workflows 폴더 아래 전부. 하위 폴더까지 훑는다."""
    favorites = _read_favorites()
    items = []
    for folder, dirs, files in os.walk(root):
        # 숨김 폴더는 건너뛴다(.git, .thumbnails 같은 것)
        dirs[:] = [name for name in dirs if not name.startswith(".")]
        for file_name in files:
            if not file_name.lower().endswith(EXTENSIONS) or file_name.startswith("."):
                continue
            path = os.path.join(folder, file_name)
            name = os.path.relpath(path, root).replace(os.sep, "/")
            summary = summarize(path)
            item = {
                "name": name,
                "folder": os.path.dirname(name).replace("\\", "/"),
                "title": os.path.splitext(os.path.basename(name))[0],
                "favorite": name in favorites,
                **summary,
            }
            # 그림이 바뀌면 주소도 바뀌어야 브라우저가 새로 받아온다
            stamp = summary.get("modified", 0)
            item["preview"] = f"/fla/workflow-preview?name={quote(name)}&v={stamp}"
            item["custom_preview"] = bool(previews and user_preview(previews, name))
            # Civitai 에서 받은 것이면 그쪽 대표 이미지도 있다. 카드가 노드
            # 그림과 번갈아 보여준다.
            if previews and cover_preview(previews, name):
                item["cover"] = f"/fla/workflow-preview?name={quote(name)}&which=cover&v={stamp}"
            if previews:
                from . import workflow_store
                info = workflow_store.meta(previews, name)
                if info.get("model_id"):
                    item["source"] = {
                        "model_id": info.get("model_id"),
                        "model_name": info.get("model_name") or "",
                        "version_id": info.get("version_id"),
                        "version_name": info.get("version_name") or "",
                        "creator": info.get("creator") or "",
                    }
                    item["has_base"] = workflow_store.has_base(previews, name)
            items.append(item)
    items.sort(key=lambda item: item["name"].lower())
    return items


# -------------------------------------------------- 라우트


def _bad(message, status=400):
    return web.json_response({"ok": False, "error": message}, status=status)


async def _body(request):
    try:
        return await request.json()
    except Exception:
        return None


@routes.get("/fla/workflow-library")
async def get_workflow_library(request):
    root = root_for(request)
    if root is None:
        # 한 번도 저장한 적이 없으면 폴더 자체가 없다. 빈 목록으로 답한다.
        return web.json_response({"ok": True, "items": [], "root": ""})
    previews = preview_root(request)
    return web.json_response({"ok": True, "items": library(root, previews), "root": root})


@routes.get("/fla/workflow-preview")
async def get_workflow_preview(request):
    """대표 그림. 올려둔 것이 있으면 그것을, 없으면 미니맵을 그려 준다."""
    root = root_for(request)
    name = request.query.get("name", "")
    path = resolve(root, name)
    if path is None:
        raise web.HTTPNotFound()

    store = preview_root(request)
    which = request.query.get("which", "")
    if which == "cover":
        found = cover_preview(store, name)
    elif which == "auto":
        found = auto_preview(preview_root(request, create=True), path)
    else:
        # 기본은 내가 올린 사진 -> 없으면 노드 그림
        found = user_preview(store, name)
        if found is None:
            found = auto_preview(preview_root(request, create=True), path)
    if found is None:
        raise web.HTTPNotFound()
    return web.FileResponse(found)


@routes.post("/fla/workflow-preview-upload")
async def post_workflow_preview_upload(request):
    """결과 사진을 대표 그림으로 삼는다. 올리면 미니맵보다 이쪽이 이긴다."""
    try:
        reader = await request.multipart()
    except Exception:
        return _bad("Bad request")

    name = ""
    blob = None
    ext = ".png"
    while True:
        part = await reader.next()
        if part is None:
            break
        if part.name == "name":
            name = (await part.text()).strip()
        elif part.name == "file":
            candidate = os.path.splitext(part.filename or "")[1].lower()
            if candidate in PREVIEW_EXTS:
                ext = candidate
            blob = await part.read(decode=False)

    root = root_for(request)
    if resolve(root, name) is None:
        return _bad("Workflow not found", 404)
    if not blob:
        return _bad("No file")
    if len(blob) > MAX_PREVIEW_BYTES:
        return _bad("Too large", 413)

    from . import workflow_store
    store = preview_root(request, create=True)
    if not store:
        return _bad("Preview folder not available", 500)
    if workflow_store.write_image(store, workflow_store.SHOT_DIR, name, blob, ext) is None:
        return _bad("Could not save the image", 500)
    return web.json_response({"ok": True})


@routes.post("/fla/workflow-preview-clear")
async def post_workflow_preview_clear(request):
    """올려둔 그림을 지우고 미니맵으로 되돌린다."""
    body = await _body(request)
    if body is None:
        return _bad("Bad request")
    name = body.get("name", "")
    if resolve(root_for(request), name) is None:
        return _bad("Workflow not found", 404)
    dropped = drop_user_preview(preview_root(request), name)
    return web.json_response({"ok": True, "dropped": dropped})


@routes.get("/fla/workflow-detail")
async def get_workflow_detail(request):
    """상세 창에 실을 것 — 노드 종류별 개수, 없는 노드 전부, 쓰는 모델 전부, 메모."""
    root = root_for(request)
    name = request.query.get("name", "")
    path = resolve(root, name)
    if path is None:
        return _bad("Workflow not found", 404)
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        return _bad(str(e), 500)

    known = _known_types()
    nodes, subgraphs = _walk_nodes(data)
    counts = {}
    models = []
    missing = []
    notes = []
    muted = 0
    for node in nodes:
        kind = node.get("type")
        if isinstance(kind, str):
            counts[kind] = counts.get(kind, 0) + 1
        for value in _model_values(node):
            if value not in models:
                models.append(value)
        note = _note_text(node)
        if note:
            notes.append(note)
        if node.get("mode") in (2, 4):
            muted += 1
            continue
        if isinstance(kind, str) and known and kind not in known and kind not in subgraphs \
                and kind not in missing:
            missing.append(kind)

    from . import workflow_store
    groups = [g.get("title") for g in (data.get("groups") or [])
              if isinstance(g, dict) and isinstance(g.get("title"), str)]
    try:
        stat = os.stat(path)
        size, modified = stat.st_size, int(stat.st_mtime)
    except OSError:
        size, modified = 0, 0

    return web.json_response({
        "ok": True,
        "name": name,
        "folder": os.path.dirname(name).replace("\\", "/"),
        "title": os.path.splitext(os.path.basename(name))[0],
        "nodes": len(nodes),
        "muted": muted,
        "subgraphs": len([g for g in subgraphs if g]),
        # 많이 쓴 것부터
        "counts": sorted(counts.items(), key=lambda kv: (-kv[1], kv[0])),
        "missing": sorted(missing),
        "models": models,
        "notes": notes[:12],
        "groups": groups[:30],
        "size": size,
        "modified": modified,
        "custom_preview": bool(user_preview(preview_root(request), name)),
        "has_cover": bool(cover_preview(preview_root(request), name)),
        "source": workflow_store.meta(preview_root(request), name),
        "has_base": workflow_store.has_base(preview_root(request), name),
    })


@routes.get("/fla/workflow-content")
async def get_workflow_content(request):
    """워크플로우 원문. 화면이 이것을 받아 캔버스에 올린다.

    ComfyUI 의 /userdata 로도 받을 수 있지만 경로를 통째로 URL 한 칸에
    욱여넣어야 한다. 폴더 이름에 한글과 빈칸이 섞인 곳에서는 여기가 편하다.
    """
    path = resolve(root_for(request), request.query.get("name", ""))
    if path is None:
        return _bad("Workflow not found", 404)
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        return _bad(str(e), 500)
    return web.json_response({"ok": True, "workflow": data})


@routes.post("/fla/workflow-favorite")
async def post_workflow_favorite(request):
    body = await _body(request)
    if body is None:
        return _bad("Bad request")
    root = root_for(request)
    name = body.get("name", "")
    if resolve(root, name) is None:
        return _bad("Workflow not found", 404)
    try:
        favorite = set_favorite(name, body.get("favorite") is True)
    except OSError as e:
        return _bad(str(e), 500)
    return web.json_response({"ok": True, "favorite": favorite})


@routes.post("/fla/workflow-rename")
async def post_workflow_rename(request):
    """이름을 바꾼다. 폴더를 섞어 넣으면(a/b.json) 그리로 옮긴다."""
    body = await _body(request)
    if body is None:
        return _bad("Bad request")
    root = root_for(request)
    source = resolve(root, body.get("name", ""))
    if source is None:
        return _bad("Workflow not found", 404)

    clean = _safe_name(body.get("new_name", ""))
    if not clean:
        return _bad("Bad name")
    if not clean.lower().endswith(EXTENSIONS):
        clean += ".json"
    target = os.path.join(root, *clean.split("/"))
    if not _inside(target, root):
        return _bad("Bad name")
    if os.path.realpath(target) == os.path.realpath(source):
        return web.json_response({"ok": True, "name": clean})
    if os.path.exists(target):
        return _bad("Already exists", 409)

    try:
        os.makedirs(os.path.dirname(target), exist_ok=True)
        os.replace(source, target)
    except OSError as e:
        return _bad(str(e), 500)

    _SUMMARY_CACHE.pop(source, None)
    old_name = os.path.relpath(source, root).replace(os.sep, "/")
    # 딸린 것(출처·원본·그림)도 새 이름을 따라간다
    from . import workflow_store
    workflow_store.rename(preview_root(request), old_name, clean)
    favorites = _read_favorites()
    if old_name in favorites:
        favorites.discard(old_name)
        favorites.add(clean)
        try:
            _write_favorites(favorites)
        except OSError:
            pass  # 이름은 이미 바뀌었다. 즐겨찾기만 놓친다.
    return web.json_response({"ok": True, "name": clean})


@routes.post("/fla/workflow-delete")
async def post_workflow_delete(request):
    """워크플로우 파일을 지운다. 되돌릴 수 없으므로 화면에서 한 번 더 물어본다."""
    body = await _body(request)
    if body is None:
        return _bad("Bad request")
    root = root_for(request)
    name = body.get("name", "")
    path = resolve(root, name)
    if path is None:
        return _bad("Workflow not found", 404)

    try:
        os.remove(path)
    except OSError as e:
        return _bad(str(e), 500)

    _SUMMARY_CACHE.pop(path, None)
    from . import workflow_store
    workflow_store.forget(preview_root(request), name)
    favorites = _read_favorites()
    if name in favorites:
        favorites.discard(name)
        try:
            _write_favorites(favorites)
        except OSError:
            pass
    return web.json_response({"ok": True, "name": name})


@routes.post("/fla/workflow-reveal")
async def post_workflow_reveal(request):
    """워크플로우가 들어 있는 폴더를 파일 탐색기로 연다.

    서버(ComfyUI 가 도는 PC)에서 열리므로 원격 접속 중이면 소용이 없다.
    """
    body = await _body(request)
    if body is None:
        return _bad("Bad request")
    root = root_for(request)
    if root is None:
        return _bad("folder not found", 404)

    name = body.get("name", "")
    path = resolve(root, name) if name else None
    target = os.path.dirname(path) if path else root
    if not os.path.isdir(target):
        return _bad("folder not found", 404)

    try:
        if sys.platform == "win32":
            if path:
                subprocess.Popen(["explorer", "/select,", os.path.normpath(path)])
            else:
                os.startfile(target)  # noqa: S606
        elif sys.platform == "darwin":
            subprocess.Popen(["open", "-R", path] if path else ["open", target])
        else:
            subprocess.Popen(["xdg-open", target])
    except OSError as e:
        return _bad(str(e), 500)
    return web.json_response({"ok": True, "path": target, "at": int(time.time())})


# -------------------------------------------------- 폴더 자동정리
#
# 워크플로우가 쌓이면 뿌리에 파일만 늘어난다. 무엇을 보고 나누느냐가 문제인데,
# 파일 이름은 못 믿는다("test_2.json").
#
# 처음에는 워크플로우 안의 모든 낱말을 증거로 삼았다. 그건 못 쓴다 —
# "KSampler" 안에 sam 이 들어 있고, 업스케일러는 거의 모든 워크플로우에 있고,
# 플럭스 워크플로우가 텍스트 인코더를 LTX-Video 폴더에서 빌려 쓰기도 한다.
# 그래서 주 모델을 불러오는 노드 하나만 본다. 그 모델이 든 폴더 이름이
# 계열을 거의 그대로 말해준다(SDXL/..., FLUX/..., Wan2.2/...).
#
# 규칙은 셋이다.
#   1. 뿌리에 흩어진 것만 본다. 이미 하위 폴더에 넣어둔 것은 건드리지 않는다.
#   2. 이미 쓰고 있는 폴더로만 보낸다. 새 폴더는 만들자고 하지 않는다.
#   3. 확실하지 않으면 아무 말도 하지 않는다.
# 옮기는 일은 사용자가 확인한 뒤에만 한다.

# 주 모델을 불러오는 노드. 이름에 이 낱말이 있으면 본다.
PRIMARY_LOADERS = ("checkpoint", "unet", "diffusionmodel", "modelloader")
# 다만 이런 것들은 주 모델이 아니다(딸린 모델을 불러오는 노드).
NOT_PRIMARY = ("upscale", "clip", "vae", "controlnet", "lora", "style",
               "ipadapter", "sampler", "audio", "detector", "segm")

# (계열 이름, 모델 경로에서 찾을 낱말, 쓸 만한 폴더 이름 후보)
# 앞에 있는 규칙이 이긴다.
FAMILY_RULES = [
    ("Wan", ("wan2", "wan22", "wan21", "wanvideo"), ("Wan", "Wan2.2", "Wan2.1", "영상", "Video")),
    ("LTX", ("ltx",), ("LTX-Video", "LTXV", "LTX", "영상", "Video")),
    ("Hunyuan", ("hunyuan",), ("Hunyuan", "영상", "Video")),
    ("MiniMax", ("minimax",), ("MiniMax", "영상", "Video")),
    ("Flux", ("flux", "kontext"), ("FLUX", "Flux", "이미지", "Image")),
    ("Qwen", ("qwen",), ("Qwen", "이미지", "Image")),
    ("SDXL", ("sdxl", "illustrious", "pony", "noobai"), ("SDXL", "이미지", "Image")),
    ("SD1.5", ("sd1.5", "sd15", "sd1_5"), ("SD1.5", "SD15", "이미지", "Image")),
]


def _primary_models(path):
    """주 모델 경로들. 딸린 모델(인코더·업스케일러)은 빼고 본다."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return []
    nodes, _ = _walk_nodes(data)
    found = []
    for node in nodes:
        kind = str(node.get("type") or "").lower()
        if not any(word in kind for word in PRIMARY_LOADERS):
            continue
        if any(word in kind for word in NOT_PRIMARY):
            continue
        # 끈 노드는 실제로 안 쓰는 것이다
        if node.get("mode") in (2, 4):
            continue
        found.extend(_model_values(node))
    return found


def family_of(path):
    """계열 이름. 확실하지 않으면 빈 문자열."""
    paths = [value.lower() for value in _primary_models(path)]
    if not paths:
        return ""
    for family, needles, _folders in FAMILY_RULES:
        if any(needle in value for value in paths for needle in needles):
            return family
    return ""


def _pick_folder(family, existing):
    """계열에 맞는, 이미 있는 폴더. 없으면 빈 문자열(새로 만들자고 하지 않는다)."""
    by_leaf = {}
    for folder in existing:
        by_leaf.setdefault(folder.split("/")[-1].lower(), folder)
    for name, _needles, candidates in FAMILY_RULES:
        if name != family:
            continue
        for candidate in candidates:
            found = by_leaf.get(candidate.lower())
            if found:
                return found
    return ""


def organize_plan(root):
    """어디로 옮길지 계획만 세운다. 파일은 건드리지 않는다.

    뿌리에 있는 것만 본다. 하위 폴더에 든 것은 사용자가 일부러 넣은 것이다.
    """
    existing = set()
    loose = []
    for folder, dirs, names_in in os.walk(root):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        rel = os.path.relpath(folder, root).replace(os.sep, "/")
        if rel not in (".", ""):
            existing.add(rel)
            continue  # 하위 폴더 안은 훑기만 하고 대상으로 삼지 않는다
        for file_name in names_in:
            if file_name.lower().endswith(EXTENSIONS) and not file_name.startswith("."):
                loose.append(os.path.join(folder, file_name))

    moves = []
    for path in sorted(loose):
        name = os.path.relpath(path, root).replace(os.sep, "/")
        family = family_of(path)
        if not family:
            continue
        target = _pick_folder(family, existing)
        if not target:
            continue
        moves.append({
            "name": name,
            "title": os.path.splitext(os.path.basename(name))[0],
            "from": "",
            "to": target,
            "family": family,
            "models": _primary_models(path)[:3],
        })
    return moves


@routes.get("/fla/workflow-organize")
async def get_workflow_organize(request):
    """옮길 계획을 보여준다. 여기서는 아무것도 옮기지 않는다."""
    root = root_for(request)
    if root is None:
        return web.json_response({"ok": True, "moves": []})
    return web.json_response({"ok": True, "moves": organize_plan(root)})


@routes.post("/fla/workflow-organize")
async def post_workflow_organize(request):
    """화면에서 고른 것만 옮긴다. names 를 주지 않으면 아무것도 하지 않는다."""
    body = await _body(request)
    if body is None:
        return _bad("Bad request")
    root = root_for(request)
    if root is None:
        return _bad("Workflow folder not found", 404)

    wanted = body.get("moves")
    if not isinstance(wanted, list) or not wanted:
        return _bad("Nothing to move")

    from . import workflow_store
    store = preview_root(request)
    favorites = _read_favorites()
    moved = []
    failed = []
    touched = False
    for entry in wanted:
        if not isinstance(entry, dict):
            continue
        name = entry.get("name", "")
        source = resolve(root, name)
        if source is None:
            failed.append({"name": name, "error": "Workflow not found"})
            continue
        folder = _safe_name(entry.get("to", "")) if entry.get("to") else None
        if not folder:
            failed.append({"name": name, "error": "Bad folder"})
            continue

        target_name = folder + "/" + os.path.basename(name)
        target = os.path.join(root, *target_name.split("/"))
        if not _inside(target, root):
            failed.append({"name": name, "error": "Bad folder"})
            continue
        if os.path.exists(target):
            failed.append({"name": name, "error": "Already exists"})
            continue
        try:
            os.makedirs(os.path.dirname(target), exist_ok=True)
            os.replace(source, target)
        except OSError as e:
            failed.append({"name": name, "error": str(e)})
            continue

        _SUMMARY_CACHE.pop(source, None)
        workflow_store.rename(store, name, target_name)
        if name in favorites:
            favorites.discard(name)
            favorites.add(target_name)
            touched = True
        moved.append({"name": name, "to": target_name})

    if touched:
        try:
            _write_favorites(favorites)
        except OSError:
            pass  # 파일은 이미 옮겼다. 즐겨찾기만 놓친다.
    return web.json_response({"ok": True, "moved": moved, "failed": failed})


# -------------------------------------------------- 새 버전 확인과 합치기
#
# 받아 둔 워크플로우가 어느 글에서 왔는지는 곁다리(meta)에 적혀 있다.
# 그 글을 Civitai 에 물어 지금 최신 버전과 견주면 새 것이 나왔는지 알 수 있다.
#
# 새 버전을 그냥 덮어쓰지 않는다. 내가 고쳐 놓은 프롬프트·로라·수치가
# 날아가기 때문이다. 대신 받았을 때의 원본을 가운데 두고 세 갈래로 합친다
# (workflow_merge 가 한다). 합친 결과도 원본을 덮지 않고 옆에 새 파일로 낸다.

# 새 버전을 받아 임시로 풀어 둘 칸
MERGE_DIR = "incoming"

# 마지막으로 확인한 결과. 관리창이 '새 버전' 딱지를 찍을 때 이것만 읽는다.
# Civitai 를 다시 부르지 않으므로 목록을 열 때마다 느려지지 않는다.
_UPDATE_CACHE = {"items": [], "known": 0, "at": 0}


def sources(store):
    """출처가 적힌 워크플로우를 글(model_id) 별로 묶는다."""
    from . import workflow_store
    if not store:
        return {}
    folder = os.path.join(store, workflow_store.META_DIR)
    if not os.path.isdir(folder):
        return {}
    groups = {}
    for file_name in os.listdir(folder):
        if not file_name.endswith(".json"):
            continue
        try:
            with open(os.path.join(folder, file_name), "r", encoding="utf-8") as f:
                info = json.load(f)
        except (OSError, ValueError):
            continue
        if not isinstance(info, dict) or not info.get("model_id"):
            continue
        groups.setdefault(info["model_id"], []).append((file_name[:-5], info))
    return groups


def _name_for_flat(root, store, flat_name):
    """납작한 이름을 실제 워크플로우 상대 경로로 되돌린다.

    납작하게 만들 때 / 를 __ 로 바꿨다. 되돌릴 때 헷갈릴 수 있으므로
    실제로 있는 파일을 찾아 맞춘다.
    """
    from . import workflow_store
    if not root:
        return None
    for folder, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for file_name in files:
            if not file_name.lower().endswith(EXTENSIONS):
                continue
            name = os.path.relpath(os.path.join(folder, file_name), root).replace(os.sep, "/")
            if workflow_store.flat(name) == flat_name:
                return name
    return None


@routes.get("/fla/workflow-updates")
async def get_workflow_updates(request):
    """받아 둔 워크플로우에 새 버전이 나왔는지 Civitai 에 물어본다.

    글 하나에 워크플로우가 여럿 들어 있는 일이 흔하므로 글 단위로 묻는다.
    """
    from . import civitai, workflow_store

    root = root_for(request)
    store = preview_root(request)
    groups = sources(store)
    if not groups:
        return web.json_response({"ok": True, "items": [], "known": 0})

    key = civitai._api_key()
    items = []
    for model_id, entries in groups.items():
        try:
            model = await civitai.fetch_model(model_id, key)
        except civitai.NotFound:
            continue  # Civitai 에서 내려간 글
        except civitai.CivitaiError as e:
            items.append({"model_id": model_id, "error": str(e),
                          "files": [flat for flat, _info in entries]})
            continue

        versions = model.get("modelVersions") or []
        if not versions:
            continue
        newest = versions[0]
        for flat_name, info in entries:
            if info.get("version_id") == newest.get("id"):
                continue  # 이미 최신
            name = _name_for_flat(root, store, flat_name)
            if name is None:
                continue  # 파일을 지웠거나 이름이 많이 바뀌었다
            items.append({
                "name": name,
                "title": os.path.splitext(os.path.basename(name))[0],
                "model_id": model_id,
                "model_name": model.get("name") or info.get("model_name") or "",
                "creator": (model.get("creator") or {}).get("username") or "",
                "from_version": info.get("version_name") or "",
                "from_version_id": info.get("version_id"),
                "to_version": newest.get("name") or "",
                "to_version_id": newest.get("id"),
                "published": newest.get("publishedAt") or newest.get("createdAt") or "",
                # 원본이 있어야 세 갈래로 합칠 수 있다
                "has_base": workflow_store.has_base(store, name),
            })

    known = sum(len(entries) for entries in groups.values())
    _UPDATE_CACHE.update({"items": items, "known": known, "at": int(time.time())})
    return web.json_response({"ok": True, "items": items, "known": known})


@routes.get("/fla/workflow-updates/cached")
async def get_workflow_updates_cached(request):
    """마지막으로 확인한 결과. Civitai 를 부르지 않는다.

    관리창이 카드에 '새 버전' 딱지를 찍는 데 쓴다. 확인을 한 번도 안 했으면
    빈 목록이 온다(딱지가 안 붙을 뿐 아무 문제 없다).
    """
    return web.json_response({"ok": True, **_UPDATE_CACHE})


async def _fetch_remote(version_id, name):
    """새 버전을 받아 그 안에서 같은 워크플로우를 찾아 온다.

    글 하나에 워크플로우가 여럿이면 이름이 가장 비슷한 것을 고른다.
    """
    import difflib
    import tempfile
    import zipfile

    from . import civitai

    key = civitai._api_key()
    version = await civitai._get_json(f"/model-versions/{version_id}", key)
    primary = civitai._primary_file(version)
    if not primary:
        raise civitai.CivitaiError("받을 파일이 없음")
    url = primary.get("downloadUrl") or version.get("downloadUrl")
    if not url:
        raise civitai.CivitaiError("내려받기 주소가 없음")

    holder = tempfile.mkdtemp(prefix="sm1000-wf-")
    blob = os.path.join(holder, civitai._safe_component(primary.get("name")) or "new.zip")
    try:
        await civitai._stream_to_file(url, key, blob, lambda *_a: None)

        wanted = os.path.basename(name).lower()
        found = {}
        if zipfile.is_zipfile(blob):
            with zipfile.ZipFile(blob) as archive:
                for entry in archive.infolist():
                    if entry.is_dir() or not entry.filename.lower().endswith(".json"):
                        continue
                    try:
                        with archive.open(entry) as f:
                            found[entry.filename] = json.loads(f.read().decode("utf-8"))
                    except (ValueError, UnicodeDecodeError, OSError):
                        continue
        else:
            try:
                with open(blob, "r", encoding="utf-8") as f:
                    found[os.path.basename(blob)] = json.load(f)
            except (OSError, ValueError):
                pass

        if not found:
            raise civitai.CivitaiError("새 버전 안에 워크플로우가 없음")
        pick = difflib.get_close_matches(wanted, [k.lower() for k in found], n=1, cutoff=0.0)
        for candidate, graph in found.items():
            if candidate.lower() == (pick[0] if pick else ""):
                return graph, candidate
        return next(iter(found.values())), next(iter(found))
    finally:
        try:
            for leftover in os.listdir(holder):
                os.remove(os.path.join(holder, leftover))
            os.rmdir(holder)
        except OSError:
            pass


@routes.post("/fla/workflow-merge-preview")
async def post_workflow_merge_preview(request):
    """합치면 어떻게 되는지만 미리 보여준다. 파일은 건드리지 않는다."""
    from . import civitai, workflow_merge, workflow_store

    body = await _body(request)
    if body is None:
        return _bad("Bad request")
    root = root_for(request)
    name = body.get("name", "")
    path = resolve(root, name)
    if path is None:
        return _bad("Workflow not found", 404)
    try:
        version_id = int(body.get("version_id"))
    except (TypeError, ValueError):
        return _bad("Bad version")

    try:
        remote, picked = await _fetch_remote(version_id, name)
    except civitai.CivitaiError as e:
        return _bad(str(e), 502)
    except Exception as e:
        return _bad(repr(e), 502)

    try:
        with open(path, "r", encoding="utf-8") as f:
            local = json.load(f)
    except (OSError, ValueError) as e:
        return _bad(str(e), 500)

    store = preview_root(request)
    base = workflow_store.base_graph(store, name)
    report = workflow_merge.preview(base, local, remote)
    return web.json_response({"ok": True, "report": report, "picked": picked})


@routes.post("/fla/workflow-merge")
async def post_workflow_merge(request):
    """새 버전을 내 것과 합쳐 새 파일로 낸다.

    원본은 그대로 둔다. 합친 결과가 마음에 들면 사용자가 옛 것을 지우면 된다.
    """
    from . import civitai, workflow_merge, workflow_store

    body = await _body(request)
    if body is None:
        return _bad("Bad request")
    root = root_for(request)
    name = body.get("name", "")
    path = resolve(root, name)
    if path is None:
        return _bad("Workflow not found", 404)
    try:
        version_id = int(body.get("version_id"))
    except (TypeError, ValueError):
        return _bad("Bad version")

    try:
        remote, _picked = await _fetch_remote(version_id, name)
    except civitai.CivitaiError as e:
        return _bad(str(e), 502)
    except Exception as e:
        return _bad(repr(e), 502)

    try:
        with open(path, "r", encoding="utf-8") as f:
            local = json.load(f)
    except (OSError, ValueError) as e:
        return _bad(str(e), 500)

    store = preview_root(request, create=True)
    base = workflow_store.base_graph(store, name)
    merged, report = workflow_merge.merge(base, local, remote)

    # 옆에 새 이름으로 낸다. 덮어쓰지 않는다.
    stem, ext = os.path.splitext(name)
    target_name = f"{stem} (합침){ext}"
    index = 2
    while resolve(root, target_name) is not None:
        target_name = f"{stem} (합침 {index}){ext}"
        index += 1
    target = os.path.join(root, *target_name.split("/"))
    if not _inside(target, root):
        return _bad("Bad name")

    try:
        os.makedirs(os.path.dirname(target), exist_ok=True)
        temp = target + ".tmp"
        with open(temp, "w", encoding="utf-8") as f:
            json.dump(merged, f, ensure_ascii=False)
        os.replace(temp, target)
    except OSError as e:
        return _bad(str(e), 500)

    # 합친 것의 출처를 새 버전으로 적고, 새 버전을 다음 머지의 원본으로 남긴다
    info = dict(workflow_store.meta(store, name))
    info["version_id"] = version_id
    info["version_name"] = body.get("to_version") or info.get("version_name") or ""
    info["merged_from"] = name
    info["got_at"] = int(time.time())
    workflow_store.set_meta(store, target_name, info)
    workflow_store.set_base_graph(store, target_name, remote)

    return web.json_response({"ok": True, "name": target_name, "report": report})
