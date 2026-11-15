/** 설정 패널 공용 부품.
 *
 *  FLAChecklist 와 SN1000GroupToggle 이 똑같이 쓰는 것들 — 캔버스 위에 얹는
 *  DOM 입력칸, 좌우로 나뉜 버튼 줄, 패널을 감싸는 테두리. 여기를 고치면
 *  두 노드에 함께 반영된다.
 *
 *  로라 목록 쪽 부품(토글·강도·로라 줄)은 fla_lora_ui.js 에 있다.
 */
import { app } from "../../scripts/app.js";
import { mouseGate } from "./fla_widget_mouse.js";
import { hitColors } from "./fla_hit.js";
import { ROW_HEIGHT, LAYOUT_PAD, drawRoundedRect, fitText, inBounds } from "./fla_lora_ui.js";
import { THEME, RADIUS_CARD } from "./fla_theme.js";

// 설정 패널: 거의 검은 카드에 가는 윤곽.
export const PANEL_COLORS = {
    panel: THEME.card,
    panelEdge: THEME.rule,
};

// 지금 화면에 붙어 있는 입력칸들. 프레임이 끝날 때 이번에 안 그려진 것을 감춘다.
// 패널을 다시 짤 때 요소만 떼어 내는 곳이 있어, 떨어진 것은 그때 걸러 낸다.
const liveInputs = new Set();
let frameHooked = false;

/** 노드가 화면 밖으로 나가면 캔버스는 그 노드를 아예 그리지 않는다(draw 가
 *  안 불린다). 그러면 입력칸은 마지막 자리에 남아 화면 위에 떠 버린다.
 *  그래서 캔버스 한 프레임이 끝날 때마다, 이번 프레임에 그려지지 않은
 *  입력칸을 감춘다. */
function hookFrameEnd() {
    const canvas = app.canvas;
    if (frameHooked || !canvas) return;
    frameHooked = true;
    const previous = canvas.onDrawForeground;
    canvas.onDrawForeground = function (...args) {
        const result = previous?.apply(this, args);
        for (const input of liveInputs) {
            if (!input.isConnected) liveInputs.delete(input);
            else if (input.flaFrame !== this.frame) input.style.visibility = "hidden";
        }
        return result;
    };
}

/** 캔버스 위에 얹는 DOM 입력 칸.
 *
 *  ComfyUI 의 multiline STRING 위젯과 같은 방식이다.
 *  addWidget("textarea", ...) 는 Node 2.0 전용이라 옛 캔버스에서는
 *  "Textarea: Node 2.0 전용" 자리표시만 나오므로 쓰지 않는다.
 *
 *  DOM 요소는 캔버스 좌표와 따로 놀기 때문에 draw 때마다 위치를 맞춰준다.
 *  height 를 함수로 주면 남는 공간에 맞춰 늘어나는 칸이 된다.
 *
 *  opts:
 *    name         위젯 이름
 *    get / set    값을 읽고 쓰는 함수. set 은 글자를 칠 때마다 불린다 —
 *                 저장 동기화(syncHidden 같은 것)는 set 안에서 한다.
 *    onBlur       입력을 마쳤을 때(칸에서 나갈 때). 배치를 다시 잡을 때 쓴다.
 *    placeholder  비었을 때 보여줄 글
 *    multiline    여러 줄이면 true
 *    height       줄 높이(숫자 또는 함수). overlay 면 무시된다.
 *    overlay      () => { x, w, y, h } | null. 주면 다른 줄 위에 겹쳐 그린다.
 *                 null 을 돌려주면 그 프레임은 숨긴다.
 *
 *  부르는 쪽은 rebuild 도중 node.flaBuilding 을 켜 둬야 한다. 그동안은
 *  노드 크기와 줄 위치가 확정되지 않아 자리를 잡으면 튀어 보이기 때문이다.
 */
