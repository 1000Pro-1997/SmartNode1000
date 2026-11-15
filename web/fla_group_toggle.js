/** SN1000 그룹 토글 — 캔버스의 그룹을 통째로 바이패스하거나 끄는 체크리스트.
 *
 *  항목 하나가 "어느 그룹을(이름 또는 색), 어떻게(바이패스·끄기)" 를 적어 둔다.
 *  줄을 누르면 그 그룹 안의 모든 노드가 그 상태가 되고, 다시 누르면 정상으로
 *  돌아온다.
 *
 *  토글의 켜짐·꺼짐은 저장하지 않는다. 매번 캔버스를 읽어서 정한다 —
 *  그룹 안 노드가 전부 그 상태면 켜짐, 전부 정상이면 꺼짐, 섞여 있으면
 *  노란색(일부만). 그래서 사람이 손으로 그룹을 바이패스해도, 다른 항목이
 *  같은 그룹을 건드려도 이 줄은 저절로 맞는 상태를 보여준다.
 *
 *  항목은 모두 "토글 그룹" 상자 안에 산다. 처음에는 기본 그룹 하나뿐이고,
 *  그룹마다 "여러 개 선택"(마음대로) 또는 "1개만 선택"(하나를 켜면 나머지는
 *  꺼짐) 을 고르고 상자 색을 붙일 수 있다.
 *
 *  저장 모양(items_data):
 *    { "groups": [{ name, mode: "multi"|"single", color }],
 *      "items":  [{ title, by, name, match, color, action, group }] }
 *  옛 모양(항목 배열만, radio 필드)도 읽는다.
 */
import { app } from "../../scripts/app.js";
import { t } from "./fla_i18n.js";
import { mouseGate, dropCaptureFor, guardNodeWidgets, releaseWidgetCaptureSoon } from "./fla_widget_mouse.js";
import { hitColors, hitText } from "./fla_hit.js";
import {
    ROW_HEIGHT, LAYOUT_PAD, findWidget, drawRoundedRect,
    fitText, inBounds, notify, pickFromList,
} from "./fla_lora_ui.js";
import { makeInputWidget, makeButtonRow, makePanelBox, PANEL_COLORS } from "./fla_panel_ui.js";

const NODE_NAME = "SN1000GroupToggle";

// 노드 실행 모드. 프론트엔드의 LGraphEventMode 와 같은 값이다.
const MODE = { ALWAYS: 0, NEVER: 2, BYPASS: 4 };

// 구역별 색.
const COLORS = {
    header: "#2b3b4a",      // 머리글 줄
    headerEdge: "#3f5a70",
    on: "#2a3a2c",          // 켜진 항목(그룹이 전부 그 상태)
    onEdge: "#3f6146",
    off: "#2a2a2a",         // 꺼진 항목(그룹이 전부 정상)
    offEdge: "#3a3a3a",
    mixed: "#4a3d1a",       // 일부만 그 상태
    mixedEdge: "#b58b2a",
    action: "#4a3a2a",      // 추가 버튼
    options: "#3a4a6a",     // 옵션 — 파랑
    choice: "#3a4a6a",      // 고른 선택지
    choiceEdge: "#6a8ac0",
    plain: "#2f343a",       // 고르지 않은 선택지
    plainEdge: "#444b55",
    danger: "#5e2f2f",      // 삭제
    bypass: "#4a2f5e",      // 바이패스 — 보라(프론트엔드가 바이패스 노드를 칠하는 색 계열)
    bypassEdge: "#8a4fb0",
    mute: "#4b4b4b",        // 끄기 — 회색
    muteEdge: "#8c8c8c",
    single: "#5a3a1a",      // 1개만 선택 배지 — 주황
    singleEdge: "#b5732a",
    multi: "#33445a",       // 여러 개 선택 배지 — 파랑
    multiEdge: "#5a7ab0",
};

// 색을 안 정한 토글 그룹 상자. 설정 패널보다 조금 어둡고, 패널이 그 안에 들어간다.
const GROUP_BOX = {
    panel: "#1e2329",
    panelEdge: "#3f5a70",
};

// ─────────── 색 ───────────

// 프론트엔드가 그룹에 붙일 수 있는 이름 있는 색들. 순서가 곧 견본 순서다.
const COLOR_KEYS = ["red", "brown", "green", "blue", "pale_blue", "cyan", "purple", "yellow", "black"];
// LGraphCanvas.node_colors 를 못 읽을 때 쓸 값(프론트엔드 1.48 기준).
const FALLBACK_GROUP_COLORS = {
    red: "#A88", brown: "#b06634", green: "#8A8", blue: "#88A", pale_blue: "#3f789e",
    cyan: "#8AA", purple: "#a1309b", yellow: "#b58b2a", black: "#444",
};

