"""워크플로우 세 갈래 머지 — 새 버전을 받되 내가 고친 것은 지킨다.

무엇을 푸는 문제인가.
    받아 둔 워크플로우가 A -> B -> C -> D 였다고 하자. 나는 프롬프트 자리인
    B 를 내 것(B')으로 바꿔 끼웠다. 그 사이 만든 사람은 C 를 e 로 고쳐
    새 버전을 올렸다. 원하는 결과는 A -> B' -> e -> D 다.
    새 버전을 그냥 받으면 B' 이 날아가고, 안 받으면 e 를 못 쓴다.

어떻게 푸는가.
    깃과 같은 방식이다. 공통 조상(받았을 때의 원본)을 두고 세 쪽을 견준다.
        base   받았을 때 그대로
        local  지금 내 파일
        remote 새로 받은 버전
    base 를 알아야 "내가 고친 것"과 "원래 그랬던 것"을 가릴 수 있다.
    base 가 없으면 두 갈래로 물러선다(그때는 짐작이 섞인다고 알려준다).

무엇을 누가 이기는가.
    뼈대(어떤 노드가 있고 어떻게 이어지는가)는 새 버전이 이긴다. 그게
    업그레이드의 알맹이다.
    값(프롬프트 글, 로라 이름과 세기, 체크포인트, 스텝·CFG·시드, 해상도)은
    내 것이 이긴다. 어차피 사람마다 다르게 쓰는 자리다.
    보기(위치·크기·색·제목·접힘·끈 노드)도 내 것이 이긴다.
    내가 새로 붙인 노드는 그대로 가져온다. 이어지던 곳이 사라졌으면
    그 줄만 끊고 무슨 일이 있었는지 적어 둔다.

무엇을 하지 않는가.
    원본을 덮어쓰지 않는다. 합친 결과를 따로 내놓고, 무엇이 어떻게 되었는지
    적어 준다. 눈으로 보고 고를 일이지 말없이 바꿔 놓을 일이 아니다.
"""

import copy

# 값을 내 것으로 지킬 노드. 이름 일부만 맞아도 본다(설치본마다 이름이 다르다).
# 프롬프트·로라·체크포인트·샘플러 수치·해상도가 여기 해당한다.
LOCAL_VALUE_HINTS = (
    "cliptextencode", "textencode", "prompt", "text",
    "lora", "loader", "checkpoint", "unet", "vae", "clip",
    "ksampler", "sampler", "scheduler", "guider", "cfg", "seed", "noise",
    "emptylatent", "latentimage", "resolution", "imagesize", "scale",
    "primitive", "string", "int", "float", "combo",
)
# 위의 낱말이 있어도 값을 지키지 않을 노드. 뼈대에 가까운 것들.
NOT_LOCAL_VALUE = ("reroute", "note", "markdownnote", "preview", "save")

# 보기에 딸린 것. 같은 노드로 이어졌으면 언제나 내 것을 쓴다.
LOOK_KEYS = ("pos", "size", "color", "bgcolor", "title", "flags", "mode", "shape")


def _nodes(graph):
    return [n for n in (graph.get("nodes") or []) if isinstance(n, dict)]


def _by_id(graph):
    return {n.get("id"): n for n in _nodes(graph) if n.get("id") is not None}


def keeps_local_values(node_type):
    """이 노드의 값은 내 것을 지킬까."""
    low = str(node_type or "").lower()
    if any(word in low for word in NOT_LOCAL_VALUE):
        return False
    return any(word in low for word in LOCAL_VALUE_HINTS)


# -------------------------------------------------- 노드 짝짓기


def _signature(node):
    """노드를 알아보는 열쇠들. 앞에 있을수록 믿을 만하다."""
    kind = str(node.get("type") or "")
    title = str(node.get("title") or "")
    order = node.get("order")
    pos = node.get("pos")
    if isinstance(pos, dict):
        pos = [pos.get("0"), pos.get("1")]
    x = y = None
    if isinstance(pos, list) and len(pos) >= 2:
        try:
            x, y = round(float(pos[0])), round(float(pos[1]))
        except (TypeError, ValueError):
            x = y = None
    return kind, title, order, x, y