export function makeInputWidget(node, opts) {
    const multiline = opts.multiline === true;
    const input = document.createElement(multiline ? "textarea" : "input");
    if (!multiline) input.type = "text";
    // rows 기본값(2)이 최소 높이로 잡히지 않도록 1 로 둔다. 실제 높이는 style 로 준다.
    else input.rows = 1;
    input.className = multiline ? "comfy-multiline-input" : "comfy-input";
    input.value = opts.get() ?? "";
    input.placeholder = opts.placeholder ?? "";
    input.spellcheck = false;
    Object.assign(input.style, {
        position: "absolute",
        // 좌표가 정해지기 전에는 감춰둔다.
        // visibility 로 감추면 자리와 크기는 이미 잡혀 있어서, 보이는 순간
        // 엉뚱한 자리에서 커졌다 줄어드는 것처럼 보이지 않는다.
        visibility: "hidden",
        left: "-9999px",     // 첫 프레임에 화면 안에서 깜빡이지 않도록 밖에 둔다
        top: "-9999px",
        width: "0px",
        height: "0px",
        // textarea 는 rows 기본값(보통 2줄)이 최소 높이로 잡힌다.
        // min/max 를 함께 0 으로 두지 않으면 자리를 잡기 전 그 높이로 한 번 보인다.
        minHeight: "0px",
        maxHeight: "0px",
        boxSizing: "border-box",
        resize: "none",
        overflowY: multiline ? "auto" : "hidden",
        // 여러 줄 칸은 글자가 위에서부터 채워지게 한다
        verticalAlign: "top",
        lineHeight: "1.35",
        background: THEME.fill,
        color: THEME.ink,
        border: "1px solid transparent",
        borderRadius: "6px",
        padding: "2px 6px",
        fontFamily: "inherit",
        // 테마의 전환 효과가 남아 있으면 크기·위치가 스르륵 따라와 잔상이 생긴다
        transition: "none",
        animation: "none",
    });
    document.body.append(input);
    liveInputs.add(input);
    hookFrameEnd();

    input.addEventListener("input", () => {
        opts.set(input.value);
        // 제목이 비면 목록에 다른 글이 보이는 식으로 화면이 바뀌므로 다시 그린다
        node.setDirtyCanvas(true, true);
    });
    if (opts.onBlur) input.addEventListener("blur", () => opts.onBlur());
    // 캔버스가 클릭과 키 입력을 가로채지 않도록 막는다
    input.addEventListener("pointerdown", (e) => e.stopPropagation());
    input.addEventListener("keydown", (e) => e.stopPropagation());
    // 한 줄 입력에서 엔터를 누르면 입력을 끝낸다
    if (!multiline) {
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") input.blur();
        });
    }

    return {
        type: "custom",
        name: opts.name,
        serialize: false,   // 값은 노드 데이터(JSON) 안에 들어간다
        flaRow: true,
        flaElement: input,  // 패널을 다시 그릴 때 치우기 위해 들고 있는다
        inputEl: input,

        computeSize() {
            // overlay 는 다른 줄 위에 겹쳐 그리므로 자기 높이를 갖지 않는다.
            // +4 가 더해지므로 -4 를 돌려줘야 실제 높이가 0 이 된다.
            if (opts.overlay) return [0, -4];
            return [0, typeof opts.height === "function" ? opts.height() : opts.height];
        },

        draw(ctx, n, widgetWidth, posY, height) {
            // 노드가 접혔거나 그래프에서 빠지면 감춘다
            if (node.flags?.collapsed || !node.graph) {
                input.style.visibility = "hidden";
                return;
            }
            // rebuild 도중에는 노드 크기와 줄 위치가 아직 확정되지 않았다.
            // 이때 자리를 잡으면 엉뚱한 곳에 나타났다가 제자리로 튀어 보인다.
            if (node.flaBuilding) {
                input.style.visibility = "hidden";
                return;
            }

            // 겹쳐 그리는 칸은 대상 줄의 좌표를 그대로 쓴다
            const over = opts.overlay?.();
            if (opts.overlay && !over) {
                input.style.visibility = "hidden";
                return;
            }
            if (over) {
                posY = over.y;
                height = over.h;
            }

            const margin = over ? over.x : 18;
            const width = node.size?.[0] ?? widgetWidth;
            const canvas = app.canvas;
            const scale = canvas?.ds?.scale ?? 1;
            const offset = canvas?.ds?.offset ?? [0, 0];
            const rect = canvas?.canvas?.getBoundingClientRect?.();
            if (!rect) return;

            // 캔버스 좌표 → 화면 좌표.
            //
            // node.pos 는 제목 표시줄 아래(노드 몸통)를 가리키고 posY 는 거기서부터
            // 잰 값이므로 그대로 더하면 된다. 캔버스 자체가 rect 만큼 밀려 있고
            // ds.offset 만큼 이동, ds.scale 만큼 확대돼 있다.
            const x = rect.left + (node.pos[0] + offset[0] + margin) * scale;
            const y = rect.top + (node.pos[1] + offset[1] + posY) * scale;

            const boxW = Math.max(0, over ? over.w : width - margin * 2) * scale;
            const boxH = height * scale;

            // ① 자리부터 옮긴다.
            //    크기를 먼저 주면 아직 옛 자리에 있는 채로 커졌다가 이동하므로
            //    "위에서 크게 나타났다가 제자리로 가며 작아지는" 것처럼 보인다.
            input.style.left = `${x}px`;
            input.style.top = `${y}px`;

            // ② 자리를 잡은 뒤에 크기를 준다.
            //    height 하나만 주면 테마 CSS 기본값에 밀릴 수 있어 셋을 함께 못박는다.
            input.style.width = `${boxW}px`;
            input.style.height = `${boxH}px`;
            input.style.minHeight = `${boxH}px`;
            input.style.maxHeight = `${boxH}px`;

            // ③ 확대율에 맞춰 글자와 안쪽 여백을 맞춘다
            input.style.fontSize = `${11 * scale}px`;
            input.style.padding = `${2 * scale}px ${6 * scale}px`;
            input.style.borderRadius = `${4 * scale}px`;
            input.style.zIndex = 1;
            // 너무 작아지면 읽을 수 없으므로 숨긴다(ComfyUI 기본 동작과 같다)
            if (scale < 0.5) {
                input.style.visibility = "hidden";
                return;
            }
            // 캔버스 밖으로 밀려나면 감춘다. DOM 요소는 캔버스에 잘리지 않아
            // 그냥 두면 화면 위에 둥둥 떠 보인다.
            if (y + boxH < rect.top || y > rect.bottom
                || x + boxW < rect.left || x > rect.right) {
                input.style.visibility = "hidden";
                return;
            }

            // 좌표가 확정된 뒤에야 보여준다
            input.flaFrame = canvas.frame;
            input.style.visibility = "visible";
        },

        onRemove() {
            liveInputs.delete(input);
            input.remove();
        },
    };
}

