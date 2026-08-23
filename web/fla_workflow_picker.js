/** 워크플로우 관리창.
 *
 *  와일드카드 창과 같은 뼈대(.fla-lp-*)를 쓴다. 미리보기 그림이 없고 글자로
 *  채우는 카드라는 점도 같다.
 *
 *  파일 이름만으로는 어떤 워크플로우인지 알기 어렵다. 그래서 서버가 JSON 을
 *  미리 훑어 노드 수와 쓰는 모델, 그리고 지금 설치본에 없는 노드를 세어 준다.
 *  마지막 것이 이 창을 만든 이유에 가깝다 — 열어보고 나서야 빨간 노드를
 *  발견하는 일을 카드에서 미리 알려준다.
 *
 *  카드를 누르면 ComfyUI 가 정식으로 여는 길을 탄다(탭이 생기고 제목이 붙는다).
 *  app.loadGraphData 의 네 번째 값에 workflows 아래 상대 경로를 주면
 *  프론트엔드가 그 이름의 워크플로우로 알아본다.
 */

import { app } from "../../scripts/app.js";
import { t } from "./fla_i18n.js";
import { releaseWidgetCaptureSoon } from "./fla_widget_mouse.js";
import { addStyles as addPickerStyles } from "./fla_lora_picker.js";
import { addMenuStyles, closeMenus, openContextMenu, toast } from "./fla_manage_menu.js";
import { openCivitaiPanel } from "./fla_civitai.js";

const SEARCH_DELAY = 300;
// 카드에 늘어놓을 모델 칩 수. 넘치면 "외 n개" 로 접는다.
const MAX_CHIPS = 3;
// 카드 그림을 바꾸는 간격(ms). 너무 빠르면 어지럽다.
const SHOT_SWAP = 3200;

let libraryPromise;
let settingsCache = null;

async function loadSettings() {
    if (settingsCache) return settingsCache;
    try {
        const res = await fetch("/fla/settings");
        settingsCache = res.ok ? ((await res.json()).settings ?? {}) : {};
    } catch (e) {
        settingsCache = {};
    }
    return settingsCache;
}

function saveSettings(patch) {
    settingsCache = { ...(settingsCache ?? {}), ...patch };
    fetch("/fla/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: patch }),
    }).catch(() => { /* 저장 실패해도 화면은 그대로 쓴다 */ });
}

async function library(refresh = false) {
    if (refresh) libraryPromise = undefined;
    libraryPromise ??= fetch("/fla/workflow-library").then((res) => {
        if (!res.ok) throw new Error(res.statusText);
        return res.json();
    }).then((data) => data.items ?? []);
    return libraryPromise;
}

/** 창 밖에서 워크플로우를 저장했을 수 있으니 다시 읽게 한다. */
export function forgetWorkflowLibrary() {
    libraryPromise = undefined;
}

async function post(url, body) {
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    let data = {};
    try { data = await res.json(); } catch (e) { /* 본문이 없을 수도 있다 */ }
    if (!res.ok || data.ok === false) throw new Error(data.error || res.statusText);
    return data;
}

