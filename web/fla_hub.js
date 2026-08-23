/** 통합 관리 허브 — 탑바 버튼 하나로 관리 창들을 모아 연다.
 *
 *  ComfyUI 새 프론트엔드는 상단 막대(탑바) 오른쪽 끝, 실행 버튼이 있는
 *  구역을 액션바라 부른다. 확장이 여기에 버튼을 넣는 통로가
 *  actionBarButtons 이고 프론트엔드 1.33.9 부터 쓸 수 있다. 그보다 낮으면
 *  옛 방식대로 설정 버튼 앞에 직접 끼워 넣는다.
 *
 *  허브는 스스로 목록을 그리지 않는다. 타일을 누르면 자기는 닫히고 이미
 *  있는 창(로라 선택창, 와일드카드 창, Civitai 창)을 그대로 연다. 창을
 *  겹쳐 띄우면 Esc 가 어느 창을 닫는지 헷갈리므로 항상 한 겹만 남긴다.
 */

import { app } from "../../scripts/app.js";
import { t } from "./fla_i18n.js";
import { el } from "./fla_civitai_util.js";
import { pickLora } from "./fla_lora_picker.js";
import { pickWildcard } from "./fla_wildcard_picker.js";
import { openCivitaiPanel } from "./fla_civitai.js";
import { openModelManager } from "./fla_ckpt_picker.js";
import { openWorkflowManager } from "./fla_workflow_picker.js";

// 액션바 버튼이 생긴 프론트엔드 판. 이보다 낮으면 옛 방식으로 붙인다.
const MIN_ACTION_BAR = [1, 33, 9];
// 옛 방식으로 붙일 때 자리를 기다리는 최대 프레임 수(약 2초).
const MAX_ATTACH_TRIES = 120;
const GROUP_CLASS = "fla-hub-topbar-group";

/** 허브가 여는 창들. 배열 순서가 곧 화면 순서다. */
const TILES = [
    { icon: "pi pi-images", title: "hubLoras", desc: "hubLorasDesc", open: openLoraLibrary },
    { icon: "pi pi-box", title: "hubCheckpoints", desc: "hubCheckpointsDesc", open: openModelManager },
    { icon: "pi pi-sitemap", title: "hubWorkflows", desc: "hubWorkflowsDesc", open: openWorkflowManager },
    { icon: "pi pi-hashtag", title: "hubWildcards", desc: "hubWildcardsDesc", open: pickWildcard },
    { icon: "pi pi-cloud-download", title: "hubCivitai", desc: "hubCivitaiDesc", open: openCivitaiPanel },
];


// -------------------------------------------------- 알림

/** 짧은 알림. 허브는 오류를 낼 일이 거의 없어 토스트만 쓴다. */
function toast(message) {
    const box = app.extensionManager?.toast;
    if (box?.add) box.add({ severity: "warn", summary: message, life: 2500 });
    else console.log("[FLA]", message);
}

/** 로라가 하나도 없으면 선택창이 아무 말 없이 닫힌다. 이유를 알려준다. */
async function openLoraLibrary() {
    const picked = await pickLora();
    if (picked === null) toast(t("hubNoLoras"));
}


// -------------------------------------------------- 허브 창

function addStyles() {
    if (document.getElementById("fla-hub-style")) return;
    const style = document.createElement("style");
    style.id = "fla-hub-style";
    style.textContent = `
      .fla-hub-bg{position:fixed;inset:0;z-index:100005;background:#000b;display:grid;place-items:center;padding:3vh}
      .fla-hub{width:min(760px,94vw);background:#181a1f;color:#ddd;border:1px solid #4b5360;border-radius:12px;overflow:hidden;box-shadow:0 22px 70px #000;font:14px Arial,sans-serif}
      .fla-hub-head{display:flex;align-items:center;gap:10px;padding:11px 14px;background:#22262d;border-bottom:1px solid #383e48}
      .fla-hub-head h2{margin:0;flex:1;font-size:15px;font-weight:700;color:#fff;white-space:nowrap}
      .fla-hub-head .logo{flex:none;display:grid;width:26px;height:26px;place-items:center;color:#fff;background:#1971c2;border-radius:7px;font-size:12px;font-weight:800}
      .fla-hub-head .close{flex:none;width:32px;height:32px;padding:0;color:#ddd;background:#303640;border:1px solid #454c58;border-radius:7px;font-size:18px;cursor:pointer}
      .fla-hub-head .close:hover{background:#3a424e}
      .fla-hub-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;padding:14px}
      .fla-hub-tile{display:flex;flex-direction:column;align-items:flex-start;gap:6px;padding:14px 13px;text-align:left;color:#ddd;background:#22262d;border:1px solid #383e48;border-radius:10px;cursor:pointer;transition:background .12s,border-color .12s}
      .fla-hub-tile:hover{background:#2b3038;border-color:#4dabf7}
      .fla-hub-tile:focus-visible{outline:2px solid #4dabf7;outline-offset:2px}
      .fla-hub-tile>i{display:grid;width:34px;height:34px;place-items:center;margin-bottom:2px;color:#4dabf7;background:#1b2b3d;border-radius:8px;font-size:16px}
      .fla-hub-name{color:#fff;font-size:14px;font-weight:700}
      .fla-hub-desc{color:#98a1ad;font-size:12px;line-height:1.5}
      .fla-hub-foot{padding:9px 14px;background:#1d2026;border-top:1px solid #383e48;color:#7d858f;font-size:12px}
      .comfyui-button.fla-hub-btn{color:#fff;background:#1971c2}
      .comfyui-button.fla-hub-btn:hover{background:#1c7ed6}
    `;
    document.head.appendChild(style);
}

