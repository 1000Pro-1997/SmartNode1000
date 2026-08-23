"""워크플로우에 딸린 것들을 두는 자리.

워크플로우 폴더 안에는 .json 만 있어야 한다. ComfyUI 가 그 폴더를 통째로
훑어 목록을 만들기 때문에, 그림이나 메모를 같이 넣으면 워크플로우인 척
끼어 보인다. 그래서 형제 폴더를 하나 만들어 거기에 모은다.

    user/<사용자>/sm1000_workflows/
        meta/<납작한이름>.json    어디서 받았는지, 어느 버전인지
        base/<납작한이름>.json    받았을 때 그대로의 원본
        shot/<납작한이름>.<확장자> 사용자가 올린 사진
        cover/<납작한이름>.<확장자> Civitai 대표 이미지
        auto/<해시>.png            노드 배치를 그린 미니맵(캐시)

base 가 이 파일의 존재 이유에 가깝다. 새 버전을 합칠 때(머지) 무엇이
사용자가 고친 것이고 무엇이 원래 그랬던 것인지 가리려면, 받았을 때의
모습을 알아야 한다. 깃이 세 갈래 머지를 할 때 공통 조상을 보는 것과 같다.
"""

import json
import os

from server import PromptServer

ROOT_DIRNAME = "sm1000_workflows"
META_DIR = "meta"
BASE_DIR = "base"
SHOT_DIR = "shot"
COVER_DIR = "cover"
AUTO_DIR = "auto"

IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".gif")

# 예전 판이 쓰던 자리. 미니맵 캐시만 들어 있어서 그냥 두면 된다.
LEGACY_DIRNAME = "sm1000_workflow_previews"


def root(request, create=False):
    """곁다리 뿌리 폴더. 사용자를 여럿 쓰는 설정도 제 폴더를 보게 한다."""
    manager = getattr(PromptServer.instance, "user_manager", None)
    if manager is None:
        return None
    try:
        path = manager.get_request_user_filepath(request, ROOT_DIRNAME, create_dir=create)
    except Exception:
        # 받기는 요청 없이 뒤에서 돈다. 그때는 기본 사용자 자리로 물러선다.
        try:
            import folder_paths
            path = os.path.join(folder_paths.get_user_directory(), "default", ROOT_DIRNAME)
        except Exception:
            return None
    if path and create:
        try:
            os.makedirs(path, exist_ok=True)
        except OSError:
            return None
    return path


def flat(name):
    """워크플로우 상대 경로를 파일 하나로 눌러 담을 이름으로."""
    return name.replace("/", "__").rsplit(".", 1)[0]


def _dir(base_root, part, create=False):
    if not base_root:
        return None
    path = os.path.join(base_root, part)
    if create:
        try:
            os.makedirs(path, exist_ok=True)
        except OSError:
            return None
    return path


def _find(base_root, part, name, exts):
    folder = _dir(base_root, part)
    if not folder or not os.path.isdir(folder):
        return None
    stem = os.path.join(folder, flat(name))
    for ext in exts:
        if os.path.isfile(stem + ext):
            return stem + ext
    return None


# -------------------------------------------------- 그림


def shot_path(base_root, name):
    """사용자가 올린 사진."""
    return _find(base_root, SHOT_DIR, name, IMAGE_EXTS)


def cover_path(base_root, name):
    """받을 때 같이 가져온 Civitai 대표 이미지."""
    return _find(base_root, COVER_DIR, name, IMAGE_EXTS)


def write_image(base_root, part, name, blob, ext):
    """그림 하나를 갈아 끼운다. 확장자가 바뀔 수 있어 예전 것은 지운다."""
    folder = _dir(base_root, part, create=True)
    if not folder:
        return None
    stem = os.path.join(folder, flat(name))
    for old in IMAGE_EXTS:
        if os.path.isfile(stem + old):
            try:
                os.remove(stem + old)
            except OSError:
                pass
    target = stem + ext
    try:
        with open(target, "wb") as f:
            f.write(blob)
    except OSError:
        return None
    return target


def drop_image(base_root, part, name):
    found = _find(base_root, part, name, IMAGE_EXTS)
    if not found:
        return False
    try:
        os.remove(found)
    except OSError:
        return False
    return True


# -------------------------------------------------- 정보와 원본


def _json_path(base_root, part, name, create=False):
    folder = _dir(base_root, part, create=create)
    return os.path.join(folder, flat(name) + ".json") if folder else None


def read_json(base_root, part, name):
    path = _json_path(base_root, part, name)
    if not path or not os.path.isfile(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def write_json(base_root, part, name, data):
    """원자적으로 쓴다. 쓰다 죽어도 기존 파일이 깨지지 않는다."""
    path = _json_path(base_root, part, name, create=True)
    if not path:
        return None
    temp = path + ".tmp"
    try:
        with open(temp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
        os.replace(temp, path)
    except OSError:
        return None
    return path


def meta(base_root, name):
    """어디서 받았는지. 받은 적이 없으면 빈 사전."""
    return read_json(base_root, META_DIR, name) or {}


def set_meta(base_root, name, data):
    return write_json(base_root, META_DIR, name, data)


def base_graph(base_root, name):
    """받았을 때 그대로의 원본. 없으면 None(그러면 세 갈래 머지를 못 한다)."""
    return read_json(base_root, BASE_DIR, name)


def set_base_graph(base_root, name, graph):
    return write_json(base_root, BASE_DIR, name, graph)


def has_base(base_root, name):
    path = _json_path(base_root, BASE_DIR, name)
    return bool(path and os.path.isfile(path))


# -------------------------------------------------- 이름이 바뀌거나 지워질 때


def _all_parts():
    return ((META_DIR, (".json",)), (BASE_DIR, (".json",)),
            (SHOT_DIR, IMAGE_EXTS), (COVER_DIR, IMAGE_EXTS))


def rename(base_root, old_name, new_name):
    """워크플로우 이름이 바뀌면 딸린 것도 따라 옮긴다."""
    if not base_root:
        return
    for part, exts in _all_parts():
        found = _find(base_root, part, old_name, exts)
        if not found:
            continue
        target = os.path.join(os.path.dirname(found), flat(new_name) + os.path.splitext(found)[1])
        try:
            os.replace(found, target)
        except OSError:
            pass  # 본체는 이미 옮겼다. 곁다리만 놓친다.


def forget(base_root, name):
    """워크플로우를 지우면 딸린 것도 같이 지운다."""
    if not base_root:
        return
    for part, exts in _all_parts():
        found = _find(base_root, part, name, exts)
        if not found:
            continue
        try:
            os.remove(found)
        except OSError:
            pass