function addStyles() {
    // 창 골격(.fla-lp-*)은 로라 창이 들고 있다. 그 창을 한 번도 열지 않았다면
    // 아직 문서에 없으므로 여기서 먼저 넣는다.
    addPickerStyles();
    addMenuStyles();
    if (document.getElementById("fla-wf-picker-style")) return;
    const style = document.createElement("style");
    style.id = "fla-wf-picker-style";
    style.textContent = `
      .fla-lp-head .civitai{display:flex;align-items:center;gap:7px;color:#fff;background:linear-gradient(180deg,#2181d6,#1971c2);border-color:#1864ab;font-weight:700}
      .fla-lp-head .civitai:hover{background:linear-gradient(180deg,#2f92e8,#1c7ed6);border-color:#1c7ed6}
      .fla-wf-card{display:flex;flex-direction:column;min-height:140px}
      .fla-wf-shot{position:relative;display:grid;width:100%;aspect-ratio:3 / 4;place-items:center;overflow:hidden;background:#111318;border-bottom:1px solid #2f353e}
      .fla-wf-shot img{position:absolute;inset:0;display:block;width:100%;height:100%;object-fit:cover;transition:opacity .7s ease}
      .fla-wf-shot img.off{opacity:0}
      .fla-wf-dots{position:absolute;z-index:2;left:9px;bottom:8px;display:flex;gap:4px}
      .fla-wf-dots span{width:6px;height:6px;background:#fff6;border-radius:50%;transition:background .3s}
      .fla-wf-dots span.on{background:#fff}
      .fla-wf-new{position:absolute;z-index:2;left:9px;top:9px;padding:2px 8px;color:#171717;background:#ffd84d;border-radius:4px;font-size:10px;font-weight:700}
      .fla-wf-shade{position:absolute;inset:0;pointer-events:none;background:linear-gradient(#000c,#0000 34%,#0000 58%,#000d)}
      .fla-wf-cap{position:absolute;top:8px;left:9px;right:40px;pointer-events:none;color:#fff;font-weight:700;line-height:1.28;text-shadow:0 1px 3px #000;overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden}
      .fla-wf-mine{position:absolute;left:9px;bottom:8px;padding:2px 7px;color:#8ee0a1;background:#000c;border-radius:4px;font-size:10px}
      .fla-wf-card .fla-wf-star{position:absolute;z-index:2;top:6px;right:7px;width:30px;height:30px}
      .fla-wf-head{display:flex;align-items:flex-start;gap:8px;padding:10px 10px 6px}
      .fla-wf-name{flex:1;min-width:0;color:#fff;font-weight:700;line-height:1.3;overflow-wrap:anywhere}
      .fla-wf-star{flex:none;width:26px;height:26px;padding:0;color:#fff;background:#111a;border:0;border-radius:50%;font-size:17px;cursor:pointer}
      .fla-wf-star.on{color:#ffd34e}
      .fla-wf-stats{display:flex;flex-wrap:wrap;gap:5px;padding:0 10px 7px}
      .fla-wf-stat{padding:2px 7px;color:#cfd6de;background:#2b3138;border-radius:4px;font-size:11px;white-space:nowrap}
      .fla-wf-stat.warn{color:#171717;background:#ffd84d;font-weight:700;cursor:help}
      .fla-wf-stat.bad{color:#fff;background:#a83426}
      .fla-wf-models{flex:1;display:flex;flex-wrap:wrap;align-content:flex-start;gap:4px;margin:0 10px;padding:7px 8px;overflow:hidden;background:#1b1e24;border:1px solid #2f353e;border-radius:6px;max-height:78px}
      .fla-wf-chip{max-width:100%;padding:2px 7px;color:#8ec5ff;background:#1e2b3a;border-radius:4px;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .fla-wf-chip.dim{color:#8d95a1;background:#242830}
      .fla-wf-none{color:#6e7681;font-size:11px}
      .fla-wf-foot{display:flex;align-items:center;gap:6px;padding:8px 10px 10px;color:#7d858f;font-size:11px}
      .fla-wf-when{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .fla-wf-where{margin-left:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .fla-wf-dt-bg{position:fixed;inset:0;z-index:100012;background:#000b;display:grid;place-items:center;padding:3vh}
      .fla-wf-dt{width:min(1000px,94vw);height:min(820px,92vh);display:flex;flex-direction:column;background:#181a1f;color:#ddd;border:1px solid #4b5360;border-radius:12px;overflow:hidden;box-shadow:0 22px 70px #000;font:14px Arial,sans-serif}
      .fla-wf-dt-head{display:flex;align-items:flex-start;gap:10px;padding:13px 14px;background:#22262d;border-bottom:1px solid #383e48}
      .fla-wf-dt-head h2{flex:1;margin:0;font-size:16px;font-weight:700;color:#fff;overflow-wrap:anywhere}
      .fla-wf-dt-head .sub{margin-top:3px;color:#98a1ad;font-size:12px}
      .fla-wf-dt-head button{flex:none;height:34px;padding:0 12px;color:#ddd;background:#303640;border:1px solid #454c58;border-radius:7px;font-size:13px;cursor:pointer}
      .fla-wf-dt-head button:hover{background:#3a424e}
      .fla-wf-dt-head button.go{color:#fff;background:#2f6fd0;border-color:#3b82f6}.fla-wf-dt-head button.go:hover{background:#3b82f6}
      .fla-wf-dt-body{display:grid;grid-template-columns:minmax(230px,320px) 1fr;gap:16px;flex:1;min-height:0;padding:15px;overflow-y:auto}
      @media (max-width:720px){.fla-wf-dt-body{grid-template-columns:1fr}}
      .fla-wf-dt-shot{overflow:hidden;background:#111318;border:1px solid #3b424d;border-radius:9px}
      .fla-wf-dt-shot img{display:block;width:100%;height:auto}
      .fla-wf-dt-sec{margin-bottom:16px}
      .fla-wf-dt-sec>h3{margin:0 0 7px;color:#8d95a1;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.4px}
      .fla-wf-dt-rows{display:grid;grid-template-columns:max-content 1fr;gap:6px 14px}
      .fla-wf-dt-rows dt{color:#8d95a1;font-size:12px}.fla-wf-dt-rows dd{margin:0;color:#dde2e8;font-size:13px;overflow-wrap:anywhere}
      .fla-wf-dt-list{max-height:210px;overflow-y:auto;padding:8px 10px;background:#1b1e24;border:1px solid #2f353e;border-radius:7px;font-size:12px;line-height:1.6}
      .fla-wf-dt-list div{overflow-wrap:anywhere}
      .fla-wf-dt-list .bad{color:#ffb4a8}
      .fla-wf-dt-list .row{display:flex;align-items:center;gap:8px}
      .fla-wf-dt-list .row span{flex:1;min-width:0;overflow-wrap:anywhere}
      .fla-wf-find{flex:none;padding:2px 9px;color:#dbe3ea;background:#2b3138;border:1px solid #3d444e;border-radius:5px;font-size:11px;cursor:pointer}
      .fla-wf-find:hover{background:#3a424e;border-color:#5a6472}
      .fla-hf-bg{position:fixed;inset:0;z-index:100016;background:#000b;display:grid;place-items:center;padding:3vh}
      .fla-hf{width:min(880px,94vw);height:min(760px,90vh);display:flex;flex-direction:column;background:#181a1f;color:#ddd;border:1px solid #4b5360;border-radius:12px;overflow:hidden;box-shadow:0 22px 70px #000;font:14px Arial,sans-serif}
      .fla-hf-head{display:flex;align-items:center;gap:9px;padding:11px 13px;background:#22262d;border-bottom:1px solid #383e48}
      .fla-hf-head h2{flex:none;margin:0;font-size:15px;font-weight:700;color:#fff}
      .fla-hf-head input{flex:1;min-width:0;height:34px;padding:0 11px;color:#eee;background:#111419;border:1px solid #454c58;border-radius:7px}
      .fla-hf-head select,.fla-hf-head button{height:34px;padding:0 12px;color:#ddd;background:#303640;border:1px solid #454c58;border-radius:7px;cursor:pointer}
      .fla-hf-head button.go{color:#fff;background:#2f6fd0;border-color:#3b82f6}
      .fla-hf-body{flex:1;min-height:0;padding:12px 13px;overflow-y:auto}
      .fla-hf-repo{margin-bottom:8px;background:#22262d;border:1px solid #383e48;border-radius:9px;overflow:hidden}
      .fla-hf-repo>summary{display:flex;align-items:center;gap:9px;padding:10px 12px;cursor:pointer;list-style:none}
      .fla-hf-repo>summary::-webkit-details-marker{display:none}
      .fla-hf-name{flex:1;min-width:0;color:#fff;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .fla-hf-meta{flex:none;color:#98a1ad;font-size:12px;white-space:nowrap}
      .fla-hf-gate{flex:none;padding:2px 7px;color:#171717;background:#ffd84d;border-radius:4px;font-size:10px;font-weight:700}
      .fla-hf-files{padding:0 12px 11px}
      .fla-hf-file{display:flex;align-items:center;gap:9px;padding:6px 0;border-top:1px solid #2f353e;font-size:12px}
      .fla-hf-file span.p{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#c8cdd5}
      .fla-hf-file span.s{flex:none;color:#98a1ad;white-space:nowrap}
      .fla-hf-file button{flex:none;height:26px;padding:0 11px;color:#fff;background:#2f6fd0;border:1px solid #3b82f6;border-radius:6px;font-size:11px;cursor:pointer}
      .fla-hf-file button:disabled{opacity:.5;cursor:default}
      .fla-hf-none{padding:44px;text-align:center;color:#89919d;line-height:1.7}
      .fla-wf-dt-note{white-space:pre-wrap;overflow-wrap:anywhere;color:#c8cdd5;font-size:12px;line-height:1.6}
      .fla-wf-org-bg{position:fixed;inset:0;z-index:100014;background:#000b;display:grid;place-items:center;padding:3vh}
      .fla-wf-org{width:min(760px,94vw);max-height:88vh;display:flex;flex-direction:column;background:#181a1f;color:#ddd;border:1px solid #4b5360;border-radius:12px;overflow:hidden;box-shadow:0 22px 70px #000;font:14px Arial,sans-serif}
      .fla-wf-org-head{display:flex;align-items:center;gap:10px;padding:12px 14px;background:#22262d;border-bottom:1px solid #383e48}
      .fla-wf-org-head h2{flex:1;margin:0;font-size:15px;font-weight:700;color:#fff}
      .fla-wf-org-body{flex:1;min-height:0;padding:13px 14px;overflow-y:auto}
      .fla-wf-org-row{display:flex;align-items:center;gap:9px;padding:8px 9px;margin-bottom:6px;background:#22262d;border:1px solid #383e48;border-radius:8px}
      .fla-wf-org-row input{margin:0;cursor:pointer}
      .fla-wf-org-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .fla-wf-org-to{padding:2px 8px;color:#8ec5ff;background:#1e2b3a;border-radius:4px;font-size:12px;white-space:nowrap}
      .fla-wf-org-why{color:#7d858f;font-size:11px;white-space:nowrap}
      .fla-wf-org-foot{display:flex;justify-content:flex-end;gap:8px;padding:11px 14px;background:#1d2026;border-top:1px solid #383e48}
      .fla-wf-org-foot button{height:34px;padding:0 15px;color:#ddd;background:#303640;border:1px solid #454c58;border-radius:7px;cursor:pointer}
      .fla-wf-org-foot .go{color:#fff;background:#2f6fd0;border-color:#3b82f6}.fla-wf-org-foot .go:hover:not(:disabled){background:#3b82f6}
      .fla-wf-org-foot button:disabled{opacity:.45;cursor:default}
      .fla-wf-org-none{padding:40px;text-align:center;color:#89919d;line-height:1.7}
      .fla-wf-up-row{display:flex;align-items:center;gap:10px;padding:10px 11px;margin-bottom:7px;background:#22262d;border:1px solid #383e48;border-radius:9px}
      .fla-wf-up-main{flex:1;min-width:0}
      .fla-wf-up-name{color:#fff;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .fla-wf-up-sub{margin-top:3px;color:#98a1ad;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .fla-wf-up-step{display:inline-flex;align-items:center;gap:6px;margin-top:5px;font-size:11px}
      .fla-wf-up-step .from{padding:2px 7px;color:#c8cdd5;background:#2b3138;border-radius:4px}
      .fla-wf-up-step .to{padding:2px 7px;color:#171717;background:#ffd84d;border-radius:4px;font-weight:700}
      .fla-wf-up-acts{flex:none;display:flex;flex-direction:column;gap:5px}
      .fla-wf-up-acts button{height:30px;padding:0 12px;color:#fff;background:#2f6fd0;border:1px solid #3b82f6;border-radius:7px;font-size:12px;font-weight:600;cursor:pointer}
      .fla-wf-up-acts button:hover:not(:disabled){background:#3b82f6}
      .fla-wf-up-acts button.plain{color:#ddd;background:#303640;border-color:#454c58;font-weight:400}
      .fla-wf-up-acts button:disabled{opacity:.45;cursor:default}
      .fla-wf-up-warn{margin-top:5px;padding:5px 8px;color:#e0cd9d;background:#2a2418;border:1px solid #5c4a22;border-radius:6px;font-size:11px;line-height:1.5}
      .fla-wf-rep{padding:11px 13px;background:#1b1e24;border:1px solid #2f353e;border-radius:8px;font-size:12px;line-height:1.7}
      .fla-wf-rep b{color:#fff}
      .fla-wf-rep .line{display:flex;gap:8px}
      .fla-wf-rep .tag{flex:none;min-width:78px;color:#8d95a1}
      .fla-wf-rep .keep{color:#8ee0a1}.fla-wf-rep .take{color:#8ec5ff}
      .fla-wf-rep .warn{color:#ffd88a}.fla-wf-rep .bad{color:#ff9a8f}
    `;
    document.head.appendChild(style);
}