def _distance(a, b):
    """두 노드가 얼마나 멀리 있나. 못 재면 아주 큰 값."""
    _k1, _t1, _o1, x1, y1 = _signature(a)
    _k2, _t2, _o2, x2, y2 = _signature(b)
    if None in (x1, y1, x2, y2):
        return float("inf")
    return abs(x1 - x2) + abs(y1 - y2)


def match_nodes(left, right):
    """두 그래프의 노드를 짝짓는다. {왼쪽 id: 오른쪽 id}.

    노드 번호는 판이 바뀌면 흔들린다. 그래서 확실한 것부터 차례로 붙인다.
        1. 번호와 종류가 둘 다 같은 것
        2. 종류와 제목이 같은 것(제목은 사람이 붙인 이름이라 잘 안 바뀐다)
        3. 종류만 같은 것 중 자리가 가장 가까운 것
    한 번 짝지어진 노드는 다시 쓰지 않는다.
    """
    pairs = {}
    used = set()
    left_nodes = _nodes(left)
    right_by_id = _by_id(right)

    # 1) 번호 + 종류
    for node in left_nodes:
        nid = node.get("id")
        other = right_by_id.get(nid)
        if other is not None and other.get("type") == node.get("type") and nid not in used:
            pairs[nid] = other.get("id")
            used.add(other.get("id"))

    rest_left = [n for n in left_nodes if n.get("id") not in pairs]
    rest_right = [n for n in _nodes(right) if n.get("id") not in used]

    # 2) 종류 + 제목
    for node in list(rest_left):
        kind, title, _o, _x, _y = _signature(node)
        if not title:
            continue
        for other in rest_right:
            if other.get("id") in used:
                continue
            okind, otitle, _oo, _ox, _oy = _signature(other)
            if kind == okind and title == otitle:
                pairs[node.get("id")] = other.get("id")
                used.add(other.get("id"))
                rest_left.remove(node)
                break

    # 3) 종류가 같은 것 중 가장 가까운 것
    for node in list(rest_left):
        best = None
        best_gap = float("inf")
        for other in rest_right:
            if other.get("id") in used or other.get("type") != node.get("type"):
                continue
            gap = _distance(node, other)
            if gap < best_gap:
                best, best_gap = other, gap
        if best is not None:
            pairs[node.get("id")] = best.get("id")
            used.add(best.get("id"))
            rest_left.remove(node)

    return pairs


# -------------------------------------------------- 값 견주기


def _same_values(a, b):
    return a.get("widgets_values") == b.get("widgets_values")


def _widget_shape(node):
    """값 칸이 몇 개인지. 개수가 달라졌으면 그대로 옮겨 담을 수 없다."""
    values = node.get("widgets_values")
    if isinstance(values, list):
        return len(values)
    if isinstance(values, dict):
        return sorted(values)
    return None


# -------------------------------------------------- 링크 손보기


def _links(graph):
    return [l for l in (graph.get("links") or []) if isinstance(l, list) and len(l) >= 4]


def _next_link_id(graph):
    biggest = 0
    for link in _links(graph):
        try:
            biggest = max(biggest, int(link[0]))
        except (TypeError, ValueError):
            continue
    return biggest + 1


def _next_node_id(graph):
    biggest = 0
    for node in _nodes(graph):
        try:
            biggest = max(biggest, int(node.get("id")))
        except (TypeError, ValueError):
            continue
    return biggest + 1


def _drop_links_to(graph, node_id):
    """이 노드로 드나드는 줄을 걷어낸다."""
    keep = []
    for link in (graph.get("links") or []):
        if isinstance(link, list) and len(link) >= 4 and node_id in (link[1], link[3]):
            continue
        keep.append(link)
    graph["links"] = keep


