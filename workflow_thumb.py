"""워크플로우 미니맵 — 노드 배치를 작은 그림으로 그린다.

워크플로우에는 대표 이미지가 없다. 파일 이름만 늘어놓으면 어느 것이
무엇인지 알아보기 어렵다. 그래서 JSON 안의 노드 좌표를 그대로 써서
그래프 모양을 축소해 그린다. 캔버스를 캡처하지 않으므로 창을 열지
않아도 되고, 모든 워크플로우에 한꺼번에 생긴다.

사용자가 결과 사진을 직접 올리면 그쪽이 이긴다(workflows.py 가 정한다).
여기서는 그림만 만든다.
"""

import colorsys
import hashlib
import io
import os

# 그려낼 그림 크기. 카드가 3:4 라 거기에 맞춘다.
WIDTH = 420
HEIGHT = 560
MARGIN = 14
# 노드가 이보다 작아지면 점처럼 보인다. 최소 크기를 준다.
MIN_NODE = 3
# 너무 많으면 그리는 데만 오래 걸리고 결과도 뭉갠다
MAX_NODES = 1200

BACKGROUND = (24, 26, 31)
GRID = (34, 38, 45)
LINK = (70, 78, 90)
# 색이 없는 노드에 쓸 기본값
NODE_FILL = (58, 66, 78)
NODE_EDGE = (96, 106, 122)
# 꺼둔 노드(NEVER=2, BYPASS=4)
MUTED_FILL = (44, 46, 52)
MUTED_EDGE = (66, 70, 78)


def _parse_color(text):
    """리트그래프가 쓰는 #rgb / #rrggbb 를 숫자로. 못 읽으면 None."""
    if not isinstance(text, str):
        return None
    value = text.strip().lstrip("#")
    if len(value) == 3:
        value = "".join(ch * 2 for ch in value)
    if len(value) != 6:
        return None
    try:
        return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))
    except ValueError:
        return None


def _lift(rgb, amount=0.28):
    """어두운 노드 색을 조금 띄워 배경과 구별되게 한다."""
    hue, light, sat = colorsys.rgb_to_hls(*[c / 255 for c in rgb])
    light = min(1.0, light + amount)
    return tuple(int(c * 255) for c in colorsys.hls_to_rgb(hue, light, sat))


def _boxes(graph):
    """노드 하나하나의 (x, y, 너비, 높이, 채움, 테두리)."""
    out = []
    for node in (graph.get("nodes") or [])[:MAX_NODES]:
        if not isinstance(node, dict):
            continue
        pos = node.get("pos")
        size = node.get("size")
        # 옛 파일은 {"0": x, "1": y} 꼴로 저장한 것도 있다
        if isinstance(pos, dict):
            pos = [pos.get("0"), pos.get("1")]
        if isinstance(size, dict):
            size = [size.get("0"), size.get("1")]
        if not (isinstance(pos, list) and len(pos) >= 2):
            continue
        try:
            x, y = float(pos[0]), float(pos[1])
        except (TypeError, ValueError):
            continue
        try:
            w = float(size[0]) if isinstance(size, list) and len(size) >= 2 else 200.0
            h = float(size[1]) if isinstance(size, list) and len(size) >= 2 else 80.0
        except (TypeError, ValueError):
            w, h = 200.0, 80.0
        if w <= 0 or h <= 0:
            continue

        muted = node.get("mode") in (2, 4)
        if muted:
            fill, edge = MUTED_FILL, MUTED_EDGE
        else:
            base = _parse_color(node.get("bgcolor")) or _parse_color(node.get("color"))
            fill = _lift(base) if base else NODE_FILL
            edge = _lift(base, 0.45) if base else NODE_EDGE
        # 노드 제목 줄까지 쳐서 조금 높게 잡는다(실제 화면과 비슷하게)
        out.append((x, y - 26, w, h + 26, fill, edge))
    return out


def _links(graph, index):
    """이어진 선. (시작 노드, 끝 노드) 짝으로 준다."""
    pairs = []
    for link in (graph.get("links") or []):
        # [id, 출발노드, 출발칸, 도착노드, 도착칸, 자료형]
        if isinstance(link, list) and len(link) >= 4:
            a, b = link[1], link[3]
            if a in index and b in index:
                pairs.append((index[a], index[b]))
    return pairs


def render(graph):
    """미니맵 PNG 를 바이트로 준다. 그릴 것이 없으면 None."""
    from PIL import Image, ImageDraw

    boxes = _boxes(graph)
    if not boxes:
        return None

    left = min(b[0] for b in boxes)
    top = min(b[1] for b in boxes)
    right = max(b[0] + b[2] for b in boxes)
    bottom = max(b[1] + b[3] for b in boxes)
    span_x = max(right - left, 1.0)
    span_y = max(bottom - top, 1.0)

    # 가로세로 비율을 지키면서 칸 안에 들어가게 줄인다
    scale = min((WIDTH - MARGIN * 2) / span_x, (HEIGHT - MARGIN * 2) / span_y)
    draw_w = span_x * scale
    draw_h = span_y * scale
    off_x = (WIDTH - draw_w) / 2
    off_y = (HEIGHT - draw_h) / 2

    def place(x, y):
        return (off_x + (x - left) * scale, off_y + (y - top) * scale)

    image = Image.new("RGB", (WIDTH, HEIGHT), BACKGROUND)
    pen = ImageDraw.Draw(image)

    # 옅은 눈금. 그냥 검은 바탕보다 그래프처럼 보인다.
    step = 40
    for x in range(0, WIDTH, step):
        pen.line([(x, 0), (x, HEIGHT)], fill=GRID)
    for y in range(0, HEIGHT, step):
        pen.line([(0, y), (WIDTH, y)], fill=GRID)

    # 선을 먼저 깔고 그 위에 노드를 얹는다
    index = {}
    for i, node in enumerate((graph.get("nodes") or [])[:MAX_NODES]):
        if isinstance(node, dict) and node.get("id") is not None and i < len(boxes):
            index[node["id"]] = i
    for a, b in _links(graph, index):
        ax, ay, aw, ah = boxes[a][:4]
        bx, by, bw, bh = boxes[b][:4]
        start = place(ax + aw, ay + ah / 2)
        end = place(bx, by + bh / 2)
        pen.line([start, end], fill=LINK, width=1)

    for x, y, w, h, fill, edge in boxes:
        x0, y0 = place(x, y)
        x1, y1 = place(x + w, y + h)
        if x1 - x0 < MIN_NODE:
            x1 = x0 + MIN_NODE
        if y1 - y0 < MIN_NODE:
            y1 = y0 + MIN_NODE
        pen.rectangle([x0, y0, x1, y1], fill=fill, outline=edge)

    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


def cache_name(path):
    """파일 경로와 수정 시각으로 캐시 이름을 만든다.

    워크플로우를 고치면 이름이 바뀌므로 그림도 새로 그려진다.
    """
    try:
        stat = os.stat(path)
        seed = f"{path}|{int(stat.st_mtime)}|{stat.st_size}"
    except OSError:
        seed = path
    return hashlib.sha256(seed.encode("utf-8")).hexdigest()[:32] + ".png"
