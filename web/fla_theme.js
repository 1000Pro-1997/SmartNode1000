/** SM1000 노드 얼굴의 색과 모양을 한 곳에 모은다.
 *
 *  요즘 ComfyUI 노드 꾸러미들이 쓰는 모양을 따른다 — 거의 검은 카드 위에
 *  테두리 없는 회색 조작칸, 켜졌거나 고른 것에만 쓰는 청록 하나.
 *  노드 파일들은 색 글자를 직접 적지 않고 여기서 읽는다.
 *
 *  색은 모두 #rrggbb 로 적는다. fla_hit.js 가 호버·누름 색을 계산할 때
 *  16진 색만 읽을 수 있기 때문이다.
 */
import { app } from "../../scripts/app.js";

export const THEME = Object.freeze({
    brand: "#00b4aa",       // 하나뿐인 강조색: 켜짐, 고른 것, 주 버튼
    onBrand: "#04201d",     // 강조색 위의 글자
    brandSoft: "#12322f",   // 강조색을 옅게 깐 바탕(켜진 줄, 열린 칸)
    brandInk: "#45d6cb",    // 옅은 바탕 위의 강조 글자

    card: "#101214",        // 위젯을 담는 카드 바탕
    fill: "#2d3134",        // 모든 조작칸: 꽉 찬 회색, 테두리 없음
    row: "#1d2124",         // 목록 줄 바탕(켜짐)
    rowOff: "#17191b",      // 목록 줄 바탕(꺼짐)
    rule: "#2b2f32",        // 가는 구분선, 카드 윤곽
    switchOff: "#62676d",   // 스위치가 꺼짐에 있을 때의 표시

    ink: "#f6f7f8",         // 값: 숫자, 고른 것, 입력한 글
    inkSoft: "#e0e3e5",     // 보통 글자
    label: "#b4b9bd",       // 줄 이름, 고르지 않은 것, 화살표
    faint: "#979da2",       // 단위, 자리표시, 흐린 줄
    dim: "#6b7075",         // 꺼진 것의 글자

    danger: "#e0605a",
    dangerSoft: "#3a1c1b",
    dangerInk: "#ffb4ae",
    warn: "#e0a040",
    warnSoft: "#3a2a10",
    warnInk: "#ffdca8",
    star: "#ffd479",        // 즐겨찾기 별

    nodeTitle: "#17424b",   // 노드 제목 줄
    nodeBody: "#16191b",    // 노드 몸통
});

export const FONT_UI = `system-ui,-apple-system,"Segoe UI",Roboto,sans-serif`;
export const RADIUS_XS = 4;
export const RADIUS_CONTROL = 6;
export const RADIUS_CARD = 10;

// 이 색을 입을 노드들
const OUR_NODES = new Set(["SN1000LoraTheme", "SN1000Checklist", "SN1000Resolution", "SN1000GroupToggle"]);

app.registerExtension({
    name: "SM1000.Theme",
    // 새로 만든 노드에만 입힌다. 불러온 워크플로우는 저장된 색이 이 뒤에
    // 덮어쓰므로, 사용자가 직접 칠해 둔 색은 그대로 남는다.
    nodeCreated(node) {
        if (!OUR_NODES.has(node.comfyClass)) return;
        if (!node.color) node.color = THEME.nodeTitle;
        if (!node.bgcolor) node.bgcolor = THEME.nodeBody;
    },
});
