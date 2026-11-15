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
import { el, json, post } from "./fla_civitai_util.js";
import { pickLora } from "./fla_lora_picker.js";
import { pickWildcard } from "./fla_wildcard_picker.js";
import { openCivitaiPanel } from "./fla_civitai.js";
import { openModelManager } from "./fla_ckpt_picker.js";
import { openWorkflowManager } from "./fla_workflow_picker.js";
import { openSmartFill } from "./fla_smart_fill.js";

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
    { icon: "pi pi-bolt", title: "hubSmartFill", desc: "hubSmartFillDesc", open: openSmartFill },
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
      .fla-hub-foot{display:flex;align-items:center;gap:6px;padding:9px 14px;background:#1d2026;border-top:1px solid #383e48;color:#7d858f;font-size:12px}
      .fla-hub-foot .tip{flex:1;min-width:0}
      .fla-hub-foot button{flex:none;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 11px;color:#dde2e8;background:#2b3138;border:1px solid #454c58;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap}
      .fla-hub-foot button:hover:not(:disabled){background:#353c46;border-color:#4dabf7}
      .fla-hub-foot button:disabled{opacity:.5;cursor:default}
      .fla-hub-foot button.go{color:#fff;background:#1971c2;border-color:#1971c2}
      .fla-hub-foot button.go:hover:not(:disabled){background:#1c7ed6}
      .fla-hub-foot button.warn:hover:not(:disabled){border-color:#ff8f6b;color:#ffb39b}
      .fla-hub-foot button.new{color:#0b1f12;background:#51cf66;border-color:#51cf66}
      .fla-hub-foot button.new:hover:not(:disabled){background:#69db7c;border-color:#69db7c}
      .fla-hub-foot .ver{flex:none;color:#5f6773;font-size:11px}
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

    panel.append(head, grid, buildFooter(shut));
    bg.appendChild(panel);
    closeButton.onclick = shut;
    bg.onclick = (event) => { if (event.target === bg) shut(); };
    document.addEventListener("keydown", key, true);
    document.body.appendChild(bg);
    grid.firstChild?.focus();
}

/** 아래 줄: 안내와 바로가기 단추(업데이트·받기 관리·새로고침·재시작). */
function buildFooter(shut) {
    const foot = el("div", "fla-hub-foot");
    const tip = el("span", "tip", t("hubTip"));
    const version = el("span", "ver");

    const button = (icon, label, tone = "") => {
        const b = el("button", tone);
        b.type = "button";
        const i = el("i");
        i.className = icon;
        b.append(i, document.createTextNode(label));
        return b;
    };
    const update = button("pi pi-arrow-circle-up", t("hubUpdate"), "new");
    const download = button("pi pi-download", t("hubDownloads"), "go");
    const reload = button("pi pi-refresh", t("hubReload"));
    const restart = button("pi pi-power-off", t("hubRestart"), "warn");
    const all = [update, download, reload, restart];
    update.style.display = "none";
    reload.title = t("hubReloadWhy");
    restart.title = t("hubRestartWhy");

    const busy = (text) => {
        for (const b of all) b.disabled = true;
        tip.textContent = text;
    };
    const idle = (error) => {
        for (const b of all) b.disabled = false;
        tip.textContent = t("hubTip");
        if (error) toast(error);
    };

    /** 서버를 다시 띄우고, 돌아오면 화면도 새로 받는다(새 노드·바뀐 스크립트가 들어오게). */
    const restartNow = async () => {
        busy(t("hubRestarting"));
        try {
            const { ok, data } = await post("/fla/restart");
            if (!ok || !data?.ok) throw new Error(data?.error ?? "");
        } catch (e) {
            idle(t("hubRestartFail") + (e.message || ""));
            return;
        }
        await waitForRestart();
        location.reload();
    };

    download.onclick = () => { shut(); openCivitaiPanel(null, "loras", null, "downloads"); };
    reload.onclick = () => location.reload();
    restart.onclick = () => { if (confirm(t("hubRestartConfirm"))) restartNow(); };

    // 새 판이 있는지 묻는다. 허브를 여는 데 기다리지 않게 뒤에서 한다.
    let latest = "";
    json("/fla/update/check").then(({ data }) => {
        if (data?.current) version.textContent = `v${data.current}`;
        if (!data?.ok || !data.available) return;
        latest = data.latest;
        update.lastChild.textContent = t("hubUpdate") + ` v${latest}`;
        update.title = t("hubUpdateWhy").replace("{from}", data.current).replace("{to}", latest);
        update.style.display = "";
    }).catch(() => { /* 오프라인이면 단추를 안 보일 뿐이다 */ });

    update.onclick = async () => {
        if (!confirm(t("hubUpdateConfirm").replace("{to}", latest))) return;
        busy(t("hubUpdating"));
        try {
            const { ok, data } = await post("/fla/update/apply");
            if (!ok || !data?.ok) throw new Error(data?.error ?? "");
        } catch (e) {
            idle(t("hubUpdateFail") + (e.message || ""));
            return;
        }
        // 바꾼 코드는 다시 띄워야 읽힌다
        await restartNow();
    };

    foot.append(tip, version, update, download, reload, restart);
    return foot;
}

/** 서버가 내려갔다가 다시 답할 때까지 기다린다. */
async function waitForRestart() {
    const alive = async () => {
        try {
            const res = await fetch("/system_stats", { cache: "no-store" });
            return res.ok;
        } catch (e) {
            return false;
        }
    };
    const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
    // 내려가는 데 잠깐 걸린다. 그 전에 답하면 아직 옛 서버다.
    for (let i = 0; i < 30 && await alive(); i++) await sleep(500);
    // 큰 확장이 많으면 다시 뜨는 데 몇 분 걸리기도 한다
    for (let i = 0; i < 300 && !await alive(); i++) await sleep(1000);
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