/** 허브를 연다. 이미 열려 있으면 다시 만들지 않는다. */
export function openHub() {
    addStyles();
    if (document.querySelector(".fla-hub-bg")) return;

    const bg = el("div", "fla-hub-bg");
    const panel = el("div", "fla-hub");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");

    const head = el("div", "fla-hub-head");
    const closeButton = el("button", "close", "×");
    closeButton.title = t("cancel");
    head.append(el("div", "logo", "SM"), el("h2", null, t("hubTitle")), closeButton);

    let closed = false;
    const shut = () => {
        if (closed) return;
        closed = true;
        document.removeEventListener("keydown", key, true);
        bg.remove();
    };
    // 캔버스 단축키가 먼저 먹지 않도록 캡처 단계에서 Esc 를 잡는다
    const key = (event) => { if (event.key === "Escape") { event.stopPropagation(); shut(); } };

    const grid = el("div", "fla-hub-grid");
    for (const tile of TILES) {
        const button = el("button", "fla-hub-tile");
        button.type = "button";
        const icon = el("i");
        icon.className = tile.icon;
        button.append(icon, el("div", "fla-hub-name", t(tile.title)), el("div", "fla-hub-desc", t(tile.desc)));
        // 창을 겹치지 않게, 허브를 먼저 닫고 나서 연다
        button.onclick = () => { shut(); tile.open(); };
        grid.appendChild(button);
    }

    panel.append(head, grid, el("div", "fla-hub-foot", t("hubTip")));
    bg.appendChild(panel);
    closeButton.onclick = shut;
    bg.onclick = (event) => { if (event.target === bg) shut(); };
    document.addEventListener("keydown", key, true);
    document.body.appendChild(bg);
    grid.firstChild?.focus();
}


// -------------------------------------------------- 탑바 버튼

/** 프론트엔드 판을 [주, 부, 수] 로 읽는다. 못 읽으면 0 으로 둔다. */
function parseVersion(text) {
    if (typeof text !== "string" || !text) return [0, 0, 0];
    const parts = text.replace(/^[vV]/, "").split("-")[0].split(".").map((part) => parseInt(part, 10) || 0);
    while (parts.length < 3) parts.push(0);
    return parts.slice(0, 3);
}

/** 액션바 버튼을 쓸 수 있는 판인지 본다. 모르겠으면 옛 방식으로 간다. */
async function hasActionBar() {
    let version = window.__COMFYUI_FRONTEND_VERSION__ ?? "";
    if (!version) {
        try {
            const stats = await (await fetch("/system_stats")).json();
            version = stats?.system?.comfyui_frontend_version ?? "";
        } catch (e) {
            return false;
        }
    }
    const now = parseVersion(version);
    for (let i = 0; i < 3; i++) {
        if (now[i] !== MIN_ACTION_BAR[i]) return now[i] > MIN_ACTION_BAR[i];
    }
    return true;
}

/** 옛 판에서 쓰는 길. 설정 버튼 무리 앞에 우리 버튼을 끼운다.
 *  메뉴는 늦게 만들어지므로 자리가 생길 때까지 프레임마다 다시 본다. */
async function attachLegacyButton(tries = 0) {
    if (document.querySelector("." + GROUP_CLASS)) return;

    const settings = app.menu?.settingsGroup;
    if (!settings?.element?.parentElement) {
        if (tries >= MAX_ATTACH_TRIES) {
            console.warn("[FLA] 탑바에서 설정 버튼 자리를 찾지 못했다.");
            return;
        }
        requestAnimationFrame(() => attachLegacyButton(tries + 1));
        return;
    }

    const { ComfyButton } = await import("../../scripts/ui/components/button.js");
    const { ComfyButtonGroup } = await import("../../scripts/ui/components/buttonGroup.js");
    const button = new ComfyButton({
        icon: "view-grid-outline",
        tooltip: t("hubTitle"),
        content: t("hubButton"),
        app,
        enabled: true,
        classList: "comfyui-button comfyui-menu-mobile-collapse fla-hub-btn",
    });
    button.element.addEventListener("click", openHub);

    const group = new ComfyButtonGroup(button);
    group.element.classList.add(GROUP_CLASS);
    settings.element.before(group.element);
}

const extension = {
    name: "SM1000.Hub",
    async setup() {
        addStyles();
        if (!(await hasActionBar())) await attachLegacyButton();
    },
};

// 액션바 버튼은 확장을 등록할 때 한 번 읽어가므로 등록 전에 판을 확인한다.
(async () => {
    if (await hasActionBar()) {
        extension.actionBarButtons = [{
            icon: "pi pi-th-large",
            label: t("hubButton"),
            tooltip: t("hubTitle"),
            onClick: openHub,
        }];
    }
    app.registerExtension(extension);
})();