/** 좌우로 나뉜 버튼 한 줄을 만든다. [라벨, 색, 동작, 테두리색, 몫] 을 받는다.
 *  몫은 서로 견주는 너비다(안 주면 1). 2 를 주면 1 인 버튼의 두 배로 넓다.
 *  색을 함수로 주면 그릴 때마다 물어본다(상태에 따라 색이 바뀌는 버튼). */
export function makeButtonRow(node, name, buttons) {
    return {
        type: "custom",
        name,
        serialize: false,   // 값이 없는 표시용 위젯
        flaRow: true,
        bounds: [],

        computeSize() {
            return [0, ROW_HEIGHT - LAYOUT_PAD];
        },

        draw(ctx, n, widgetWidth, posY, height) {
            const margin = 10;
            const gap = 6;
            const width = node.size?.[0] ?? widgetWidth;
            const midY = posY + height * 0.5;
            const space = width - margin * 2 - gap * (buttons.length - 1);
            const share = buttons.reduce((sum, btn) => sum + (btn[4] ?? 1), 0);

            ctx.save();
            ctx.textBaseline = "middle";
            ctx.textAlign = "center";
            this.bounds = [];

            let x = margin;
            buttons.forEach((btn, i) => {
                const each = space * (btn[4] ?? 1) / share;
                const fill = typeof btn[1] === "function" ? btn[1]() : btn[1];
                const edge = typeof btn[3] === "function" ? btn[3]() : (btn[3] ?? null);
                drawRoundedRect(ctx, x, posY, each, height,
                    ...hitColors(this, i, fill, edge));
                this.bounds.push([x, each]);
                // 바탕에 맞는 글자색: 주 버튼(청록)은 어둡게, 위험(삭제)은 붉게
                ctx.fillStyle = fill === THEME.brand ? THEME.onBrand
                    : fill === THEME.dangerSoft ? THEME.dangerInk : THEME.inkSoft;
                ctx.fillText(fitText(ctx, btn[0], each - 8), x + each / 2, midY);
                x += each + gap;
            });

            ctx.restore();
        },

        activate(pos, event) {
            for (let i = 0; i < this.bounds.length; i++) {
                if (inBounds(pos, this.bounds[i])) {
                    buttons[i][2](event);
                    return true;
                }
            }
            return false;
        },

        mouse(event, pos, n) {
            // 반환값은 dirty_canvas 로만 쓰인다. up 에서만 처리한다.
            const gate = mouseGate(event);
            if (gate === "down") return;
            if (gate !== "up") return false;
            return this.activate(pos, event);
        },
    };
}

/** 설정 패널을 감싸는 테두리. 높이를 차지하지 않고 영역만 그린다.
 *  first 와 last 는 패널의 첫 줄과 마지막 줄 위젯이다.
 *  inset 은 노드 가장자리에서 상자까지의 거리. 상자를 겹쳐 넣을 때
 *  바깥 상자는 작게, 안쪽 상자는 크게 준다. */
export function makePanelBox(node, first, last, colors = PANEL_COLORS, inset = 6) {
    return {
        type: "custom",
        name: "fla_panel_box",
        serialize: false,   // 값이 없는 표시용 위젯
        flaRow: true,
        // 프론트엔드가 배치할 때 높이에 +4 를 더하므로(_arrangeWidgets)
        // -4 를 돌려줘야 실제로 0 이 된다. 그러지 않으면 이 줄이 4px 를 먹고,
        // getWidgetOnPos 에서 mouse 없는 이 위젯이 먼저 잡혀 클릭이 사라진다.
        computeSize() {
            return [0, -4];
        },
        draw(ctx, n, widgetWidth, posY) {
            const width = node.size?.[0] ?? widgetWidth;
            const top = (first.last_y ?? posY) - 4;
            // 마지막 위젯의 높이는 종류에 따라 다르므로 실제 크기를 물어본다
            const lastH = last.computeSize?.()?.[1] ?? ROW_HEIGHT;
            const bottom = (last.last_y ?? top) + lastH + 4;
            if (bottom <= top) return;
            ctx.save();
            ctx.beginPath();
            ctx.roundRect(inset, top, Math.max(20, width - inset * 2), bottom - top, RADIUS_CARD);
            ctx.fillStyle = colors.panel;
            ctx.fill();
            ctx.strokeStyle = colors.panelEdge;
            ctx.lineWidth = 1;
            ctx.stroke();
            ctx.restore();
        },
    };
}