function allFolders(items) {
    const result = new Set([""]);
    for (const item of items) {
        const parts = item.folder.split("/").filter(Boolean);
        for (let i = 1; i <= parts.length; i++) result.add(parts.slice(0, i).join("/"));
    }
    return [...result].sort((a, b) => a.localeCompare(b));
}

function contains(item, folder) {
    return !folder || item.folder === folder || item.folder.startsWith(folder + "/");
}

function prettySize(bytes) {
    const value = Number(bytes) || 0;
    if (value >= 1e6) return `${(value / 1e6).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(value / 1e3))} KB`;
}

function prettyWhen(seconds) {
    if (!seconds) return "";
    const date = new Date(seconds * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function highlighted(element, text, query) {
    element.replaceChildren();
    if (!query) {
        element.textContent = text;
        return;
    }
    const lower = text.toLocaleLowerCase();
    const needle = query.toLocaleLowerCase();
    let start = 0;
    let found;
    while ((found = lower.indexOf(needle, start)) !== -1) {
        element.append(document.createTextNode(text.slice(start, found)));
        const mark = document.createElement("span");
        mark.className = "fla-lp-mark";
        mark.textContent = text.slice(found, found + needle.length);
        element.appendChild(mark);
        start = found + needle.length;
    }
    element.append(document.createTextNode(text.slice(start)));
}


/** 워크플로우 관리창을 연다. 닫히면 끝난다. */
export async function openWorkflowManager() {
    releaseWidgetCaptureSoon();
    const [items, saved] = await Promise.all([library(true), loadSettings()]);
    addStyles();

    // 다른 창들과 설정을 나눠 쓰면 서로 폴더가 튀므로 wf 접두사로 따로 저장한다.
    let folder = typeof saved.wfFolder === "string" ? saved.wfFolder : "";
    let favoritesOnly = saved.wfFavoritesOnly === true;
    let includeChildren = saved.wfIncludeChildren !== false;
    let allExpanded = saved.wfAllExpanded === true;
    const folders = allFolders(items);
    // 업데이트 확인에서 새 버전이 있다고 나온 것들
    const newer = new Map();
    const expanded = new Set(Array.isArray(saved.wfExpanded) ? saved.wfExpanded : []);
    if (folder && !folders.includes(folder)) folder = "";

    const bg = document.createElement("div");
    bg.className = "fla-lp-bg";
    bg.innerHTML = `<div class="fla-lp" role="dialog" aria-modal="true"><div class="fla-lp-head"><input type="search" placeholder="${t("wfSearch")}"><div class="fla-lp-hint">${t("wfHint")}</div><button class="fav">☆ ${t("loraFavorites")}</button><button class="civitai" title="${t("wfCivitaiTip")}">Civitai<span class="dot"></span></button><button class="organize" title="${t("wfOrganizeTip")}">${t("wfOrganize")}</button><button class="folder" title="${t("wfReveal")}">📂</button><button class="reload" title="${t("wfRefresh")}">⟳</button><button class="close" title="${t("cancel")}">×</button></div><div class="fla-lp-main"><aside class="fla-lp-side"></aside><section class="fla-lp-content"><div class="fla-lp-path"></div><div class="fla-lp-grid"></div></section></div></div>`;
    document.body.appendChild(bg);
    const input = bg.querySelector("input");
    const fav = bg.querySelector(".fav");
    const civitaiButton = bg.querySelector(".civitai");
    const organizeButton = bg.querySelector(".organize");
    const revealButton = bg.querySelector(".folder");
    const reload = bg.querySelector(".reload");
    const side = bg.querySelector(".fla-lp-side");
    const path = bg.querySelector(".fla-lp-path");
    const grid = bg.querySelector(".fla-lp-grid");

    // 카드 그림을 번갈아 보여주는 타이머들. 창을 닫을 때 모두 멈춘다.
    const timers = [];
    let searchTimer = null;
    const searchLater = () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(render, SEARCH_DELAY);
    };

    let closed = false;
    const close = () => {
        if (closed) return;
        closed = true;
        clearTimeout(searchTimer);
        for (const tick of timers) clearInterval(tick);
        timers.length = 0;
        closeMenus();
        document.removeEventListener("keydown", key, true);
        document.removeEventListener("click", outside);
        bg.remove();
    };
    const key = (event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        if (document.querySelector(".fla-lp-menu,.fla-mm-ctx")) closeMenus();
        else close();
    };
    const outside = (event) => { if (!event.target.closest(".fla-lp-crumb,.fla-mm-ctx")) closeMenus(); };

    const choose = (value) => {
        folder = value;
        saveSettings({ wfFolder: folder });
        const parts = value.split("/").filter(Boolean);
        for (let i = 1; i <= parts.length; i++) expanded.add(parts.slice(0, i).join("/"));
        closeMenus();
        render();
    };

    async function refreshItems() {
        const fresh = await library(true);
        items.length = 0; items.push(...fresh);
        folders.length = 0; folders.push(...allFolders(items));
        if (folder && !folders.includes(folder)) folder = "";
        render();
    }

    // ---------------------------------------------- 열기·이름 바꾸기·삭제

    /** 워크플로우를 캔버스에 올린다.
     *
     *  네 번째 값에 workflows 아래 상대 경로를 주면 ComfyUI 가 그 이름의
     *  워크플로우로 알아보고 탭을 만든다. 창 밖에서 파일이 늘었을 수 있으니
     *  프론트엔드가 아는 목록을 먼저 맞춰 둔다.
     */
    async function openWorkflow(item) {
        try {
            await app.extensionManager?.workflow?.syncWorkflows?.();
        } catch (e) {
            // 목록을 못 맞춰도 여는 것 자체는 해본다
        }
        let data;
        try {
            const res = await fetch(`/fla/workflow-content?name=${encodeURIComponent(item.name)}`);
            const body = await res.json();
            if (!res.ok || body.ok === false) throw new Error(body.error || res.statusText);
            data = body.workflow;
        } catch (e) {
            toast(t("wfOpenFail") + e.message, true);
            return;
        }
        close();
        try {
            await app.loadGraphData(data, true, true, item.name);
        } catch (e) {
            toast(t("wfOpenFail") + (e?.message ?? e), true);
        }
    }

    async function rename(item) {
        const next = prompt(t("wfRenamePrompt"), item.name);
        if (next === null) return;
        const clean = next.trim();
        if (!clean || clean === item.name) return;
        try {
            await post("/fla/workflow-rename", { name: item.name, new_name: clean });
            await refreshItems();
        } catch (e) {
            toast(t("wfRenameFail") + e.message, true);
        }
    }

    async function removeWorkflow(item) {
        if (!confirm(t("wfDeleteConfirm").replace("{name}", item.name))) return;
        try {
            await post("/fla/workflow-delete", { name: item.name });
            toast(t("wfDeleted"));
            await refreshItems();
            // 지운 파일이 탭에 남아 있지 않게 프론트엔드 목록도 맞춘다
            try { await app.extensionManager?.workflow?.syncWorkflows?.(); } catch (e) { /* 없으면 넘어간다 */ }
        } catch (e) {
            toast(t("wfDeleteFail") + e.message, true);
        }
    }

    async function reveal(item = null) {
        try {
            await post("/fla/workflow-reveal", { name: item?.name ?? "" });
        } catch (e) {
            toast(t("mmRevealFail") + e.message, true);
        }
    }

    function openMenu(item, event) {
        const entries = [
            [t("wfOpen"), () => openWorkflow(item)],
            [t("wfDetail"), () => showDetail(item)],
            [null],
            [t("wfSetShot"), () => uploadShot(item)],
        ];
        // 올려둔 그림이 있을 때만 되돌리기를 보여준다
        if (item.custom_preview) entries.push([t("wfClearShot"), () => clearShot(item)]);
        entries.push([null], [t("wfRename"), () => rename(item)], [t("wfReveal"), () => reveal(item)],
                     [null], [t("delete"), () => removeWorkflow(item), true]);
        openContextMenu(entries, event);
    }

    /** 결과 사진을 대표 그림으로 올린다. 올리면 미니맵보다 이쪽이 이긴다. */
    function uploadShot(item) {
        const picker = document.createElement("input");
        picker.type = "file";
        picker.accept = "image/*";
        picker.onchange = async () => {
            const file = picker.files?.[0];
            if (!file) return;
            const form = new FormData();
            form.append("name", item.name);
            form.append("file", file);
            try {
                const res = await fetch("/fla/workflow-preview-upload", { method: "POST", body: form });
                const data = await res.json();
                if (!res.ok || data.ok === false) throw new Error(data.error || res.statusText);
                toast(t("wfShotDone"));
                await refreshItems();
            } catch (e) {
                toast(t("wfShotFail") + e.message, true);
            }
        };
        picker.click();
    }

    /** 올려둔 그림을 지우고 미니맵으로 되돌린다. */
    async function clearShot(item) {
        try {
            await post("/fla/workflow-preview-clear", { name: item.name });
            await refreshItems();
        } catch (e) {
            toast(t("wfShotFail") + e.message, true);
        }
    }

    // ---------------------------------------------- 상세 창

    /** 이 워크플로우가 무엇을 쓰는지 한 화면에 펴 준다. */
    async function showDetail(item) {
        let data;
        try {
            const res = await fetch(`/fla/workflow-detail?name=${encodeURIComponent(item.name)}`);
            data = await res.json();
            if (!res.ok || data.ok === false) throw new Error(data.error || res.statusText);
        } catch (e) {
            toast(t("wfDetailFail") + e.message, true);
            return;
        }

        const back = document.createElement("div");
        back.className = "fla-wf-dt-bg";
        const panel = document.createElement("div");
        panel.className = "fla-wf-dt";
        panel.setAttribute("role", "dialog");
        panel.setAttribute("aria-modal", "true");

        const head = document.createElement("div");
        head.className = "fla-wf-dt-head";
        const titles = document.createElement("div");
        titles.style.cssText = "flex:1;min-width:0";
        titles.appendChild(Object.assign(document.createElement("h2"), { textContent: data.title }));
        titles.appendChild(Object.assign(document.createElement("div"),
            { className: "sub", textContent: [data.folder || t("wfRoot"), prettySize(data.size), prettyWhen(data.modified)].filter(Boolean).join("  ·  ") }));
        const openIt = document.createElement("button");
        openIt.className = "go";
        openIt.textContent = t("wfOpen");
        const shut = document.createElement("button");
        shut.textContent = "×";
        head.append(titles, openIt, shut);

        const body = document.createElement("div");
        body.className = "fla-wf-dt-body";

        const left = document.createElement("div");
        const shotBox = document.createElement("div");
        shotBox.className = "fla-wf-dt-shot";
        const big = document.createElement("img");
        big.src = `/fla/workflow-preview?name=${encodeURIComponent(item.name)}&v=${data.modified}`;
        big.alt = "";
        big.onerror = () => shotBox.remove();
        shotBox.appendChild(big);
        left.appendChild(shotBox);

        const right = document.createElement("div");
        const section = (label, node) => {
            const box = document.createElement("div");
            box.className = "fla-wf-dt-sec";
            box.appendChild(Object.assign(document.createElement("h3"), { textContent: label }));
            box.appendChild(node);
            right.appendChild(box);
        };

        const rows = document.createElement("dl");
        rows.className = "fla-wf-dt-rows";
        const row = (label, value) => {
            rows.appendChild(Object.assign(document.createElement("dt"), { textContent: label }));
            rows.appendChild(Object.assign(document.createElement("dd"), { textContent: value }));
        };
        row(t("wfNodesLabel"), `${data.nodes}${data.muted ? ` (${t("wfMuted").replace("{n}", data.muted)})` : ""}`);
        if (data.subgraphs) row(t("wfSubgraphs"), String(data.subgraphs));
        row(t("wfFileName"), data.name);
        section(t("wfSummary"), rows);

        if (data.source?.model_id) {
            const rows2 = document.createElement("dl");
            rows2.className = "fla-wf-dt-rows";
            const row2 = (label, value) => {
                rows2.appendChild(Object.assign(document.createElement("dt"), { textContent: label }));
                rows2.appendChild(Object.assign(document.createElement("dd"), { textContent: value }));
            };
            row2(t("wfFromModel"), data.source.model_name || String(data.source.model_id));
            if (data.source.version_name) row2(t("wfFromVersion"), data.source.version_name);
            if (data.source.creator) row2(t("wfFromCreator"), `@${data.source.creator}`);
            const open = document.createElement("a");
            open.href = `https://civitai.com/models/${data.source.model_id}`;
            open.target = "_blank";
            open.rel = "noopener noreferrer";
            open.textContent = t("civitaiUpdateOpen");
            open.style.cssText = "display:inline-block;margin-top:6px;color:#5aa9ff";
            const wrap = document.createElement("div");
            wrap.append(rows2, open);
            if (!data.has_base) {
                wrap.appendChild(Object.assign(document.createElement("div"),
                    { className: "fla-wf-up-warn", textContent: t("wfMergeNoBase") }));
            }
            section(t("wfSource"), wrap);
        }

        if (data.missing.length) {
            const list = document.createElement("div");
            list.className = "fla-wf-dt-list";
            for (const kind of data.missing) {
                list.appendChild(Object.assign(document.createElement("div"),
                    { className: "bad", textContent: kind }));
            }
            section(t("wfMissingTitle"), list);
        }

        if (data.models.length) {
            const list = document.createElement("div");
            list.className = "fla-wf-dt-list";
            for (const value of data.models) {
                const row = document.createElement("div");
                row.className = "row";
                row.appendChild(Object.assign(document.createElement("span"), { textContent: value }));
                // 이 모델이 없으면 허깅페이스에서 찾아 받을 수 있게 한다
                const find = document.createElement("button");
                find.className = "fla-wf-find";
                find.textContent = t("wfFindModel");
                find.onclick = () => openHuggingFace(value);
                row.appendChild(find);
                list.appendChild(row);
            }
            section(t("wfModelsTitle"), list);
        }

        if (data.counts.length) {
            const list = document.createElement("div");
            list.className = "fla-wf-dt-list";
            for (const [kind, count] of data.counts) {
                list.appendChild(Object.assign(document.createElement("div"),
                    { textContent: count > 1 ? `${kind}  ×${count}` : kind }));
            }
            section(t("wfNodeKinds"), list);
        }

        if (data.notes.length) {
            const note = document.createElement("div");
            note.className = "fla-wf-dt-note";
            note.textContent = data.notes.join("\n\n———\n\n");
            section(t("wfNotes"), note);
        }

        if (data.groups.length) {
            const chips = document.createElement("div");
            chips.style.cssText = "display:flex;flex-wrap:wrap;gap:5px";
            for (const title of data.groups) {
                chips.appendChild(Object.assign(document.createElement("span"),
                    { className: "fla-wf-chip dim", textContent: title }));
            }
            section(t("wfGroups"), chips);
        }

        body.append(left, right);
        panel.append(head, body);
        back.appendChild(panel);

        let gone = false;
        const dismiss = () => {
            if (gone) return;
            gone = true;
            document.removeEventListener("keydown", esc, true);
            back.remove();
        };
        // 이 창이 열려 있는 동안에는 Esc 가 목록 창까지 닫지 않게 막는다
        const esc = (event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            dismiss();
        };
        shut.onclick = dismiss;
        back.onclick = (event) => { if (event.target === back) dismiss(); };
        openIt.onclick = () => { dismiss(); openWorkflow(item); };
        document.addEventListener("keydown", esc, true);
        document.body.appendChild(back);
        openIt.focus();
    }

    // ---------------------------------------------- 허깅페이스에서 찾기

    /** 없는 모델을 허깅페이스에서 찾아 받는다.
     *
     *  Civitai 에 없는 모델이 꽤 있다(요즘 영상 모델, 텍스트 인코더, VAE).
     *  파일 이름에서 확장자와 폴더를 떼고 그것으로 먼저 찾아 준다.
     */
    async function openHuggingFace(modelPath) {
        const guess = String(modelPath || "").split("/").pop().replace(/\.[a-z0-9]+$/i, "");

        const back = document.createElement("div");
        back.className = "fla-hf-bg";
        const panel = document.createElement("div");
        panel.className = "fla-hf";

        const head = document.createElement("div");
        head.className = "fla-hf-head";
        head.appendChild(Object.assign(document.createElement("h2"), { textContent: "Hugging Face" }));
        const box = document.createElement("input");
        box.type = "search";
        box.value = guess;
        box.placeholder = t("hfSearchPlaceholder");
        const where = document.createElement("select");
        where.appendChild(new Option(t("civitaiTypeCheckpoint"), "checkpoints"));
        where.appendChild(new Option(t("civitaiTypeLora"), "loras"));
        const go = document.createElement("button");
        go.className = "go";
        go.textContent = t("civitaiSearch");
        const shut = document.createElement("button");
        shut.textContent = "×";
        head.append(box, where, go, shut);

        const body = document.createElement("div");
        body.className = "fla-hf-body";
        panel.append(head, body);
        back.appendChild(panel);

        let gone = false;
        const dismiss = () => {
            if (gone) return;
            gone = true;
            document.removeEventListener("keydown", esc, true);
            back.remove();
        };
        const esc = (event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            dismiss();
        };
        shut.onclick = dismiss;
        back.onclick = (event) => { if (event.target === back) dismiss(); };
        document.addEventListener("keydown", esc, true);

        async function search() {
            go.disabled = true;
            body.replaceChildren(Object.assign(document.createElement("div"),
                { className: "fla-hf-none", textContent: t("loading") }));
            let items = [];
            try {
                const res = await fetch(`/fla/hf/search?q=${encodeURIComponent(box.value.trim())}`);
                const data = await res.json();
                if (!res.ok || data.ok === false) throw new Error(data.error || res.statusText);
                items = data.items ?? [];
            } catch (e) {
                body.replaceChildren(Object.assign(document.createElement("div"),
                    { className: "fla-hf-none", textContent: t("hfFail") + e.message }));
                return;
            } finally {
                go.disabled = false;
            }

            body.replaceChildren();
            if (!items.length) {
                body.appendChild(Object.assign(document.createElement("div"),
                    { className: "fla-hf-none", textContent: t("hfNone") }));
                return;
            }
            for (const repo of items) body.appendChild(repoRow(repo));
        }

        function repoRow(repo) {
            const box2 = document.createElement("details");
            box2.className = "fla-hf-repo";
            const top = document.createElement("summary");
            top.appendChild(Object.assign(document.createElement("span"),
                { className: "fla-hf-name", textContent: repo.repo }));
            if (repo.gated) {
                top.appendChild(Object.assign(document.createElement("span"),
                    { className: "fla-hf-gate", textContent: t("hfGated") }));
            }
            top.appendChild(Object.assign(document.createElement("span"), {
                className: "fla-hf-meta",
                textContent: `↓${repo.downloads ?? 0}  ♥${repo.likes ?? 0}  ${repo.updated}`,
            }));
            box2.appendChild(top);

            const files = document.createElement("div");
            files.className = "fla-hf-files";
            box2.appendChild(files);

            let loaded = false;
            box2.addEventListener("toggle", async () => {
                if (!box2.open || loaded) return;
                loaded = true;
                files.replaceChildren(Object.assign(document.createElement("div"),
                    { className: "fla-hf-file", textContent: t("loading") }));
                try {
                    const res = await fetch(`/fla/hf/files?repo=${encodeURIComponent(repo.repo)}`);
                    const data = await res.json();
                    if (!res.ok || data.ok === false) throw new Error(data.error || res.statusText);
                    files.replaceChildren();
                    if (!(data.files ?? []).length) {
                        files.appendChild(Object.assign(document.createElement("div"),
                            { className: "fla-hf-file", textContent: t("hfNoFiles") }));
                        return;
                    }
                    for (const file of data.files) files.appendChild(fileRow(repo, file));
                } catch (e) {
                    loaded = false;
                    files.replaceChildren(Object.assign(document.createElement("div"),
                        { className: "fla-hf-file", textContent: t("hfFail") + e.message }));
                }
            });
            return box2;
        }

        function fileRow(repo, file) {
            const row = document.createElement("div");
            row.className = "fla-hf-file";
            row.appendChild(Object.assign(document.createElement("span"),
                { className: "p", textContent: file.path, title: file.path }));
            row.appendChild(Object.assign(document.createElement("span"),
                { className: "s", textContent: file.size_text }));
            const grab = document.createElement("button");
            grab.textContent = t("civitaiDownload");
            grab.onclick = async () => {
                grab.disabled = true;
                grab.textContent = t("hfGetting");
                try {
                    const got = await post("/fla/hf/download",
                        { repo: repo.repo, path: file.path, kind: where.value });
                    grab.textContent = t("hfGot");
                    toast(t("hfDone").replace("{name}", got.name));
                } catch (e) {
                    grab.disabled = false;
                    grab.textContent = t("civitaiDownload");
                    toast(t("hfFail") + e.message, true);
                }
            };
            row.appendChild(grab);
            return row;
        }

        go.onclick = search;
        box.addEventListener("keydown", (event) => { if (event.key === "Enter") search(); });
        document.body.appendChild(back);
        search();
    }

    // ---------------------------------------------- 새 버전 확인과 합치기

    /** Civitai 창에서 확인해 둔 결과만 읽어 카드에 딱지를 찍는다.
     *  여기서는 Civitai 를 부르지 않는다(목록 여는 것이 느려지면 안 된다). */
    async function loadNewer() {
        newer.clear();
        try {
            const res = await fetch("/fla/workflow-updates/cached");
            const data = await res.json();
            for (const item of data.items ?? []) {
                if (item.name) newer.set(item.name, item);
            }
        } catch (e) {
            // 못 읽어도 딱지만 안 붙는다
        }
        const dot = civitaiButton.querySelector(".dot");
        if (dot) dot.style.display = newer.size ? "" : "none";
        render();
    }

    // ---------------------------------------------- 폴더 정리

    /** 뿌리에 흩어진 워크플로우를 계열에 맞는 폴더로 보내자고 제안한다. */
    async function organize() {
        organizeButton.disabled = true;
        let moves = [];
        try {
            const res = await fetch("/fla/workflow-organize");
            const data = await res.json();
            if (!res.ok || data.ok === false) throw new Error(data.error || res.statusText);
            moves = data.moves ?? [];
        } catch (e) {
            toast(t("wfOrganizeFail") + e.message, true);
            return;
        } finally {
            organizeButton.disabled = false;
        }

        const back = document.createElement("div");
        back.className = "fla-wf-org-bg";
        const panel = document.createElement("div");
        panel.className = "fla-wf-org";

        const head = document.createElement("div");
        head.className = "fla-wf-org-head";
        head.appendChild(Object.assign(document.createElement("h2"), { textContent: t("wfOrganize") }));
        const shut = document.createElement("button");
        shut.textContent = "×";
        shut.style.cssText = "width:30px;height:30px;padding:0;color:#ddd;background:#303640;border:1px solid #454c58;border-radius:6px;font-size:17px;cursor:pointer";
        head.appendChild(shut);

        const body = document.createElement("div");
        body.className = "fla-wf-org-body";
        const boxes = [];
        if (!moves.length) {
            body.appendChild(Object.assign(document.createElement("div"),
                { className: "fla-wf-org-none", textContent: t("wfOrganizeNone") }));
        } else {
            for (const move of moves) {
                const line = document.createElement("label");
                line.className = "fla-wf-org-row";
                const tick = document.createElement("input");
                tick.type = "checkbox";
                tick.checked = true;
                boxes.push([tick, move]);
                line.append(tick,
                    Object.assign(document.createElement("span"),
                        { className: "fla-wf-org-name", textContent: move.title, title: move.name }),
                    Object.assign(document.createElement("span"),
                        { className: "fla-wf-org-why", textContent: move.family }),
                    Object.assign(document.createElement("span"),
                        { className: "fla-wf-org-to", textContent: `→ ${move.to}` }));
                body.appendChild(line);
            }
        }

        const foot = document.createElement("div");
        foot.className = "fla-wf-org-foot";
        const cancel = document.createElement("button");
        cancel.textContent = t("cancel");
        const apply = document.createElement("button");
        apply.className = "go";
        apply.textContent = t("wfOrganizeApply");
        apply.disabled = !moves.length;
        foot.append(cancel, apply);

        panel.append(head, body, foot);
        back.appendChild(panel);

        let gone = false;
        const dismiss = () => {
            if (gone) return;
            gone = true;
            document.removeEventListener("keydown", esc, true);
            back.remove();
        };
        const esc = (event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            dismiss();
        };
        shut.onclick = dismiss;
        cancel.onclick = dismiss;
        back.onclick = (event) => { if (event.target === back) dismiss(); };
        document.addEventListener("keydown", esc, true);

        apply.onclick = async () => {
            const picked = boxes.filter(([tick]) => tick.checked).map(([, move]) => move);
            if (!picked.length) { dismiss(); return; }
            apply.disabled = true;
            try {
                const data = await post("/fla/workflow-organize", { moves: picked });
                const moved = data.moved?.length ?? 0;
                const failed = data.failed?.length ?? 0;
                toast(failed
                    ? `${t("wfOrganizeDone").replace("{n}", moved)} · ${t("wfOrganizeFailed").replace("{n}", failed)}`
                    : t("wfOrganizeDone").replace("{n}", moved), failed > 0);
                dismiss();
                await refreshItems();
            } catch (e) {
                toast(t("wfOrganizeFail") + e.message, true);
                apply.disabled = false;
            }
        };

        document.body.appendChild(back);
        apply.focus();
    }

    // ---------------------------------------------- 왼쪽 폴더 트리

    function folderRow(label, value, depth, hasChildren = false) {
        const button = document.createElement("button");
        button.className = `fla-lp-folder${folder === value ? " on" : ""}`;
        const indent = document.createElement("span");
        indent.className = "fla-lp-indent";
        indent.style.width = `${depth * 15}px`;
        const fold = document.createElement("span");
        fold.className = "fla-lp-fold";
        fold.textContent = hasChildren ? (expanded.has(value) ? "⌄" : ">") : "";
        fold.onclick = (event) => {
            event.stopPropagation();
            expanded.has(value) ? expanded.delete(value) : expanded.add(value);
            allExpanded = false;
            saveSettings({ wfAllExpanded: allExpanded, wfExpanded: [...expanded] });
            renderSide();
        };
        const name = document.createElement("span");
        name.className = "fla-lp-folder-name";
        name.textContent = `${value ? "📁" : "⌂"}  ${label}`;
        button.append(indent, fold, name);
        button.onclick = () => { folder = value; saveSettings({ wfFolder: folder }); render(); };
        side.appendChild(button);
    }

    function renderSide() {
        side.replaceChildren();
        const tools = document.createElement("div");
        tools.className = "fla-lp-side-tools";
        const favButton = document.createElement("button");
        favButton.textContent = favoritesOnly ? "★" : "☆";
        favButton.title = t("loraFavorites");
        favButton.classList.toggle("star-on", favoritesOnly);
        favButton.onclick = () => { favoritesOnly = !favoritesOnly; saveSettings({ wfFavoritesOnly: favoritesOnly }); render(); };
        const descendants = document.createElement("button");
        descendants.textContent = "⑂";
        descendants.title = t("includeSubfolders");
        descendants.classList.toggle("on", includeChildren);
        descendants.onclick = () => { includeChildren = !includeChildren; saveSettings({ wfIncludeChildren: includeChildren }); render(); };
        const expand = document.createElement("button");
        expand.textContent = "↗↙";
        expand.title = t("expandFolders");
        expand.classList.toggle("on", allExpanded);
        expand.onclick = () => {
            allExpanded = !allExpanded;
            expanded.clear();
            if (allExpanded) for (const value of folders.filter(Boolean)) expanded.add(value);
            saveSettings({ wfAllExpanded: allExpanded, wfExpanded: [...expanded] });
            renderSide();
        };
        tools.append(favButton, descendants, expand);
        side.appendChild(tools);

        folderRow(t("wfRoot"), "", 0);
        for (const value of folders.filter(Boolean)) {
            const parts = value.split("/");
            const parent = parts.slice(0, -1).join("/");
            if (parts.length > 1 && !expanded.has(parent)) continue;
            const hasChildren = folders.some((candidate) => candidate.startsWith(value + "/") && candidate.split("/").length === parts.length + 1);
            folderRow(parts.at(-1), value, parts.length - 1, hasChildren);
        }
    }

    // ---------------------------------------------- 빵부스러기

    function crumbMenu(host, choices) {
        closeMenus();
        const menu = document.createElement("div");
        menu.className = "fla-lp-menu";
        for (const value of choices) {
            const button = document.createElement("button");
            button.textContent = value.split("/").pop() || t("wfRoot");
            button.onclick = () => choose(value);
            menu.appendChild(button);
        }
        host.appendChild(menu);
    }

    function renderPath(shown, total) {
        path.replaceChildren();
        const parts = folder.split("/").filter(Boolean);
        const crumbs = [[`⌂ ${t("wfRoot")}`, ""], ...parts.map((part, i) => [part, parts.slice(0, i + 1).join("/")])];
        crumbs.forEach(([label, value], index) => {
            if (index) path.append(document.createTextNode(" / "));
            const host = document.createElement("span");
            host.className = "fla-lp-crumb";
            const button = document.createElement("button");
            button.textContent = label;
            button.onclick = () => choose(value);
            const arrow = document.createElement("button");
            arrow.className = "arrow";
            arrow.textContent = "▾";
            arrow.onclick = (event) => {
                event.stopPropagation();
                const parent = index < 2 ? "" : parts.slice(0, index - 1).join("/");
                const depth = index || 1;
                const choices = folders.filter((f) => f !== value && f.split("/").filter(Boolean).length === depth && (!parent || f.startsWith(parent + "/")));
                crumbMenu(host, choices);
            };
            host.append(button, arrow);
            path.appendChild(host);
        });
        path.append(document.createTextNode(" / "));
        const next = document.createElement("span");
        next.className = "fla-lp-crumb";
        const nextButton = document.createElement("button");
        nextButton.textContent = "-- ▾";
        const nextDepth = parts.length + 1;
        const children = folders.filter((value) => value.split("/").filter(Boolean).length === nextDepth && (!folder || value.startsWith(folder + "/")));
        nextButton.onclick = (event) => { event.stopPropagation(); crumbMenu(next, children); };
        next.appendChild(nextButton);
        path.appendChild(next);
        const count = document.createElement("span");
        count.className = "fla-lp-count";
        count.textContent = `${shown} / ${total}`;
        path.appendChild(count);
    }

    // ---------------------------------------------- 카드

    function makeCard(item, query) {
        const card = document.createElement("div");
        card.className = "fla-lp-card fla-wf-card";
        card.tabIndex = 0;
        card.setAttribute("role", "button");
        card.title = item.name;

        // 그림 칸 — 서버가 노드 배치를 축소해 그려 준다(직접 올린 사진이 있으면 그것).
        const shot = document.createElement("div");
        shot.className = "fla-wf-shot";
        // 받은 워크플로우는 그림이 둘이다 — 노드 배치(자동)와 Civitai 대표 이미지.
        // 겹쳐 두고 천천히 번갈아 보여준다. 어느 워크플로우인지 알아보기 쉽다.
        const faces = [item.preview];
        if (item.cover) faces.push(item.cover);
        const layers = faces.map((src, i) => {
            const image = document.createElement("img");
            image.src = src;
            image.loading = "lazy";
            image.alt = "";
            if (i) image.classList.add("off");
            // 그림을 못 그리는 파일도 있다(깨진 것). 그때는 그 장만 뺀다.
            image.onerror = () => image.remove();
            shot.appendChild(image);
            return image;
        });
        if (layers.length > 1) {
            const dots = document.createElement("div");
            dots.className = "fla-wf-dots";
            const pips = layers.map((_l, i) => {
                const pip = document.createElement("span");
                if (!i) pip.className = "on";
                dots.appendChild(pip);
                return pip;
            });
            shot.appendChild(dots);
            let face = 0;
            // 카드가 화면에서 사라지면 타이머를 멈춘다(목록이 길어도 가볍게)
            const tick = setInterval(() => {
                if (!shot.isConnected) { clearInterval(tick); return; }
                face = (face + 1) % layers.length;
                layers.forEach((l, i) => l.classList.toggle("off", i !== face));
                pips.forEach((p, i) => p.classList.toggle("on", i === face));
            }, SHOT_SWAP);
            timers.push(tick);
        }
        shot.appendChild(Object.assign(document.createElement("div"), { className: "fla-wf-shade" }));
        const cap = document.createElement("div");
        cap.className = "fla-wf-cap";
        highlighted(cap, item.title, query);
        shot.appendChild(cap);
        if (item.custom_preview) {
            shot.appendChild(Object.assign(document.createElement("div"),
                { className: "fla-wf-mine", textContent: t("wfMyShot") }));
        }
        // 업데이트를 확인했고 새 버전이 있으면 카드에 표시한다
        if (newer.has(item.name)) {
            shot.appendChild(Object.assign(document.createElement("div"),
                { className: "fla-wf-new", textContent: t("wfHasNew") }));
        }

        const head = document.createElement("div");
        head.className = "fla-wf-head";
        head.style.display = "none";
        const name = document.createElement("div");
        name.className = "fla-wf-name";
        const star = document.createElement("button");
        star.className = `fla-wf-star${item.favorite ? " on" : ""}`;
        star.textContent = item.favorite ? "★" : "☆";
        star.title = t("loraFavorites");
        star.onclick = async (event) => {
            event.stopPropagation();
            star.disabled = true;
            try {
                const data = await post("/fla/workflow-favorite", { name: item.name, favorite: !item.favorite });
                item.favorite = data.favorite;
                render();
            } catch (e) {
                star.disabled = false;
                toast(e.message, true);
            }
        };
        head.append(name, star);
        // 별은 그림 위 오른쪽에 얹는다
        shot.appendChild(star);

        const stats = document.createElement("div");
        stats.className = "fla-wf-stats";
        if (item.broken) {
            stats.appendChild(Object.assign(document.createElement("span"), { className: "fla-wf-stat bad", textContent: t("wfBroken") }));
        } else {
            stats.appendChild(Object.assign(document.createElement("span"), { className: "fla-wf-stat", textContent: t("wfNodes").replace("{n}", item.nodes) }));
            if (item.missing_count) {
                const warn = document.createElement("span");
                warn.className = "fla-wf-stat warn";
                warn.textContent = t("wfMissing").replace("{n}", item.missing_count);
                warn.title = `${t("wfMissingTitle")}\n\n${item.missing.join("\n")}${item.missing_count > item.missing.length ? "\n…" : ""}`;
                stats.appendChild(warn);
            }
        }
        stats.appendChild(Object.assign(document.createElement("span"), { className: "fla-wf-stat", textContent: prettySize(item.size) }));

        const models = document.createElement("div");
        models.className = "fla-wf-models";
        const list = item.models ?? [];
        if (!list.length) {
            models.appendChild(Object.assign(document.createElement("span"), { className: "fla-wf-none", textContent: t("wfNoModels") }));
        } else {
            for (const value of list.slice(0, MAX_CHIPS)) {
                const chip = document.createElement("span");
                chip.className = "fla-wf-chip";
                chip.textContent = value.split("/").pop();
                chip.title = value;
                models.appendChild(chip);
            }
            const rest = (item.model_count ?? list.length) - Math.min(MAX_CHIPS, list.length);
            if (rest > 0) {
                const more = document.createElement("span");
                more.className = "fla-wf-chip dim";
                more.textContent = t("wfMore").replace("{n}", rest);
                more.title = list.join("\n");
                models.appendChild(more);
            }
        }

        const foot = document.createElement("div");
        foot.className = "fla-wf-foot";
        foot.appendChild(Object.assign(document.createElement("span"), { className: "fla-wf-when", textContent: prettyWhen(item.modified) }));
        if (item.folder) foot.appendChild(Object.assign(document.createElement("span"), { className: "fla-wf-where", textContent: item.folder }));

        card.append(shot, stats, models, foot);
        card.onclick = () => openWorkflow(item);
        card.oncontextmenu = (event) => { event.preventDefault(); event.stopPropagation(); openMenu(item, event); };
        card.onkeydown = (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openWorkflow(item); } };
        return card;
    }

    function render() {
        const query = input.value.trim().toLocaleLowerCase();
        const scoped = items.filter((item) => includeChildren ? contains(item, folder) : item.folder === folder);
        const shown = scoped.filter((item) => {
            const text = `${item.name} ${(item.models ?? []).join(" ")}`;
            return (!favoritesOnly || item.favorite)
                && (!query || text.toLocaleLowerCase().includes(query));
        });
        fav.classList.toggle("on", favoritesOnly);
        fav.textContent = `${favoritesOnly ? "★" : "☆"} ${t("loraFavorites")}`;
        renderSide();
        renderPath(shown.length, scoped.length);
        // 옛 카드의 그림 타이머는 여기서 끊는다
        for (const tick of timers) clearInterval(tick);
        timers.length = 0;
        grid.replaceChildren();
        if (!shown.length) {
            const empty = document.createElement("div");
            empty.className = "fla-lp-empty";
            empty.textContent = items.length ? t("wfNone") : t("wfNoneAtAll");
            grid.appendChild(empty);
            return;
        }
        for (const item of shown) grid.appendChild(makeCard(item, query));
    }

    input.addEventListener("input", searchLater);
    input.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        clearTimeout(searchTimer);
        render();
    });
    fav.onclick = () => { favoritesOnly = !favoritesOnly; saveSettings({ wfFavoritesOnly: favoritesOnly }); render(); };
    // Civitai 창의 워크플로우 칸으로 간다. 새 버전 확인과 합치기가 거기 있다.
    // 닫으면 목록과 딱지를 다시 읽는다(그 사이 받거나 합쳤을 수 있다).
    civitaiButton.onclick = () => openCivitaiPanel(async () => {
        await refreshItems();
        await loadNewer();
    }, "workflows");
    organizeButton.onclick = () => organize();
    revealButton.onclick = () => reveal();
    reload.onclick = async () => {
        reload.disabled = true;
        try {
            await refreshItems();
        } catch (e) {
            toast(e.message, true);
        } finally {
            reload.disabled = false;
        }
    };
    bg.querySelector(".close").onclick = close;
    bg.onclick = (event) => { if (event.target === bg) close(); };
    document.addEventListener("keydown", key, true);
    document.addEventListener("click", outside);
    render();
    input.focus();
    loadNewer();
}