/** "#A88" 도 "#aa8888" 도 같은 색으로 견줄 수 있게 소문자 여섯 자리로 맞춘다. */
function normalizeColor(raw) {
    let s = String(raw ?? "").trim().toLowerCase();
    if (!s) return "";
    if (!s.startsWith("#")) s = "#" + s;
    if (/^#[0-9a-f]{3}$/.test(s)) s = `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
    return s;
}

/** 색을 target(0=검정, 255=흰색) 쪽으로 amount 만큼 섞는다.
 *  상자 바탕(어둡게)과 제목 글자(밝게)에 쓴다. */
function mix(hex, target, amount) {
    const m = /^#([0-9a-f]{6})$/i.exec(hex);
    if (!m) return hex;
    const channels = [0, 2, 4].map((i) => {
        const v = parseInt(m[1].slice(i, i + 2), 16);
        return Math.round(v + (target - v) * amount);
    });
    return "#" + channels.map((v) => v.toString(16).padStart(2, "0")).join("");
}

/** 색을 지우면 프론트엔드가 그리는 기본색. */
function defaultGroupColor() {
    return normalizeColor(globalThis.LGraphGroup?.defaultColour ?? "#335");
}

function groupColor(group) {
    return normalizeColor(group?.color) || defaultGroupColor();
}

/** 이름 붙은 색 목록. 프론트엔드 표에서 읽되, 없으면 알려진 값을 쓴다. */
function namedColors() {
    const table = globalThis.LGraphCanvas?.node_colors ?? {};
    return COLOR_KEYS.map((key) => ({
        key,
        hex: normalizeColor(table[key]?.groupcolor ?? FALLBACK_GROUP_COLORS[key]),
        label: t("gtColor_" + key),
    }));
}

function colorLabel(hex) {
    const found = namedColors().find((c) => c.hex === hex);
    if (found) return found.label;
    if (hex === defaultGroupColor()) return t("gtDefaultColor");
    return hex;
}

/** 색 견본: 이름 붙은 아홉 색 + 지금 캔버스의 그룹이 쓰는 다른 색. */
function palette(node) {
    const list = namedColors();
    const seen = new Set(list.map((c) => c.hex));
    for (const group of graphGroups(node)) {
        const hex = groupColor(group);
        if (seen.has(hex)) continue;
        seen.add(hex);
        list.push({ key: hex, hex, label: colorLabel(hex) });
    }
    return list;
}

// ─────────── 그래프 ───────────

/** 이 노드가 놓인 그래프의 그룹들. 서브그래프 안이면 그 안의 그룹이다. */
function graphGroups(node) {
    const graph = node.graph ?? app.graph;
    const groups = graph?.groups ?? graph?._groups ?? [];
    return Array.isArray(groups) ? groups : [...groups];
}

// ─────────── 데이터 ───────────

/** 항목 하나를 새로 만든다. 기본 그룹에 들어간다. */
function newItem() {
    return { title: "", by: "name", name: "", match: "exact", color: "", action: "bypass", group: "" };
}

/** 토글 그룹 하나를 새로 만든다. 이름이 비면 기본 그룹이다. */
function newGroup(name) {
    return { name, mode: "multi", color: "" };
}

function normalizeGroup(raw) {
    if (!raw || typeof raw !== "object") return null;
    return {
        name: typeof raw.name === "string" ? raw.name.trim() : "",
        mode: raw.mode === "single" ? "single" : "multi",
        color: normalizeColor(raw.color),
    };
}

/** 저장본을 정리한다. 옛 모양(항목 배열, radio 필드)도 받는다.
 *  기본 그룹은 늘 맨 앞에 있고, 항목이 가리키는 그룹은 반드시 존재한다. */
function normalizeData(raw) {
    let rawItems = [];
    let rawGroups = [];
    if (Array.isArray(raw)) {
        rawItems = raw;
    } else if (raw && typeof raw === "object") {
        rawItems = Array.isArray(raw.items) ? raw.items : [];
        rawGroups = Array.isArray(raw.groups) ? raw.groups : [];
    }

    const groups = [newGroup("")];
    const byName = new Map([["", groups[0]]]);
    const ensureGroup = (group) => {
        const have = byName.get(group.name);
        if (have) {
            // 같은 이름이 또 오면(기본 그룹 포함) 모드·색은 나중 것이 이긴다
            have.mode = group.mode;
            have.color = group.color;
            return have;
        }
        groups.push(group);
        byName.set(group.name, group);
        return group;
    };
    for (const g of rawGroups) {
        const group = normalizeGroup(g);
        if (group) ensureGroup(group);
    }

    const items = rawItems
        .filter((it) => it && typeof it === "object")
        .map((it) => {
            // 옛 radio 는 "1개만 선택" 그룹이었다
            const legacyRadio = typeof it.radio === "string" ? it.radio.trim() : "";
            const group = typeof it.group === "string" ? it.group.trim() : legacyRadio;
            if (group && !byName.has(group)) {
                ensureGroup({ name: group, mode: legacyRadio ? "single" : "multi", color: "" });
            }
            return {
                title: typeof it.title === "string" ? it.title : "",
                by: it.by === "color" ? "color" : "name",
                name: typeof it.name === "string" ? it.name : "",
                match: it.match === "contains" ? "contains" : "exact",
                color: normalizeColor(it.color),
                action: it.action === "mute" ? "mute" : "bypass",
                group,
            };
        });
    return { groups, items };
}

/** items_data 위젯에 들어 있는 저장본을 읽는다. 없거나 깨졌으면 빈 상태. */
function readData(node) {
    const raw = node.flaHidden?.items_data?.value
        ?? findWidget(node, "items_data")?.value;
    if (typeof raw !== "string" || !raw.trim()) return normalizeData(null);
    try {
        return normalizeData(JSON.parse(raw));
    } catch (e) {
        return normalizeData(null);
    }
}

/** 파이썬 위젯(워크플로 저장본)을 갱신한다. */
function syncHidden(node) {
    if (node.flaHidden?.items_data) {
        node.flaHidden.items_data.value = JSON.stringify({
            groups: node.flaGroups ?? [],
            items: node.flaItems ?? [],
        });
    }
}

/** 항목이 든 토글 그룹. 없는 그룹을 가리키면 기본 그룹으로 본다. */
function groupOf(node, item) {
    const groups = node.flaGroups ?? [];
    return groups.find((g) => g.name === item.group) ?? groups[0];
}

function isDefaultGroup(group) {
    return !group.name;
}

function groupLabel(group) {
    return group.name || t("gtDefaultGroup");
}

/** 토글 그룹마다 든 항목 번호. 기본 그룹이 맨 앞, 나머지는 만든 순서. */
function layoutGroups(node) {
    const groups = node.flaGroups ?? [];
    const buckets = groups.map((group) => ({ group, idxs: [] }));
    const at = new Map(groups.map((g, i) => [g.name, i]));
    (node.flaItems ?? []).forEach((item, idx) => {
        buckets[at.get(item.group) ?? 0].idxs.push(idx);
    });
    return buckets;
}

/** 항목 제목이 비었을 때 필터 내용으로 대신 보여준다. */
function itemLabel(item) {
    const title = (item.title ?? "").trim();
    if (title) return title;
    if (item.by === "color") {
        return item.color ? t("gtColorGroup", colorLabel(item.color)) : t("untitledItem");
    }
    const name = (item.name ?? "").trim();
    return name || t("untitledItem");
}

// ─────────── 상태 ───────────

/** 이 항목이 노드에 줄 모드. */
function actionMode(item) {
    return item.action === "mute" ? MODE.NEVER : MODE.BYPASS;
}

/** 이 항목이 가리키는 그룹들. 이름은 대소문자를 무시하고,
 *  "정확히 일치" 는 제목 전체가, "부분 일치" 는 일부가 같으면 맞는 것으로 본다. */
function matchedGroups(node, item) {
    const groups = graphGroups(node);
    if (item.by === "color") {
        if (!item.color) return [];
        return groups.filter((g) => groupColor(g) === item.color);
    }
    const needle = (item.name ?? "").trim().toLowerCase();
    if (!needle) return [];
    if (item.match === "contains") {
        return groups.filter((g) => String(g.title ?? "").toLowerCase().includes(needle));
    }
    return groups.filter((g) => String(g.title ?? "").trim().toLowerCase() === needle);
}

/** 그룹들 안에 있는 노드. 이 노드 자신은 뺀다(스스로를 끄면 곤란하다). */
function nodesInside(node, groups) {
    const found = new Set();
    for (const group of groups) {
        // 노드가 그룹 안으로 옮겨져도 그룹은 스스로 목록을 갱신하지 않는다.
        // 프론트엔드의 그룹 메뉴가 하듯 매번 다시 세어 달라고 한다.
        try {
            group.recomputeInsideNodes?.();
        } catch (e) {
            // 그래프에서 빠진 그룹. 지금 들고 있는 목록으로 만족한다.
        }
        for (const inner of (group.nodes ?? group._nodes ?? [])) {
            if (inner && inner !== node) found.add(inner);
        }
    }
    return [...found];
}

/** 항목의 지금 상태를 캔버스에서 읽는다.
 *
 *    on     그룹 안 노드가 전부 이 항목의 모드다
 *    off    전부 정상(ALWAYS)이다
 *    mixed  섞여 있다 — 일부만 바뀌었거나, 끄기인데 바이패스돼 있는 식
 *    none   맞는 그룹이 없거나 그룹이 비어 있다
 */
function computeState(node, item) {
    const groups = matchedGroups(node, item);
    const nodes = nodesInside(node, groups);
    const target = actionMode(item);
    let hit = 0;
    let normal = 0;
    for (const inner of nodes) {
        const mode = inner.mode ?? MODE.ALWAYS;
        if (mode === target) hit++;
        else if (mode === MODE.ALWAYS) normal++;
    }
    let state = "none";
    if (nodes.length) {
        if (hit === nodes.length) state = "on";
        else if (normal === nodes.length) state = "off";
        else state = "mixed";
    }
    return { state, groups, nodes, hit, normal };
}

/** 모든 항목의 상태를 한 번에 읽어 둔다. 머리글이 그려질 때 한 프레임에 한 번 부른다. */
function refreshStates(node) {
    node.flaStates = (node.flaItems ?? []).map((item) => computeState(node, item));
    return node.flaStates;
}

function stateOf(node, idx) {
    const known = node.flaStates?.[idx];
    if (known) return known;
    const item = node.flaItems?.[idx];
    return item ? computeState(node, item) : { state: "none", groups: [], nodes: [], hit: 0, normal: 0 };
}

// ─────────── 적용 ───────────

function setModes(nodes, mode) {
    for (const inner of nodes) inner.mode = mode;
}

/** 항목을 켜거나(그룹을 그 모드로) 끈다(정상으로). 건드린 노드 수를 돌려준다. */
function applyItem(node, item, on) {
    const st = computeState(node, item);
    setModes(st.nodes, on ? actionMode(item) : MODE.ALWAYS);
    return st.nodes.length;
}

/** 모드를 바꾼 뒤 프론트엔드에 알린다. 그룹 메뉴가 하는 것과 같다. */
function afterModeChange(node) {
    const graph = node.graph ?? app.graph;
    graph?.change?.();
    graph?.setDirtyCanvas?.(true, true);
    node.setDirtyCanvas(true, true);
}

/** 줄을 눌렀을 때. 켜져 있으면 끄고, 꺼졌거나 섞였으면 켠다. */
function clickItem(node, idx) {
    const items = node.flaItems ?? [];
    const item = items[idx];
    if (!item) return;
    const st = computeState(node, item);
    if (st.state === "none") {
        notify(t("gtNoMatch"));
        return;
    }
    const turnOn = st.state !== "on";
    // "1개만 선택" 그룹은 하나만 켜진다. 남들을 먼저 끄고 이 항목을 켜야
    // 그룹이 겹칠 때 이 항목 쪽이 이긴다.
    const group = groupOf(node, item);
    if (turnOn && group.mode === "single") {
        for (const other of items) {
            if (other !== item && groupOf(node, other) === group) applyItem(node, other, false);
        }
    }
    applyItem(node, item, turnOn);
    afterModeChange(node);
}

// ─────────── 그리기 헬퍼 ───────────

/** 세 상태 토글. 켜짐은 오른쪽, 꺼짐은 왼쪽, 섞임은 가운데 노란 손잡이.
 *  클릭 범위 [x, width] 를 돌려준다. 기하는 fla_lora_ui 의 drawToggle 과 같다. */
function drawStateToggle(ctx, posX, posY, height, state) {
    const radius = height * 0.36;
    const bgWidth = height * 1.5;

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(posX + 4, posY + 4, bgWidth - 8, height - 8, [height * 0.5]);
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.fill();
    ctx.globalAlpha = 1;

    let knobX;
    let color;
    if (state === "on") {
        knobX = posX + height;
        color = "#89B";
    } else if (state === "mixed") {
        knobX = posX + height * 0.75;
        color = "#d9b43a";
    } else {
        knobX = posX + height * 0.5;
        color = "#888";
    }
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(knobX, posY + height * 0.5, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    return [posX, bgWidth];
}

function rowColors(state) {
    if (state === "on") return [COLORS.on, COLORS.onEdge];
    if (state === "mixed") return [COLORS.mixed, COLORS.mixedEdge];
    return [COLORS.off, COLORS.offEdge];
}

/** 토글 그룹 상자의 색. 색을 정했으면 테두리는 그 색, 바탕은 그 색을 어둡게. */
function boxColors(group) {
    if (!group.color) return GROUP_BOX;
    return { panel: mix(group.color, 0, 0.72), panelEdge: group.color };
}

/** 아무것도 그리지 않는 여백 줄. 프론트엔드가 +4 를 더하므로 실제 높이는 extra + 4. */
function makeBoxPad(name, extra) {
    return {
        type: "custom",
        name,
        serialize: false,   // 값이 없는 표시용 위젯
        flaRow: true,
        computeSize() {
            return [0, extra];
        },
        draw() { },
    };
}

// ─────────── 위젯: 머리글 ───────────

/** 머리글 줄. 제목 + "켜진 항목/전체", 오른쪽에 모두 켜기 · 모두 끄기.
 *  모든 항목의 상태를 여기서 한 번 읽는다. */
function makeHeaderRow(node) {
    return {
        type: "custom",
        name: "fla_gt_header",
        serialize: false,   // 값이 없는 표시용 위젯
        flaRow: true,
        tooltip: t("tipGtHeader"),
        bounds: { allOn: null, allOff: null },

        computeSize() {
            return [0, ROW_HEIGHT - LAYOUT_PAD];
        },

        draw(ctx, n, widgetWidth, posY, height) {
            const margin = 10;
            const inner = margin * 0.33;
            const midY = posY + height * 0.5;
            const width = node.size?.[0] ?? widgetWidth;

            // 머리글은 위젯 중 맨 앞이라 이 프레임의 첫 draw 다. 여기서 읽어 두면
            // 아래 줄들은 같은 값을 그대로 쓴다.
            const states = refreshStates(node);
            const onCount = states.filter((st) => st.state === "on").length;
            const hasItems = states.length > 0;

            drawRoundedRect(ctx, margin, posY, width - margin * 2, height,
                COLORS.header, COLORS.headerEdge);

            // 오른쪽 끝부터 왼쪽으로: [모두 켜기][모두 끄기]. 항목이 없으면 흐리게.
            ctx.save();
            ctx.textBaseline = "middle";
            ctx.textAlign = "center";
            ctx.font = "11px Arial";
            if (!hasItems) ctx.globalAlpha = 0.45;
            let rightEdge = width - margin - inner;
            const capsule = (key, label, fill, edge, fg) => {
                const capW = ctx.measureText(label).width + 10;
                const capX = rightEdge - capW;
                drawRoundedRect(ctx, capX, posY + 4, capW, height - 8,
                    ...hitColors(this, key, fill, edge, hasItems));
                ctx.fillStyle = fg;
                ctx.fillText(label, capX + capW / 2, midY);
                this.bounds[key] = [capX, capW];
                rightEdge = capX - inner * 2;
            };
            capsule("allOff", t("gtAllOff"), "#3a3a3a", "#5a5a5a", "#ccc");
            capsule("allOn", t("gtAllOn"), "#2f4f34", "#4a7a52", "#cec");
            ctx.restore();

            ctx.save();
            ctx.textBaseline = "middle";
            ctx.textAlign = "left";
            ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR ?? "#DDD";
            const text = `${t("gtTitle")}  (${onCount}/${states.length})`;
            const textX = margin + inner * 2;
            ctx.fillText(fitText(ctx, text, Math.max(10, rightEdge - textX)), textX, midY);
            ctx.restore();
        },

        mouse(event, pos, n) {
            // 반환값은 dirty_canvas 로만 쓰인다. up 에서만 처리한다.
            const gate = mouseGate(event);
            if (gate === "down") return;
            if (gate !== "up") return false;
            if (inBounds(pos, this.bounds.allOn)) {
                actAllOn(node);
                return true;
            }
            if (inBounds(pos, this.bounds.allOff)) {
                actAllOff(node);
                return true;
            }
            return false;
        },
    };
}

// ─────────── 위젯: 토글 그룹 ───────────

/** 토글 그룹 상자의 제목줄. "◉ 이름 (켜진/전체)" · [1개만|여러 개] 배지 · ⚙.
 *  상자(makePanelBox)가 바탕을 그리므로 여기서는 글자와 배지만 쓴다.
 *  배지를 누르면 모드가 바뀌고, 톱니는 그룹 설정을 펼친다. */
function makeGroupHeader(node, group, idxs) {
    return {
        type: "custom",
        name: "fla_gt_group_head",
        serialize: false,   // 값이 없는 표시용 위젯
        flaRow: true,
        tooltip: t("tipGtGroupHead"),
        bounds: { gear: null, mode: null },

        computeSize() {
            return [0, ROW_HEIGHT - LAYOUT_PAD];
        },

        draw(ctx, n, widgetWidth, posY, height) {
            const margin = 10;
            const inner = margin * 0.33;
            const midY = posY + height * 0.5;
            const width = node.size?.[0] ?? widgetWidth;
            const onCount = idxs.filter((i) => stateOf(node, i).state === "on").length;
            const open = node.flaOpenGroup === group.name;
            const single = group.mode === "single";
            // 색을 정한 상자는 제목도 그 색(읽히게 밝힌 것)으로 쓴다
            const accent = group.color ? mix(group.color, 255, 0.45) : "#9bd";

            ctx.save();
            ctx.textBaseline = "middle";

            // 오른쪽 끝: 설정 버튼
            const gearW = 16;
            const gearX = width - margin - inner - gearW;
            ctx.fillStyle = hitText(this, "gear", open ? "#fff" : "#999");
            ctx.textAlign = "center";
            ctx.fillText("⚙", gearX + gearW / 2, midY);
            this.bounds.gear = [gearX, gearW];

            // 그 왼쪽: 모드 배지. 1개만 선택은 주황, 여러 개 선택은 파랑.
            ctx.font = "10px Arial";
            const label = single ? t("gtSingleBadge") : t("gtMultiBadge");
            const badgeW = ctx.measureText(label).width + 10;
            const badgeX = gearX - inner * 2 - badgeW;
            drawRoundedRect(ctx, badgeX, posY + 4, badgeW, height - 8,
                ...hitColors(this, "mode",
                    single ? COLORS.single : COLORS.multi,
                    single ? COLORS.singleEdge : COLORS.multiEdge));
            ctx.fillStyle = "#eee";
            ctx.fillText(label, badgeX + badgeW / 2, midY);
            this.bounds.mode = [badgeX, badgeW];

            // 왼쪽: 제목. 1개만 선택은 라디오(◉), 여러 개 선택은 체크(☑) 모양으로 시작한다.
            ctx.font = "bold 12px Arial";
            ctx.fillStyle = accent;
            ctx.textAlign = "left";
            const text = `${single ? "◉" : "☑"} ${groupLabel(group)}  (${onCount}/${idxs.length})`;
            ctx.fillText(fitText(ctx, text, Math.max(10, badgeX - inner * 2 - margin)), margin, midY);
            ctx.restore();
        },

        mouse(event, pos, n) {
            const gate = mouseGate(event);
            if (gate === "down") return;
            if (gate !== "up") return false;
            if (inBounds(pos, this.bounds.gear)) {
                // 같은 그룹을 다시 누르면 닫는다. 항목 설정과 동시에 열지 않는다.
                node.flaOpenGroup = node.flaOpenGroup === group.name ? null : group.name;
                node.flaOpen = -1;
                rebuildAfterPointer(node);
                return true;
            }
            if (inBounds(pos, this.bounds.mode)) {
                group.mode = group.mode === "single" ? "multi" : "single";
                syncHidden(node);
                // 설정 패널이 열려 있으면 그 안의 모드 버튼도 따라 바뀌어야 한다
                if (node.flaOpenGroup === group.name) rebuildAfterPointer(node);
                else node.setDirtyCanvas(true, true);
                return true;
            }
            return false;
        },
    };
}

/** 토글 그룹 설정 패널을 제목줄 아래에 끼워 넣는다. 상자 안에 한 겹 더 들어간다. */
function pushGroupPanel(node, group) {
    const panel = [];
    const isDefault = isDefaultGroup(group);

    // 이름 — 기본 그룹은 이름이 없다(늘 "기본"). 바꾸는 것은 입력을 마쳤을 때.
    if (!isDefault) {
        const label = makeLabelRow(node, "fla_gt_group_name_label", t("gtByName"));
        node.widgets.push(label);
        panel.push(label);
        let pending = group.name;
        node.widgets.push(makeOverlayInput(node, "fla_gt_group_name", label, {
            placeholder: t("gtGroupNamePlaceholder"),
            get: () => group.name,
            set: (v) => { pending = v; },
            onBlur: () => renameGroup(node, group, pending),
        }));
    }

    // 모드: 1개만 선택 / 여러 개 선택
    const single = group.mode === "single";
    const mode = makeButtonRow(node, "fla_gt_group_mode", [
        [t("gtSingle"), single ? COLORS.single : COLORS.plain,
            () => setGroupMode(node, group, "single"), single ? COLORS.singleEdge : COLORS.plainEdge],
        [t("gtMulti"), !single ? COLORS.multi : COLORS.plain,
            () => setGroupMode(node, group, "multi"), !single ? COLORS.multiEdge : COLORS.plainEdge],
    ]);
    node.widgets.push(mode);
    panel.push(mode);

    // 상자 색: 없음 + 이름 붙은 아홉 색
    const swatches = makeSwatchRow(node, "fla_gt_group_color", {
        list: () => namedColors(),
        none: true,
        get: () => group.color,
        set: (hex) => {
            group.color = hex;
            syncHidden(node);
            node.setDirtyCanvas(true, true);
        },
    });
    node.widgets.push(swatches);
    panel.push(swatches);

    // 그룹 삭제 — 든 항목은 기본 그룹으로 옮긴다
    if (!isDefault) {
        const actions = makeButtonRow(node, "fla_gt_group_actions", [
            ["🗑 " + t("gtRemoveGroup"), COLORS.danger, () => removeGroup(node, group)],
        ]);
        node.widgets.push(actions);
        panel.push(actions);
    }

    const box = makePanelBox(node, panel[0], panel[panel.length - 1]);
    node.widgets.splice(node.widgets.indexOf(panel[0]), 0, box);
}

function setGroupMode(node, group, mode) {
    if (group.mode === mode) return;
    group.mode = mode;
    syncHidden(node);
    rebuildAfterPointer(node);
}

/** 그룹 이름을 쓸 수 없는 경우. 비었거나, 다른 그룹과 같거나, "기본" 과 헷갈리면 안 된다. */
function groupNameTaken(node, name, except = null) {
    if (!name) return true;
    if (name === t("gtDefaultGroup")) return true;
    return (node.flaGroups ?? []).some((g) => g !== except && g.name === name);
}

/** 그룹 이름을 바꾼다. 든 항목들도 새 이름을 가리키게 한다. */
function renameGroup(node, group, raw) {
    const name = String(raw ?? "").trim();
    if (name === group.name) return;
    if (groupNameTaken(node, name, group)) {
        notify(t("gtGroupExists"), true);
        rebuildAfterPointer(node);   // 입력칸을 원래 이름으로 되돌린다
        return;
    }
    for (const item of node.flaItems ?? []) {
        if (item.group === group.name) item.group = name;
    }
    group.name = name;
    if (node.flaOpenGroup !== null) node.flaOpenGroup = name;
    syncHidden(node);
    rebuildAfterPointer(node);
}

function removeGroup(node, group) {
    if (isDefaultGroup(group)) return;
    for (const item of node.flaItems ?? []) {
        if (item.group === group.name) item.group = "";
    }
    node.flaGroups = (node.flaGroups ?? []).filter((g) => g !== group);
    node.flaOpenGroup = null;
    syncHidden(node);
    rebuildAfterPointer(node);
    notify(t("gtGroupRemoved"));
}

/** 새 토글 그룹을 만든다. 이름을 묻고, 겹치면 만들지 않는다. */
function createGroup(node) {
    // 대화상자가 pointerup 을 삼켜 캡처가 남을 수 있다
    releaseWidgetCaptureSoon();
    const raw = window.prompt(t("gtNewGroupName"), "");
    if (raw === null) return null;
    const name = raw.trim();
    if (groupNameTaken(node, name)) {
        notify(t("gtGroupExists"), true);
        return null;
    }
    const group = newGroup(name);
    node.flaGroups.push(group);
    return group;
}

/** 항목을 어느 토글 그룹에 넣을지 고른다. 목록 끝의 "새 그룹" 은 이름을 묻는다. */
async function pickGroupFor(node, item, event) {
    const groups = node.flaGroups ?? [];
    const labels = groups.map(groupLabel);
    const fresh = t("gtNewGroup");
    const choice = await pickFromList([...labels, fresh], event);
    if (choice === null) return;
    let group;
    if (choice === fresh) {
        group = createGroup(node);
        if (!group) return;
    } else {
        group = groups[labels.indexOf(choice)];
        if (!group) return;
    }
    item.group = group.name;
    syncHidden(node);
    rebuildAfterPointer(node);
}

// ─────────── 위젯: 항목 ───────────

/** 항목 한 줄.
 *  왼쪽 토글 / (색 점) 제목 / 오른쪽 맞는 그룹 수 · 동작 배지 · ⚙ 설정. */
function makeItemRow(node, item, idx) {
    return {
        type: "custom",
        name: "fla_gt_item_" + idx,
        serialize: false,   // 값이 없는 표시용 위젯
        flaRow: true,
        tooltip: t("tipGtRow"),
        bounds: { toggle: null, title: null, gear: null },

        computeSize() {
            return [0, ROW_HEIGHT - LAYOUT_PAD];
        },

        draw(ctx, n, widgetWidth, posY, height) {
            const margin = 10;
            const inner = margin * 0.33;
            const midY = posY + height * 0.5;
            const width = node.size?.[0] ?? widgetWidth;
            const st = stateOf(node, idx);
            const open = node.flaOpen === idx;
            const live = st.state !== "none";
            const [fill, edge] = rowColors(st.state);

            drawRoundedRect(
                ctx, margin, posY, width - margin * 2, height,
                ...hitColors(this, "title", fill, open ? PANEL_COLORS.panelEdge : edge, live),
            );

            let posX = margin;
            this.bounds.toggle = drawStateToggle(ctx, posX, posY, height, st.state);
            posX += this.bounds.toggle[1] + inner;

            ctx.save();
            if (!live) ctx.globalAlpha = 0.45;
            ctx.textBaseline = "middle";

            // 오른쪽 끝: 설정 버튼
            const gearW = 16;
            const gearX = width - margin - inner - gearW;
            ctx.fillStyle = hitText(this, "gear", open ? "#9bd" : "#999");
            ctx.textAlign = "center";
            ctx.fillText("⚙", gearX + gearW / 2, midY);
            this.bounds.gear = [gearX, gearW];

            // 그 왼쪽: 동작 배지(바이패스 / 끄기)와 맞는 그룹 수.
            // 작은 글꼴은 여기서만 쓰고 되돌린다 — ctx.font = "" 는 무시되므로
            // 그냥 두면 제목까지 작게 찍힌다.
            let countX;
            ctx.save();
            ctx.font = "10px Arial";
            const actLabel = item.action === "mute" ? t("gtMute") : t("gtBypass");
            const actW = ctx.measureText(actLabel).width + 8;
            const actX = gearX - inner * 2 - actW;
            const [af, ae] = item.action === "mute"
                ? [COLORS.mute, COLORS.muteEdge]
                : [COLORS.bypass, COLORS.bypassEdge];
            drawRoundedRect(ctx, actX, posY + 4, actW, height - 8, af, ae);
            ctx.fillStyle = "#ddd";
            ctx.textAlign = "center";
            ctx.fillText(actLabel, actX + actW / 2, midY);

            // 맞는 그룹 수. 없으면 붉게.
            const countText = `G${st.groups.length}`;
            const countW = ctx.measureText(countText).width;
            countX = actX - inner * 2 - countW;
            ctx.fillStyle = st.groups.length ? "#8ab" : "#c66";
            ctx.textAlign = "left";
            ctx.fillText(countText, countX, midY);
            ctx.restore();

            // 색으로 고르는 항목은 그 색 점을 앞에 찍는다
            if (item.by === "color" && item.color) {
                ctx.beginPath();
                ctx.arc(posX + 5, midY, 4.5, 0, Math.PI * 2);
                ctx.fillStyle = item.color;
                ctx.fill();
                ctx.strokeStyle = "#111";
                ctx.lineWidth = 1;
                ctx.stroke();
                posX += 14;
            }

            // 가운데: 제목.
            // 설정이 열려 있으면 같은 자리에 DOM 입력칸이 얹히므로 글자는 그리지 않는다.
            const titleLeft = posX;
            const titleW = Math.max(10, countX - inner * 2 - titleLeft);
            if (!open) {
                ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR ?? "#DDD";
                ctx.textAlign = "left";
                ctx.fillText(fitText(ctx, itemLabel(item), titleW), titleLeft, midY);
            }
            this.bounds.title = [titleLeft, titleW];
            // 제목 입력칸이 이 자리를 쓰도록 좌표를 남겨둔다
            this.flaTitleBox = [titleLeft, titleW];

            ctx.restore();

            // 툴팁으로 어느 그룹에 맞았는지 보여준다. 섞였으면 몇 개가 그 상태인지도.
            if (st.groups.length) {
                const names = st.groups.map((g) => String(g.title ?? "")).join(", ");
                this.tooltip = st.state === "mixed"
                    ? `${names}  (${st.hit}/${st.nodes.length})`
                    : names;
            } else {
                this.tooltip = t("gtNoMatch");
            }
        },

        activate(pos) {
            if (inBounds(pos, this.bounds.gear)) {
                // 같은 항목을 다시 누르면 닫는다. 그룹 설정과 동시에 열지 않는다.
                node.flaOpen = (node.flaOpen === idx) ? -1 : idx;
                node.flaOpenGroup = null;
                rebuildAfterPointer(node);
                return true;
            }
            // 설정이 열려 있으면 제목 자리는 입력칸이 차지하므로 토글에서 제외한다
            const hit = inBounds(pos, this.bounds.toggle)
                || (node.flaOpen !== idx && inBounds(pos, this.bounds.title));
            if (hit) {
                clickItem(node, idx);
                return true;
            }
            return false;
        },

        mouse(event, pos, n) {
            // 반환값은 dirty_canvas 로만 쓰인다. up 에서만 처리한다.
            const gate = mouseGate(event);
            if (gate === "down") return;
            if (gate !== "up") return false;
            return this.activate(pos);
        },
    };
}

/** 라벨을 왼쪽에 그리고 오른쪽 남는 자리의 좌표를 남겨두는 줄.
 *  DOM 입력칸이 그 자리에 겹쳐 앉는다(makeOverlayInput). */
function makeLabelRow(node, name, label) {
    return {
        type: "custom",
        name,
        serialize: false,   // 값이 없는 표시용 위젯
        flaRow: true,
        flaBox: null,

        computeSize() {
            return [0, ROW_HEIGHT - LAYOUT_PAD];
        },

        draw(ctx, n, widgetWidth, posY, height) {
            const margin = 18;
            const width = node.size?.[0] ?? widgetWidth;
            ctx.save();
            ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR ?? "#DDD";
            ctx.textAlign = "left";
            ctx.textBaseline = "middle";
            ctx.fillText(label, margin, posY + height * 0.5);
            const labelW = ctx.measureText(label).width + 8;
            ctx.restore();
            this.flaBox = [margin + labelW, Math.max(10, width - margin * 2 - labelW)];
        },
    };
}

/** 라벨 줄의 오른쪽 자리에 겹쳐 앉는 한 줄 입력칸. */
function makeOverlayInput(node, name, labelRow, opts) {
    return makeInputWidget(node, {
        name,
        placeholder: opts.placeholder,
        height: ROW_HEIGHT,
        // 라벨 줄이 그려지며 남겨둔 좌표를 따라간다.
        // 아직 한 번도 안 그려졌으면 null 을 줘서 잠시 숨긴다.
        overlay: () => {
            const box = labelRow.flaBox;
            if (!box || labelRow.last_y == null) return null;
            return { x: box[0], w: box[1], y: labelRow.last_y, h: ROW_HEIGHT };
        },
        get: opts.get,
        set: opts.set,
        onBlur: opts.onBlur,
    });
}

/** 제목 입력 칸. 설정을 펼치면 항목 줄의 제목 자리에 그대로 겹쳐 나타난다. */
function makeTitleWidget(node, item, row) {
    return makeInputWidget(node, {
        name: "fla_gt_title",
        placeholder: t("itemTitle"),
        height: ROW_HEIGHT,
        overlay: () => {
            const box = row.flaTitleBox;
            if (!box || row.last_y == null) return null;
            return { x: box[0], w: box[1], y: row.last_y, h: ROW_HEIGHT };
        },
        get: () => item.title ?? "",
        set: (v) => {
            item.title = v;
            syncHidden(node);
        },
    });
}

/** 색 견본 한 줄. 누르면 그 색이 고른 값이 된다.
 *  opts: list() 견본 목록 [{hex,label}], get()/set(hex), none 이면 맨 앞에 "없음" 칸. */
function makeSwatchRow(node, name, opts) {
    return {
        type: "custom",
        name,
        serialize: false,   // 값이 없는 표시용 위젯
        flaRow: true,
        bounds: [],
        flaHexes: [],

        computeSize() {
            return [0, ROW_HEIGHT - LAYOUT_PAD];
        },

        draw(ctx, n, widgetWidth, posY, height) {
            const margin = 18;
            const gap = 4;
            const width = node.size?.[0] ?? widgetWidth;
            const cells = opts.none
                ? [{ hex: "", label: t("gtNoColor") }, ...opts.list()]
                : opts.list();
            this.flaHexes = cells.map((c) => c.hex);
            const current = opts.get();

            // 폭에 맞춰 견본 크기를 정한다. 색이 많아지면 작아진다.
            const avail = width - margin * 2;
            const each = Math.max(8, Math.min(height - 4, (avail - gap * (cells.length - 1)) / cells.length));
            const top = posY + (height - each) / 2;
            this.bounds = [];

            let x = margin;
            cells.forEach((c, i) => {
                const chosen = current === c.hex;
                const [fill, edge] = hitColors(this, i, c.hex || "#2a2a2a", chosen ? "#ffffff" : "#111111");
                ctx.save();
                ctx.beginPath();
                ctx.roundRect(x, top, each, each, 3);
                ctx.fillStyle = fill;
                ctx.fill();
                ctx.lineWidth = chosen ? 2 : 1;
                ctx.strokeStyle = edge;
                ctx.stroke();
                // "없음" 칸은 빗금 하나로 표시한다
                if (!c.hex) {
                    ctx.beginPath();
                    ctx.moveTo(x + 3, top + each - 3);
                    ctx.lineTo(x + each - 3, top + 3);
                    ctx.strokeStyle = "#888";
                    ctx.lineWidth = 1.5;
                    ctx.stroke();
                }
                ctx.restore();
                this.bounds.push([x, each]);
                x += each + gap;
            });

            const picked = cells.find((c) => c.hex === current);
            this.tooltip = picked ? picked.label : t("gtByColor");
        },

        mouse(event, pos, n) {
            const gate = mouseGate(event);
            if (gate === "down") return;
            if (gate !== "up") return false;
            for (let i = 0; i < this.bounds.length; i++) {
                if (!inBounds(pos, this.bounds[i])) continue;
                opts.set(this.flaHexes[i] ?? "");
                return true;
            }
            return false;
        },
    };
}

// ─────────── 항목 설정 패널 ───────────

function setBy(node, item, by) {
    if (item.by === by) return;
    item.by = by;
    syncHidden(node);
    rebuildAfterPointer(node);
}

function setMatch(node, item, match) {
    if (item.match === match) return;
    item.match = match;
    syncHidden(node);
    rebuildAfterPointer(node);
}

function setAction(node, item, action) {
    if (item.action === action) return;
    item.action = action;
    syncHidden(node);
    rebuildAfterPointer(node);
}

/** 캔버스의 그룹 목록에서 하나 골라 이 항목의 이름 필터로 삼는다. */
async function pickFromCanvas(node, item, event) {
    const groups = graphGroups(node);
    if (!groups.length) {
        notify(t("gtNoGroups"));
        return;
    }
    const labels = groups.map((g) => `${String(g.title ?? "")}  (${colorLabel(groupColor(g))})`);
    const choice = await pickFromList(labels, event);
    if (choice === null) return;
    const group = groups[labels.indexOf(choice)];
    if (!group) return;
    item.name = String(group.title ?? "");
    syncHidden(node);
    rebuildAfterPointer(node);
}

/** 펼쳐진 항목 아래에 설정 패널을 끼워 넣는다. row 는 그 항목의 줄이다. */
function pushPanel(node, item, idx, row) {
    const panel = [];

    // 제목 — 항목 줄의 제목 자리에 겹쳐 나타난다. 높이를 차지하지 않으므로
    // 패널 테두리 계산(panel)에는 넣지 않는다.
    node.widgets.push(makeTitleWidget(node, item, row));

    // 무엇으로 고를지: 이름 / 색
    const byName = item.by !== "color";
    const by = makeButtonRow(node, "fla_gt_by", [
        [t("gtByName"), byName ? COLORS.choice : COLORS.plain,
            () => setBy(node, item, "name"), byName ? COLORS.choiceEdge : COLORS.plainEdge],
        [t("gtByColor"), !byName ? COLORS.choice : COLORS.plain,
            () => setBy(node, item, "color"), !byName ? COLORS.choiceEdge : COLORS.plainEdge],
    ]);
    node.widgets.push(by);
    panel.push(by);

    if (byName) {
        const label = makeLabelRow(node, "fla_gt_name_label", t("gtByName"));
        node.widgets.push(label);
        panel.push(label);
        node.widgets.push(makeOverlayInput(node, "fla_gt_name", label, {
            placeholder: t("gtNamePlaceholder"),
            get: () => item.name ?? "",
            set: (v) => {
                item.name = v;
                syncHidden(node);
            },
        }));

        // 어떻게 견줄지: 정확히 일치 / 부분 일치. 캔버스에서 고르기는 이름일 때만 뜻이 있다.
        const exact = item.match !== "contains";
        const match = makeButtonRow(node, "fla_gt_match", [
            [t("gtMatchExact"), exact ? COLORS.choice : COLORS.plain,
                () => setMatch(node, item, "exact"), exact ? COLORS.choiceEdge : COLORS.plainEdge],
            [t("gtMatchContains"), !exact ? COLORS.choice : COLORS.plain,
                () => setMatch(node, item, "contains"), !exact ? COLORS.choiceEdge : COLORS.plainEdge],
            ["📋 " + t("gtPick"), COLORS.action, (event) => pickFromCanvas(node, item, event), null],
        ]);
        node.widgets.push(match);
        panel.push(match);
    } else {
        const swatches = makeSwatchRow(node, "fla_gt_swatches", {
            list: () => palette(node),
            none: false,
            get: () => item.color,
            set: (hex) => {
                item.color = hex;
                syncHidden(node);
                node.setDirtyCanvas(true, true);
            },
        });
        node.widgets.push(swatches);
        panel.push(swatches);
    }

    // 어떻게 할지: 바이패스 / 끄기
    const mute = item.action === "mute";
    const action = makeButtonRow(node, "fla_gt_action", [
        [t("gtBypass"), !mute ? COLORS.bypass : COLORS.plain,
            () => setAction(node, item, "bypass"), !mute ? COLORS.bypassEdge : COLORS.plainEdge],
        [t("gtMute"), mute ? COLORS.mute : COLORS.plain,
            () => setAction(node, item, "mute"), mute ? COLORS.muteEdge : COLORS.plainEdge],
    ]);
    node.widgets.push(action);
    panel.push(action);

    // 어느 토글 그룹에 넣을지
    const group = groupOf(node, item);
    const pick = makeButtonRow(node, "fla_gt_group", [
        [`${t("group")}: ${groupLabel(group)}  ▾`, COLORS.plain,
            (event) => pickGroupFor(node, item, event), COLORS.plainEdge],
    ]);
    node.widgets.push(pick);
    panel.push(pick);

    // 맨 아래: 항목 삭제
    const actions = makeButtonRow(node, "fla_gt_item_actions", [
        ["🗑 " + t("removeItem"), COLORS.danger, () => {
            node.flaItems.splice(idx, 1);
            node.flaOpen = -1;
            syncHidden(node);
            rebuildAfterPointer(node);
        }],
    ]);
    node.widgets.push(actions);
    panel.push(actions);

    // 패널을 감싸는 배경. 다른 패널 위젯보다 먼저 그려야 하므로 앞에 끼운다.
    const box = makePanelBox(node, panel[0], panel[panel.length - 1]);
    node.widgets.splice(node.widgets.indexOf(panel[0]), 0, box);
}

// ─────────── 일괄 동작 ───────────

/** 항목을 만든 뒤 마무리. 하나도 못 만들었으면 그 이유만 알린다. */
function finishAdd(node, added) {
    if (!added) {
        notify(t("gtAddedNone"));
        return;
    }
    node.flaOpen = -1;
    syncHidden(node);
    rebuildAfterPointer(node);
    notify(t("gtAddedGroups", added));
}

/** 캔버스의 그룹 제목마다 이름으로 고르는 항목을 하나씩 만든다(기본 그룹에).
 *  제목이 완전히 같은(대소문자 무시) 그룹은 하나로 치고, 이미 같은 이름의
 *  항목이 있으면 건너뛴다. 숫자를 따로 보지는 않는다 — "Hires" 와 "Hires 2" 는
 *  다른 제목이라 각각 생기고, 정확히 일치로 만들어지므로 서로 겹치지 않는다. */
function actAddByName(node) {
    const groups = graphGroups(node);
    if (!groups.length) {
        notify(t("gtNoGroups"));
        return;
    }
    const have = new Set(
        (node.flaItems ?? [])
            .filter((it) => it.by !== "color")
            .map((it) => (it.name ?? "").trim().toLowerCase())
            .filter(Boolean),
    );
    let added = 0;
    for (const group of groups) {
        const title = String(group.title ?? "").trim();
        if (!title) continue;
        const key = title.toLowerCase();
        if (have.has(key)) continue;
        have.add(key);
        node.flaItems.push({ ...newItem(), name: title });
        added++;
    }
    finishAdd(node, added);
}

/** 캔버스의 그룹이 쓰는 색마다 색으로 고르는 항목을 하나씩 만든다(기본 그룹에).
 *  견본 순서(빨강·갈색·…)로 만들고, 이미 같은 색의 항목이 있으면 건너뛴다. */
function actAddByColor(node) {
    const groups = graphGroups(node);
    if (!groups.length) {
        notify(t("gtNoGroups"));
        return;
    }
    const used = new Set(groups.map((group) => groupColor(group)));
    const have = new Set(
        (node.flaItems ?? [])
            .filter((it) => it.by === "color")
            .map((it) => it.color)
            .filter(Boolean),
    );
    let added = 0;
    for (const c of palette(node)) {
        if (!used.has(c.hex) || have.has(c.hex)) continue;
        have.add(c.hex);
        node.flaItems.push({ ...newItem(), by: "color", color: c.hex });
        added++;
    }
    finishAdd(node, added);
}

/** 모든 항목을 적용한다(그룹을 저마다의 모드로). "1개만 선택" 그룹도 예외 없이 전부 —
 *  그 규칙은 줄을 하나씩 누를 때 지키는 것이지, 일괄 동작까지 막지는 않는다. */
function actAllOn(node) {
    let touched = 0;
    for (const item of node.flaItems ?? []) touched += applyItem(node, item, true);
    if (!touched) {
        notify(t("gtNoMatch"));
        return;
    }
    afterModeChange(node);
    notify(t("gtAllOnDone"));
}

/** 모든 항목의 그룹을 정상으로 돌린다. */
function actAllOff(node) {
    let touched = 0;
    for (const item of node.flaItems ?? []) touched += applyItem(node, item, false);
    if (!touched) {
        notify(t("gtNoMatch"));
        return;
    }
    afterModeChange(node);
    notify(t("gtResetDone"));
}

/** 이름 항목 또는 색 항목을 한꺼번에 지운다. 그룹의 모드는 건드리지 않는다. */
function actRemoveBy(node, by) {
    const items = node.flaItems ?? [];
    const victims = items.filter((it) => (it.by === "color") === (by === "color"));
    if (!victims.length) {
        notify(t("gtRemoveNone"));
        return;
    }
    // 대화상자가 pointerup 을 삼켜 캡처가 남을 수 있다
    releaseWidgetCaptureSoon();
    if (!window.confirm(t("gtRemoveConfirm", victims.length))) return;
    node.flaItems = items.filter((it) => !victims.includes(it));
    node.flaOpen = -1;
    syncHidden(node);
    rebuildAfterPointer(node);
    notify(t("gtRemoved", victims.length));
}

/** 옵션 버튼에 딸린 메뉴. 누른 자리에서 펼친다. */
function openOptions(node, event) {
    const OPTS = [
        ["📋 " + t("gtAddByName"), () => actAddByName(node)],
        ["🎨 " + t("gtAddByColor"), () => actAddByColor(node)],
        ["＋ " + t("gtNewGroupMenu"), () => {
            if (createGroup(node)) {
                syncHidden(node);
                rebuildAfterPointer(node);
            }
        }],
        ["🗑 " + t("gtRemoveNames"), () => actRemoveBy(node, "name")],
        ["🗑 " + t("gtRemoveColors"), () => actRemoveBy(node, "color")],
    ];
    pickFromList(OPTS.map((o) => o[0]), event).then((choice) => {
        OPTS.find((o) => o[0] === choice)?.[1]();
    });
}

// ─────────── 전체 다시 그리기 ───────────

/** 화면 전체를 다시 만든다.
 *  머리글 → 토글 그룹마다 상자(제목줄 · 그룹 설정 · 항목들) → 추가 버튼.
 *  펼쳐진 항목 아래에는 설정 패널이 붙는다. */
function rebuild(node) {
    // 위젯을 새로 만들면 프론트엔드가 잡아둔 옛 위젯은 죽은 참조가 된다
    dropCaptureFor(node);

    // 크기와 줄 위치가 확정될 때까지 DOM 입력칸을 감춰둔다
    node.flaBuilding = true;

    // 다시 그리는 동안 노드 크기가 튀지 않도록 현재 크기를 기억해둔다
    const keepWidth = node.size?.[0] ?? 340;
    const keepHeight = node.size?.[1] ?? 0;

    // 파이썬 위젯만 남기고 화면용 위젯을 걷어낸다.
    // 걷어내기 전에 DOM 요소를 붙여둔 위젯을 정리한다. 그냥 버리면 <input> 이 남는다.
    for (const w of node.widgets ?? []) {
        if (w.flaRow && w.flaElement) w.flaElement.remove();
    }
    node.widgets = (node.widgets ?? []).filter((w) => !w.flaRow);

    const items = node.flaItems ?? [];

    node.widgets.push(makeHeaderRow(node));

    const pushItem = (idx) => {
        const item = items[idx];
        const row = makeItemRow(node, item, idx);
        node.widgets.push(row);
        // 설정 버튼을 누른 항목 아래에만 편집 패널을 펼친다
        if (node.flaOpen === idx) pushPanel(node, item, idx, row);
    };

    for (const { group, idxs } of layoutGroups(node)) {
        // 토글 그룹은 이름이 적힌 상자 하나로 감싼다. 제목줄이 상자의 첫 줄이고,
        // 그룹 설정과 펼쳐진 항목의 설정 패널은 그 안에 한 겹 더 들어간다.
        // 위아래 여백 줄이 없으면 상자 테두리가 앞뒤 상자나 안쪽 패널의
        // 테두리와 겹친다. 위는 앞 줄과 4px, 아래는 마지막 줄과 6px 띄운다.
        const padTop = makeBoxPad("fla_gt_box_pad_top", 4);
        const padBottom = makeBoxPad("fla_gt_box_pad_bottom", 2);
        const head = makeGroupHeader(node, group, idxs);
        node.widgets.push(padTop, head);
        if (node.flaOpenGroup === group.name) pushGroupPanel(node, group);
        idxs.forEach(pushItem);
        node.widgets.push(padBottom);
        // 상자는 안의 줄들보다 먼저 그려져야 하므로 맨 앞에 끼운다
        node.widgets.splice(node.widgets.indexOf(padTop), 0,
            makePanelBox(node, head, padBottom, boxColors(group), 3));
    }

    // 맨 아래: 항목 추가 + 옵션.
    // 옵션은 자주 쓰지 않으므로 좁게 두고 추가 버튼에 자리를 더 준다.
    node.widgets.push(makeButtonRow(node, "fla_gt_add", [
        ["＋ " + t("addItem"), COLORS.action, () => {
            node.flaItems.push(newItem());
            // 새 항목은 바로 편집할 수 있도록 펼쳐준다
            node.flaOpen = node.flaItems.length - 1;
            node.flaOpenGroup = null;
            syncHidden(node);
            rebuildAfterPointer(node);
        }, null, 2],
        ["⚙ " + t("options"), COLORS.options, (event) => {
            openOptions(node, event);
        }, null, 1],
    ]));

    syncHidden(node);

    // 폭은 사용자가 정한 값을 그대로 둔다.
    node.size[0] = keepWidth;

    // 높이는 줄 수에 맞춰 계산하되, 사용자가 늘려둔 여백은 존중한다.
    // 여백은 "직전 크기 - 직전에 필요했던 높이" 다(FLAChecklist 와 같다).
    const needed = node.computeSize?.()?.[1] ?? keepHeight;
    const prevNeeded = node.flaNeededHeight ?? needed;
    const slack = Math.max(0, keepHeight - prevNeeded);
    node.size[1] = needed + slack;
    node.flaNeededHeight = needed;

    // 어느 위젯이든 예외를 던지면 캡처가 남아 전부 먹통이 된다. 한 번에 감싼다.
    guardNodeWidgets(node);

    // 크기가 정해졌으니 이제 입력칸이 제자리를 잡아도 된다
    node.flaBuilding = false;

    node.setDirtyCanvas(true, true);
}

/** 포인터 콜백이 끝난 뒤 화면 위젯을 교체한다.
 *  콜백 안에서 즉시 교체하면 ComfyUI가 제거된 위젯을 활성 상태로 계속 잡는다. */
function rebuildAfterPointer(node) {
    if (node.flaRebuildPending) return;
    node.flaRebuildPending = true;
    setTimeout(() => {
        node.flaRebuildPending = false;
        if (node.graph) rebuild(node);
    }, 0);
}

/** 저장본을 노드 상태로 옮긴다. */
function adopt(node, data) {
    node.flaGroups = data.groups;
    node.flaItems = data.items;
    node.flaOpen = -1;          // 펼쳐진 항목 번호. -1 이면 모두 닫힘.
    node.flaOpenGroup = null;   // 설정을 펼친 토글 그룹 이름. null 이면 모두 닫힘.
}

app.registerExtension({
    name: "FLA.GroupToggle",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;

        const onCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onCreated?.apply(this, arguments);
            const node = this;

            // 파이썬으로 값을 넘기기만 하는 위젯은 화면에서 감춘다.
            // node.widgets 에서 빼버리면 저장·복원 슬롯이 어긋나므로
            // 배열에는 남겨두고 높이와 그리기만 없앤다.
            node.flaHidden = {};
            const hide = (name) => {
                const w = findWidget(node, name);
                if (!w) return;
                node.flaHidden[name] = w;
                w.hidden = true;
                if (w.options) w.options.hidden = true;
                w.computeSize = () => [0, -4];
                w.computeLayoutSize = () => ({
                    minHeight: 0, maxHeight: 0, minWidth: 0,
                });
                w.draw = () => { };
                if (w.element) w.element.style.display = "none";
            };
            hide("items_data");

            // onConfigure 가 먼저 실행되는 경우가 있다(워크플로를 다시 열 때).
            // 그때는 items_data 에 복원된 값이 이미 들어 있으므로 덮어쓰면 안 된다.
            adopt(node, readData(node));

            // 새로 놓을 때만 기본 폭을 준다. 이후에는 사용자가 정한 폭을 건드리지 않는다.
            if (!node.size?.[0]) {
                node.size = [340, node.size?.[1] ?? 0];
            }

            rebuild(node);
        };

        // 노드를 지우면 붙여둔 DOM 요소도 함께 치운다
        const onRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            for (const w of this.widgets ?? []) {
                if (w.flaElement) w.flaElement.remove();
            }
            onRemoved?.apply(this, arguments);
        };

        // 워크플로 저장 시 항목을 함께 담는다.
        // 정본은 파이썬 위젯 items_data 지만, 혹시 몰라 한 벌 더 남긴다.
        const onSerialize = nodeType.prototype.onSerialize;
        nodeType.prototype.onSerialize = function (o) {
            onSerialize?.apply(this, arguments);
            o.flaGroups = this.flaGroups ?? [];
            o.flaItems = this.flaItems ?? [];
            o.flaHeightSlack = Math.max(0, (this.size?.[1] ?? 0) - (this.flaNeededHeight ?? 0));
        };

        // 워크플로를 다시 열 때 항목을 복원한다
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (o) {
            const node = this;
            onConfigure?.apply(this, arguments);

            // 파이썬 위젯(items_data)이 정본이다. 비어 있으면 flaItems 를 쓴다.
            const restored = readData(node);
            adopt(node, restored.items.length
                ? restored
                : normalizeData({ groups: o.flaGroups, items: o.flaItems }));

            // 펼친 편집 패널의 높이는 복원하지 않는다. 사용자가 직접 늘린 여백만
            // 접힌 상태의 필요 높이에 다시 더한다.
            const savedWidth = o.size?.[0];
            const savedSlack = Math.max(0, Number(o.flaHeightSlack) || 0);
            rebuild(node);
            if (savedWidth) node.size[0] = savedWidth;
            node.size[1] = (node.flaNeededHeight ?? node.size[1]) + savedSlack;
        };
    },
});