def _clear_slot_links(node):
    """노드 안쪽에 적힌 연결 표시를 지운다(줄을 새로 이을 때 쓴다)."""
    for slot in (node.get("inputs") or []):
        if isinstance(slot, dict):
            slot["link"] = None
    for slot in (node.get("outputs") or []):
        if isinstance(slot, dict):
            slot["links"] = []


def _rebuild_slots(graph):
    """links 목록을 보고 노드 안쪽 연결 표시를 다시 채운다.

    리트그래프는 두 곳에 같은 정보를 적어 둔다. 한쪽만 고치면 화면에서
    줄이 어긋나 보이므로 마지막에 통째로 다시 맞춘다.
    """
    nodes = _by_id(graph)
    for node in nodes.values():
        _clear_slot_links(node)
    for link in _links(graph):
        _, from_id, from_slot, to_id, to_slot = (link + [None])[:5]
        source = nodes.get(from_id)
        target = nodes.get(to_id)
        if source is not None:
            outputs = source.get("outputs") or []
            if isinstance(from_slot, int) and 0 <= from_slot < len(outputs):
                slot = outputs[from_slot]
                if isinstance(slot, dict):
                    slot.setdefault("links", [])
                    if slot["links"] is None:
                        slot["links"] = []
                    slot["links"].append(link[0])
        if target is not None:
            inputs = target.get("inputs") or []
            if isinstance(to_slot, int) and 0 <= to_slot < len(inputs):
                slot = inputs[to_slot]
                if isinstance(slot, dict):
                    slot["link"] = link[0]


# -------------------------------------------------- 머지


