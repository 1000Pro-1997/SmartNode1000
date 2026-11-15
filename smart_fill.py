"""'스마트 모델 넣기' 의 뒷일.

남에게 받은 워크플로우는 모델 이름에 그 사람의 폴더 구조가 박혀 있다.
같은 파일이 내 폴더 어딘가에 있어도 하위 폴더가 다르면 노드는 못 찾는다.
하위 폴더만 다른 것은 화면(fla_smart_fill.js)이 고르는 칸 목록 안에서
바로 고친다. 여기는 화면이 혼자 못 푸는 두 가지를 맡는다.

    locate  이름으로 모든 모델 종류를 뒤져 어느 폴더에 있는지 알려준다.
            노드의 고르는 칸은 제 종류(예: 체크포인트)만 보이기 때문이다.
    move    엉뚱한 종류 폴더에 들어간 파일을 제자리로 옮긴다. VAE 를
            체크포인트 폴더에 넣어 둔 것 같은 경우다. 곁다리(메타데이터·
            대표 그림)도 같이 간다.
"""

import asyncio
import os
import shutil

from aiohttp import web
from server import PromptServer

from . import models

routes = PromptServer.instance.routes

# 한 번에 찾아 줄 파일 이름 수. 워크플로우 하나면 이보다 훨씬 적다.
MAX_NAMES = 300


def _bad(message, status=400):
    return web.json_response({"ok": False, "error": message}, status=status)


def locate(basenames):
    """파일 이름(경로 없이)으로 모든 종류를 뒤진다. {이름: [{kind, name}]}."""
    wanted = {}
    for base in basenames:
        wanted.setdefault(base.lower(), base)
    found = {base: [] for base in basenames}
    for kind in models.KINDS:
        for name in models.names(kind):
            original = wanted.get(os.path.basename(name).lower())
            if original is None:
                continue
            found[original].append({"kind": kind, "name": name.replace(os.sep, "/")})
    return found


@routes.post("/fla/smart-fill/locate")
async def post_smart_fill_locate(request):
    try:
        body = await request.json()
    except Exception:
        return _bad("Bad request")
    names = body.get("names")
    if not isinstance(names, list):
        return _bad("Bad request")
    names = [n for n in names if isinstance(n, str) and n][:MAX_NAMES]
    return web.json_response({"ok": True, "found": locate(names)})


def _move_with_sidecars(full, metadata_path, target):
    """모델 파일과 곁다리를 함께 옮긴다. 곁다리는 놓쳐도 본체는 간다."""
    shutil.move(full, target)
    old_stem = os.path.splitext(full)[0]
    new_stem = os.path.splitext(target)[0]
    sidecars = [metadata_path]
    for ext in models.PREVIEW_EXTS:
        sidecars.append(old_stem + ".preview" + ext)
        sidecars.append(old_stem + ext)
    for sidecar in dict.fromkeys(s for s in sidecars if s):
        if not os.path.isfile(sidecar):
            continue
        try:
            shutil.move(sidecar, new_stem + sidecar[len(old_stem):])
        except OSError:
            pass  # 본체는 이미 옮겼다. 곁다리만 놓친다.


@routes.post("/fla/smart-fill/move")
async def post_smart_fill_move(request):
    """파일 하나를 다른 종류의 폴더로 옮긴다. 어느 종류인지는 화면이 정한다.

    화면은 노드가 어떤 고르는 칸인지 보고 정하므로(체크포인트 로더면
    checkpoints), 서버는 그 판단을 검증하지 않고 경로 안전만 본다.
    """
    try:
        body = await request.json()
    except Exception:
        return _bad("Bad request")
    kind = body.get("kind") or ""
    to_kind = body.get("to_kind") or ""
    if not models.known(kind) or not models.known(to_kind):
        return _bad("Unknown model kind", 404)
    if kind == to_kind:
        return _bad("Same kind")

    full, metadata_path = models.paths(kind, body.get("name") or "")
    if full is None or models.inside_roots(kind, full) is None:
        return _bad("Model not found", 404)

    # 갈 종류에 같은 이름이 벌써 있으면 옮기지 않는다. 두 벌을 만들 뻔한
    # 것이므로, 있는 쪽 이름을 알려주고 화면이 그것을 쓰게 한다.
    base = os.path.basename(full)
    for existing in models.names(to_kind):
        if os.path.basename(existing).lower() == base.lower():
            return web.json_response({"ok": True, "moved": False, "kind": to_kind,
                                      "name": existing.replace(os.sep, "/")})

    from . import civitai, imports

    # 하위 폴더는 파일이 말해주는 기반 모델로 고른다. 가져오기와 같은
    # 규칙이라 어디로 갔는지 짐작하기 쉽다.
    try:
        inside = imports.look_inside(full, os.stat(full))
    except OSError:
        inside = {}
    folder = imports.folder_for(to_kind, inside.get("base_model") or base)
    try:
        target = civitai._resolve_target(folder, base, to_kind)
        # 몇 GB 짜리가 드라이브를 건너면 한참 걸린다. 서버를 잡아두지 않는다.
        await asyncio.to_thread(_move_with_sidecars, full, metadata_path, target)
    except (OSError, civitai.CivitaiError) as e:
        return _bad(str(e), 500)

    models.invalidate(kind)
    models.invalidate(to_kind)
    try:
        civitai.invalidate_installed()
        civitai.invalidate_pending()
    except Exception:
        pass  # Civitai 쪽 캐시가 낡아도 옮기기는 끝났다

    roots = models.roots(to_kind)
    rel = (os.path.relpath(target, roots[0]).replace(os.sep, "/")
           if roots else os.path.basename(target))
    return web.json_response({"ok": True, "moved": True, "kind": to_kind, "name": rel})
