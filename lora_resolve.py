"""로라 다시 잇기 — 워크플로에 적힌 경로를 내 폴더의 파일로 다시 맞춘다.

워크플로에 적힌 로라 경로는 그것을 만든 사람의 폴더 구조를 따른다. 남의
워크플로를 받아 열거나 내가 로라를 다른 폴더로 옮기면, 같은 파일을 가지고
있어도 경로가 달라 연결이 끊긴다. 여기서는 적힌 경로를 지금 내 폴더에 있는
실제 파일로 다시 맞춘다. 파일을 옮기거나 지우지는 않는다.

찾는 순서 — 확실한 것부터.

1. 적힌 경로 그대로 있으면 그대로 둔다.
2. 파일 이름이 같은 것 — 폴더만 다른 흔한 경우. 대소문자는 무시한다.
3. 확장자를 뺀 이름이 같은 것 — .safetensors 를 .ckpt 로 다시 받은 경우.
4. 이름을 글자·숫자·갈래로 나눠 견줘 사실상 같은 것 — 파일 이름만 다르게
   붙여 둔 경우(civitai_updates 의 이름 비교를 그대로 쓴다).
5. 같은 이름의 더 높은 번호 — 원본이 아예 없을 때만. 상위 버전으로 넣고
   그렇다고 알려 준다.

어느 것에도 걸리지 않으면 못 찾은 것으로 두고 경로를 건드리지 않는다.
엉뚱한 로라를 물려 놓느니 끊긴 채로 두는 편이 낫다.
"""

import os

from aiohttp import web
from server import PromptServer

import folder_paths

from .api import _load_metadata, _metadata_path
from .civitai_updates import compare_parsed, parse_name, same_words

routes = PromptServer.instance.routes


def _norm(path):
    """경로를 견줄 수 있는 꼴로. 슬래시와 대소문자 차이를 지운다."""
    return str(path or "").replace("\\", "/").strip().lower()


def _same_model(a, b):
    """나눠 둔 두 이름이 번호까지 사실상 같은지."""
    return a[2] == b[2] and a[1] == b[1] and same_words(a[0], b[0])


def _forms(name):
    """이 파일을 가리킬 수 있는 이름들을 나눠 둔다.

    파일 이름이 정본이지만, Civitai 정보가 있으면 "모델 이름 + 버전 이름" 도
    같이 본다. 받아서 파일 이름만 자기 식으로 바꿔 둔 경우를 잡으려고 그런다.
    """
    stem = os.path.splitext(os.path.basename(name))[0]
    forms = [parse_name(stem)]

    _, metadata_path = _metadata_path(name)
    metadata = _load_metadata(metadata_path)
    block = metadata.get("civitai") or {}
    title = metadata.get("model_name") or (block.get("model") or {}).get("name") or ""
    label = " ".join(part for part in (title, block.get("name") or "") if part)
    if label:
        parsed = parse_name(label)
        if parsed not in forms:
            forms.append(parsed)
    return forms


class _Index:
    """가진 로라를 찾아보기 좋게 정리해 둔다."""

    def __init__(self):
        self.exact = {}      # 다듬은 전체 경로 -> 실제 이름
        self.by_base = {}    # 소문자 파일 이름 -> 실제 이름
        self.by_stem = {}    # 확장자 뺀 소문자 이름 -> 실제 이름
        for name in folder_paths.get_filename_list("loras"):
            base = os.path.basename(name).lower()
            self.exact.setdefault(_norm(name), name)
            self.by_base.setdefault(base, name)
            self.by_stem.setdefault(os.path.splitext(base)[0], name)
        self._parsed = None

    @property
    def parsed(self):
        """이름을 나눈 목록. 나누는 일이 무거우므로 쓸 때 만든다."""
        if self._parsed is None:
            self._parsed = [
                {"name": name, "forms": _forms(name)}
                for name in folder_paths.get_filename_list("loras")
            ]
        return self._parsed


def _hit(path, name, status="moved"):
    """찾았다는 답 하나. 적힌 것과 글자까지 같을 때만 "그대로" 다.

    대소문자나 슬래시만 달라도 바꿔 준다. 노드가 파일을 찾을 때
    쓰는 이름은 대소문자를 가리므로, 그대로 두면 끊긴 채로 남는다.
    """
    return {"path": path, "status": "ok" if name == path else status,
            "name": name, "from_ver": "", "to_ver": ""}


def resolve_one(path, index):
    """경로 하나를 지금 있는 파일로 맞춘다."""
    norm = _norm(path)

    found = index.exact.get(norm)
    if found:
        return _hit(path, found)

    base = norm.split("/")[-1]
    found = index.by_base.get(base)
    if found:
        return _hit(path, found)

    stem = os.path.splitext(base)[0]
    found = index.by_stem.get(stem)
    if found:
        return _hit(path, found)

    # 여기부터는 이름을 뜯어 견준다.
    want = parse_name(stem)
    if not want[0] and not want[1]:
        return {"path": path, "status": "missing", "name": "",
                "from_ver": "", "to_ver": ""}

    upgrades = []
    for entry in index.parsed:
        # 한 파일을 가리키는 이름이 여럿이면(파일 이름 · 모델 이름) 모두 본다.
        # 같은 것이 하나라도 있으면 상위 버전보다 앞선다.
        upgrade = None
        for form in entry["forms"]:
            if _same_model(want, form):
                return _hit(path, entry["name"])
            if upgrade is None:
                step = compare_parsed(want, form)
                if step is not None:
                    upgrade = (form[1], entry["name"], step)
        if upgrade is not None:
            upgrades.append(upgrade)

    if upgrades:
        # 여러 개면 제일 높은 번호로. 상위 버전은 마지못해 고르는 짝이므로
        # 어느 것을 골랐는지 화면에서 밝힌다.
        upgrades.sort(key=lambda u: u[0], reverse=True)
        _, name, step = upgrades[0]
        return {"path": path, "status": "upgraded", "name": name,
                "from_ver": step[0], "to_ver": step[1]}

    return {"path": path, "status": "missing", "name": "",
            "from_ver": "", "to_ver": ""}


@routes.post("/fla/lora-resolve")
async def post_lora_resolve(request):
    """적힌 로라 경로들을 지금 있는 파일로 맞춰 돌려준다.

    고르는 일만 한다. 노드에 넣는 것은 화면 쪽이 한다.
    """
    try:
        body = await request.json()
    except ValueError:
        body = {}

    paths = body.get("paths")
    if not isinstance(paths, list):
        return web.json_response({"ok": False, "error": "Bad request"}, status=400)

    wanted = [p for p in paths if isinstance(p, str) and p.strip()]
    index = _Index()
    return web.json_response({
        "ok": True,
        "results": [resolve_one(path, index) for path in wanted],
    })