def merge(base, local, remote):
    """세 그래프를 합친다. (합친 그래프, 보고서) 를 준다.

    base 가 None 이면 두 갈래로 물러선다 — 내가 고친 것과 원래 그랬던 것을
    가릴 수 없으므로, 값이 다르면 무조건 내 것을 지킨다.
    """
    two_way = base is None
    merged = copy.deepcopy(remote)
    report = {
        "two_way": two_way,
        "kept_values": [],     # 값을 내 것으로 지킨 노드
        "took_values": [],     # 새 버전 값을 받아들인 노드(내가 안 건드린 자리)
        "kept_look": 0,        # 위치·색을 내 것으로 지킨 노드 수
        "added_upstream": [],  # 새 버전이 새로 넣은 노드
        "removed_upstream": [],  # 새 버전이 뺀 노드(내가 쓰던 것)
        "carried_mine": [],    # 내가 붙였던 노드를 그대로 옮긴 것
        "dropped_links": [],   # 이을 곳이 사라져 끊은 줄
        "shape_changed": [],   # 값 칸 수가 달라져 새 것을 쓴 노드
    }

    local_nodes = _by_id(local)
    merged_nodes = _by_id(merged)
    base_nodes = _by_id(base) if not two_way else {}

    # local -> merged(=remote) 짝짓기
    to_remote = match_nodes(local, merged)
    # local -> base 짝짓기(내가 고쳤는지 보려고)
    to_base = match_nodes(local, base) if not two_way else {}

    for local_id, remote_id in to_remote.items():
        mine = local_nodes.get(local_id)
        theirs = merged_nodes.get(remote_id)
        if mine is None or theirs is None:
            continue

        # 보기는 언제나 내 것
        for key in LOOK_KEYS:
            if key in mine:
                theirs[key] = copy.deepcopy(mine[key])
        report["kept_look"] += 1

        label = mine.get("title") or mine.get("type") or str(local_id)

        # 값은 규칙에 따라
        if _widget_shape(mine) != _widget_shape(theirs):
            # 칸 수가 달라졌으면 옮겨 담을 수 없다. 새 것을 쓰고 알려준다.
            if not _same_values(mine, theirs):
                report["shape_changed"].append(label)
            continue

        if keeps_local_values(theirs.get("type")):
            theirs["widgets_values"] = copy.deepcopy(mine.get("widgets_values"))
            if not two_way:
                origin = base_nodes.get(to_base.get(local_id))
                touched = origin is None or not _same_values(mine, origin)
            else:
                touched = True
            if touched:
                report["kept_values"].append(label)
            continue

        # 값 자리가 아닌 노드 — 내가 건드렸을 때만 지킨다
        if two_way:
            if not _same_values(mine, theirs):
                theirs["widgets_values"] = copy.deepcopy(mine.get("widgets_values"))
                report["kept_values"].append(label)
            continue

        origin = base_nodes.get(to_base.get(local_id))
        if origin is not None and not _same_values(mine, origin):
            # 내가 고쳤다 -> 내 것
            theirs["widgets_values"] = copy.deepcopy(mine.get("widgets_values"))
            report["kept_values"].append(label)
        elif not _same_values(theirs, origin if origin is not None else mine):
            report["took_values"].append(label)

    # 새 버전이 넣거나 뺀 노드
    matched_remote = set(to_remote.values())
    for node in _nodes(merged):
        if node.get("id") not in matched_remote:
            report["added_upstream"].append(node.get("title") or node.get("type") or "")

    # 내가 붙였던 노드 옮기기 — base 에 없고 remote 에서도 짝을 못 찾은 것
    carried = {}
    next_node = _next_node_id(merged)
    next_link = _next_link_id(merged)
    for local_id, mine in local_nodes.items():
        if local_id in to_remote:
            continue
        if not two_way and local_id in to_base:
            # base 에 있었는데 새 버전에서 사라졌다 -> 만든 사람이 뺀 것
            report["removed_upstream"].append(mine.get("title") or mine.get("type") or "")
            continue
        copied = copy.deepcopy(mine)
        copied["id"] = next_node
        carried[local_id] = next_node
        next_node += 1
        merged.setdefault("nodes", []).append(copied)
        report["carried_mine"].append(mine.get("title") or mine.get("type") or "")

    # 옮겨온 노드의 줄 잇기
    if carried:
        for link in _links(local):
            link_id, from_id, from_slot, to_id, to_slot = (link + [None])[:5]
            if from_id not in carried and to_id not in carried:
                continue
            new_from = carried.get(from_id, to_remote.get(from_id))
            new_to = carried.get(to_id, to_remote.get(to_id))
            if new_from is None or new_to is None:
                # 한쪽 끝이 사라졌다. 줄만 끊고 적어 둔다.
                missing = local_nodes.get(from_id if new_from is None else to_id, {})
                report["dropped_links"].append(missing.get("title") or missing.get("type") or "")
                continue
            merged.setdefault("links", []).append(
                [next_link, new_from, from_slot, new_to, to_slot,
                 link[5] if len(link) > 5 else None])
            next_link += 1

        # 옮겨온 노드로 들어가는 자리에 이미 새 버전 줄이 꽂혀 있으면 겹친다.
        # 나중에 넣은 것(내 것)이 이기도록 같은 도착 자리의 옛 줄을 걷어낸다.
        seen = {}
        keep = []
        for link in reversed(merged.get("links") or []):
            if not (isinstance(link, list) and len(link) >= 5):
                keep.append(link)
                continue
            slot_key = (link[3], link[4])
            if slot_key in seen:
                continue
            seen[slot_key] = True
            keep.append(link)
        merged["links"] = list(reversed(keep))

    _rebuild_slots(merged)

    # 마지막 링크 번호를 맞춰 둔다(리트그래프가 다음 번호를 여기서 읽는다)
    merged["last_link_id"] = max([0] + [l[0] for l in _links(merged) if isinstance(l[0], int)])
    merged["last_node_id"] = max([0] + [n["id"] for n in _nodes(merged) if isinstance(n.get("id"), int)])

    # 보고서는 길면 읽지 않는다. 앞의 것만 남긴다.
    for key in ("kept_values", "took_values", "added_upstream", "removed_upstream",
                "carried_mine", "dropped_links", "shape_changed"):
        report[key + "_count"] = len(report[key])
        report[key] = report[key][:20]

    return merged, report


def preview(base, local, remote):
    """합치지 않고 무슨 일이 일어날지만 알려준다."""
    _merged, report = merge(base, local, remote)
    return report
