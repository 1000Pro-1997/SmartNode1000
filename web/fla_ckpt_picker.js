/** 모델(체크포인트) 관리창.
 *
 *  로라 선택창과 같은 모양·같은 조작이다(폴더 트리, 즐겨찾기, 검색, 빵부스러기).
 *  스타일도 로라 창의 .fla-lp-* 를 그대로 쓴다. 두 창이 따로 놀면 같은 버튼이
 *  다르게 보여서 헷갈리기 때문이다.
 *
 *  로라 창과 다른 점은 "고르는" 창이 아니라는 것이다. 여기서 고른 모델을
 *  넣을 노드가 없으므로 좌클릭은 이름 복사, 오른쪽 클릭은 관리 메뉴다.
 *
 *  서버가 읽는 곁다리 파일(<이름>.metadata.json)은 로라 창이 쓰는 것과 같다.
 *  LoRA Manager 가 만들어 둔 파일도 그대로 읽힌다. 즐겨찾기도 같은 칸을
 *  쓰므로 어느 쪽에서 켜도 양쪽에 보인다.
 */

import { t } from "./fla_i18n.js";
import { releaseWidgetCaptureSoon } from "./fla_widget_mouse.js";
import { addStyles as addPickerStyles, showModelDetail } from "./fla_lora_picker.js";
import { civitaiStatus, fetchLoraInfo, openCivitaiPanel } from "./fla_civitai.js";
import { addMenuStyles, closeMenus, openContextMenu, toast } from "./fla_manage_menu.js";

const SEARCH_DELAY = 300;
// Civitai nsfwLevel 비트마스크에서 R 등급 이상만 성인 이미지로 가린다.
const KIND = "checkpoints";

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
    libraryPromise ??= fetch(`/fla/model-library?kind=${KIND}${refresh ? "&refresh=1" : ""}`)
        .then((res) => {
            if (!res.ok) throw new Error(res.statusText);
            return res.json();
        })
        .then((data) => data.items ?? []);
    return libraryPromise;
}

/** 폴더에 파일을 넣거나 뺐을 때 다시 읽게 한다. */
export function forgetModelLibrary() {
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
    // 아직 문서에 없으므로 여기서 먼저 넣는다. 안 그러면 레이아웃이 무너진다.
    addPickerStyles();
    addMenuStyles();
    if (document.getElementById("fla-mm-picker-style")) return;
    const style = document.createElement("style");
    style.id = "fla-mm-picker-style";
    style.textContent = `
      .fla-mm-more{position:absolute;z-index:2;right:7px;top:40px;display:grid;width:30px;height:30px;padding:0;place-items:center;color:#fff;background:#111a;border:0;border-radius:50%;font-size:17px;line-height:1;cursor:pointer}
      .fla-mm-more:hover{background:#2f6fd0}
      .fla-mm-size{max-width:100%;padding:3px 6px;color:#c8cdd5;background:#111d;border-radius:4px;font-size:11px;white-space:nowrap}
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

/** 카드 배지에 쓸 짧은 이름. 곁다리 파일이 "Unknown" 을 적어둔 것도 흔하다. */
function modelBadge(base) {
    if (!base || /^unknown$/i.test(base)) return "Checkpoint";
    const match = String(base).match(/SDXL|SD\s*1(?:\.\d)?|SD\s*2(?:\.\d)?|SD\s*3(?:\.\d)?|Pony|Flux|Illustrious|LTXV?|Wan\s*\d(?:\.\d)?|Qwen|Hunyuan/i);
    return `Checkpoint | ${match ? match[0].replace(/\s/g, "") : base}`;
}

function prettySize(bytes) {
    const value = Number(bytes) || 0;
    if (value >= 1e9) return `${(value / 1e9).toFixed(1)} GB`;
    if (value >= 1e6) return `${Math.round(value / 1e6)} MB`;
    return `${Math.round(value / 1e3)} KB`;
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


/** 모델 관리창을 연다. 닫히면 끝난다(고른 값을 돌려주지 않는다). */
export async function openModelManager() {
    // 전체 화면 모달이 커서를 덮어 캔버스가 pointerup 을 못 받는다.
    releaseWidgetCaptureSoon();
    const [items, saved] = await Promise.all([library(), loadSettings()]);
    addStyles();

    // 로라 창과 설정을 나눠 쓰면 서로 폴더가 튀므로 mm 접두사로 따로 저장한다.
    let folder = typeof saved.mmFolder === "string" ? saved.mmFolder : "";
    let favoritesOnly = saved.mmFavoritesOnly === true;
    let includeChildren = saved.mmIncludeChildren !== false;
    let allExpanded = saved.mmAllExpanded === true;
    // 성인물 가리기. 기본은 켜둔다(실수로 노출되지 않게).
    let blurAdult = saved.mmBlurAdult !== false;
    // "보기" 로 개별 확인한 것들. 토글을 다시 켜면 비워서 전부 도로 가린다.
    const revealed = new Set();
    const folders = allFolders(items);
    const expanded = new Set(Array.isArray(saved.mmExpanded) ? saved.mmExpanded : []);
    if (folder && !folders.includes(folder)) folder = "";

    const bg = document.createElement("div");
    bg.className = "fla-lp-bg";
    bg.innerHTML = `<div class="fla-lp" role="dialog" aria-modal="true"><div class="fla-lp-head"><input type="search" placeholder="${t("mmSearch")}"><div class="fla-lp-hint">${t("mmHint")}</div><button class="fav">☆ ${t("loraFavorites")}</button><button class="civitai" title="${t("civitaiTitle")}">Civitai<span class="dot"></span></button><button class="adult" title="${t("adultBlur")}">19</button><button class="reload" title="${t("mmRefresh")}">⟳</button><button class="close" title="${t("cancel")}">×</button></div><div class="fla-lp-main"><aside class="fla-lp-side"></aside><section class="fla-lp-content"><div class="fla-lp-path"></div><div class="fla-lp-grid"></div></section></div></div>`;
    document.body.appendChild(bg);
    const input = bg.querySelector("input");
    const fav = bg.querySelector(".fav");
    const civitai = bg.querySelector(".civitai");
    const adult = bg.querySelector(".adult");
    const reload = bg.querySelector(".reload");
    const side = bg.querySelector(".fla-lp-side");
    const path = bg.querySelector(".fla-lp-path");
    const grid = bg.querySelector(".fla-lp-grid");

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
        saveSettings({ mmFolder: folder });
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
        paintCivitaiDot();
    }

    // ---------------------------------------------- 관리 메뉴

    /** 카드 하나에 딸린 메뉴. 커서 자리에서 연다. */
    function openMenu(item, event) {
        openContextMenu([
            [t("detailMore"), () => showDetail(item)],
            [item.has_info ? t("mmRefetch") : t("mmFetch"), () => fetchInfo(item)],
            [null],
            [t("mmCopyName"), () => copyName(item)],
            [t("mmSetPreview"), () => uploadPreview(item)],
            [t("mmReveal"), () => reveal(item)],
            [null],
            [t("delete"), () => removeModel(item), true],
        ], event);
    }

    /** 상세 창. 로라 창이 쓰는 것과 같은 창이다(종류만 다르게 넘긴다). */
    async function showDetail(item) {
        await showModelDetail("checkpoints", item.name, blurAdult,
                              () => refreshItems(), () => refreshItems());
    }

    /** 이 파일 하나만 Civitai 에서 정보와 대표 이미지를 받아온다. */
    async function fetchInfo(item) {
        toast(t("mmFetching"));
        const result = await fetchLoraInfo(item.name, "checkpoints");
        if (result) await refreshItems();
    }

    async function copyName(item) {
        try {
            await navigator.clipboard.writeText(item.name);
            toast(t("mmCopied"));
        } catch (e) {
            // 보안 문맥이 아니면 클립보드를 못 쓴다. 옛 방식으로 한 번 더 해본다.
            const helper = document.createElement("textarea");
            helper.value = item.name;
            helper.style.cssText = "position:fixed;top:-1000px";
            document.body.appendChild(helper);
            helper.select();
            const done = document.execCommand?.("copy");
            helper.remove();
            toast(done ? t("mmCopied") : item.name, !done);
        }
    }

    function uploadPreview(item) {
        const picker = document.createElement("input");
        picker.type = "file";
        picker.accept = "image/*,video/mp4,video/webm";
        picker.onchange = async () => {
            const file = picker.files?.[0];
            if (!file) return;
            const form = new FormData();
            form.append("kind", KIND);
            form.append("name", item.name);
            form.append("file", file);
            try {
                const res = await fetch("/fla/model-preview-upload", { method: "POST", body: form });
                const data = await res.json();
                if (!res.ok || data.ok === false) throw new Error(data.error || res.statusText);
                toast(t("mmPreviewDone"));
                await refreshItems();
            } catch (e) {
                toast(t("mmPreviewFail") + e.message, true);
            }
        };
        picker.click();
    }

    async function reveal(item) {
        try {
            await post("/fla/model-reveal", { kind: KIND, name: item.name });
        } catch (e) {
            toast(t("mmRevealFail") + e.message, true);
        }
    }

    async function removeModel(item) {
        if (!confirm(t("mmDeleteConfirm").replace("{name}", item.name))) return;
        try {
            await post("/fla/model-delete", { kind: KIND, name: item.name });
            toast(t("mmDeleted"));
            await refreshItems();
        } catch (e) {
            toast(t("mmDeleteFail") + e.message, true);
        }
    }

    // ---------------------------------------------- 왼쪽 폴더 트리

    function folderButton(label, value, depth, hasChildren = false) {
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
            saveSettings({ mmAllExpanded: allExpanded, mmExpanded: [...expanded] });
            renderSide();
        };
        const name = document.createElement("span");
        name.className = "fla-lp-folder-name";
        name.textContent = `${value ? "📁" : "⌂"}  ${label}`;
        button.append(indent, fold, name);
        button.onclick = () => { folder = value; saveSettings({ mmFolder: folder }); render(); };
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
        favButton.onclick = () => { favoritesOnly = !favoritesOnly; saveSettings({ mmFavoritesOnly: favoritesOnly }); render(); };
        const descendants = document.createElement("button");
        descendants.textContent = "⑂";
        descendants.title = t("includeSubfolders");
        descendants.classList.toggle("on", includeChildren);
        descendants.onclick = () => { includeChildren = !includeChildren; saveSettings({ mmIncludeChildren: includeChildren }); render(); };
        const expand = document.createElement("button");
        expand.textContent = "↗↙";
        expand.title = t("expandFolders");
        expand.classList.toggle("on", allExpanded);
        expand.onclick = () => {
            allExpanded = !allExpanded;
            expanded.clear();
            if (allExpanded) for (const value of folders.filter(Boolean)) expanded.add(value);
            saveSettings({ mmAllExpanded: allExpanded, mmExpanded: [...expanded] });
            renderSide();
        };
        tools.append(favButton, descendants, expand);
        side.appendChild(tools);

        folderButton(t("mmRoot"), "", 0);
        for (const value of folders.filter(Boolean)) {
            const parts = value.split("/");
            const parent = parts.slice(0, -1).join("/");
            if (parts.length > 1 && !expanded.has(parent)) continue;
            const hasChildren = folders.some((candidate) => candidate.startsWith(value + "/") && candidate.split("/").length === parts.length + 1);
            folderButton(parts.at(-1), value, parts.length - 1, hasChildren);
        }
    }

    // ---------------------------------------------- 빵부스러기

    function crumbMenu(host, choices) {
        closeMenus();
        const menu = document.createElement("div");
        menu.className = "fla-lp-menu";
        for (const value of choices) {
            const button = document.createElement("button");
            button.textContent = value.split("/").pop() || t("mmRoot");
            button.onclick = () => choose(value);
            menu.appendChild(button);
        }
        host.appendChild(menu);
    }

    function renderPath(shown, total) {
        path.replaceChildren();
        const parts = folder.split("/").filter(Boolean);
        const crumbs = [[`⌂ ${t("mmRoot")}`, ""], ...parts.map((part, i) => [part, parts.slice(0, i + 1).join("/")])];
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
        card.className = "fla-lp-card";
        card.tabIndex = 0;
        card.setAttribute("role", "button");
        card.title = `${item.name}\n${prettySize(item.size)}`;

        const preview = document.createElement("div");
        preview.className = "fla-lp-preview";
        const hidden = blurAdult && item.adult && !revealed.has(item.name);
        if (item.preview) {
            const media = document.createElement(item.preview_type === "video" ? "video" : "img");
            media.src = item.preview;
            if (item.preview_type === "video") {
                media.muted = true;
                media.loop = true;
                media.autoplay = true;
                media.playsInline = true;
            } else {
                media.loading = "lazy";
                media.alt = "";
            }
            if (hidden) media.classList.add("fla-lp-blur");
            preview.appendChild(media);
        } else {
            preview.appendChild(Object.assign(document.createElement("span"), { textContent: t("mmNoPreview") }));
        }
        preview.appendChild(Object.assign(document.createElement("div"), { className: "fla-lp-shade" }));

        const title = document.createElement("div");
        title.className = "fla-lp-title";
        highlighted(title, item.title, query);
        preview.appendChild(title);

        const star = document.createElement("button");
        star.className = `fla-lp-star${item.favorite ? " on" : ""}`;
        star.textContent = item.favorite ? "★" : "☆";
        star.title = t("loraFavorites");
        star.onclick = async (event) => {
            event.stopPropagation();
            star.disabled = true;
            try {
                const data = await post("/fla/model-favorite", { kind: KIND, name: item.name, favorite: !item.favorite });
                item.favorite = data.favorite;
                render();
            } catch (e) {
                star.disabled = false;
                toast(e.message, true);
            }
        };
        preview.appendChild(star);

        const more = document.createElement("button");
        more.className = "fla-mm-more";
        more.textContent = "⋯";
        more.title = t("mmMenu");
        more.onclick = (event) => { event.stopPropagation(); openMenu(item, event); };
        preview.appendChild(more);

        const tags = document.createElement("div");
        tags.className = "fla-lp-tags";
        tags.appendChild(Object.assign(document.createElement("span"), { className: "fla-lp-badge", textContent: modelBadge(item.base_model) }));
        if (item.version) tags.appendChild(Object.assign(document.createElement("span"), { className: "fla-lp-version", textContent: item.version }));
        if (!item.has_info) tags.appendChild(Object.assign(document.createElement("span"), { className: "fla-lp-version fla-lp-noinfo", textContent: t("mmNoInfo") }));
        tags.appendChild(Object.assign(document.createElement("span"), { className: "fla-mm-size", textContent: prettySize(item.size) }));
        preview.appendChild(tags);

        if (hidden) {
            const veil = document.createElement("div");
            veil.className = "fla-lp-veil";
            veil.appendChild(Object.assign(document.createElement("span"), { textContent: t("adultLabel") }));
            const show = document.createElement("button");
            show.textContent = t("adultShow");
            show.onclick = (event) => { event.stopPropagation(); revealed.add(item.name); render(); };
            veil.appendChild(show);
            preview.appendChild(veil);
        }

        card.appendChild(preview);
        card.onclick = () => showDetail(item);
        card.oncontextmenu = (event) => { event.preventDefault(); event.stopPropagation(); openMenu(item, event); };
        card.onkeydown = (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); showDetail(item); } };
        return card;
    }

    function render() {
        const query = input.value.trim().toLocaleLowerCase();
        const scoped = items.filter((item) => includeChildren ? contains(item, folder) : item.folder === folder);
        const shown = scoped.filter((item) => {
            const text = `${item.name} ${item.title} ${item.base_model} ${item.version}`;
            return (!favoritesOnly || item.favorite)
                && (!query || text.toLocaleLowerCase().includes(query));
        });
        fav.classList.toggle("on", favoritesOnly);
        fav.textContent = `${favoritesOnly ? "★" : "☆"} ${t("loraFavorites")}`;
        // 로라 창과 같은 뜻으로 둔다 — 빨간 활성 상태는 지금 성인물이
        // 보이고 있다는 경고다. 가리는 중일 때가 아니라.
        adult.classList.toggle("on", !blurAdult);
        adult.title = blurAdult ? t("adultBlurOn") : t("adultBlurOff");
        renderSide();
        renderPath(shown.length, scoped.length);
        grid.replaceChildren();
        if (!shown.length) {
            const empty = document.createElement("div");
            empty.className = "fla-lp-empty";
            empty.textContent = items.length ? t("mmNoModels") : t("mmNoneAtAll");
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
    fav.onclick = () => { favoritesOnly = !favoritesOnly; saveSettings({ mmFavoritesOnly: favoritesOnly }); render(); };
    /** Civitai 창을 체크포인트 쪽으로 열어준다. 닫히면 목록을 다시 읽는다. */
    civitai.onclick = () => openCivitaiPanel(() => refreshItems(), "checkpoints");

    /** 아직 정보가 없는 체크포인트가 있으면 Civitai 단추에 점을 찍는다. */
    async function paintCivitaiDot() {
        const dot = civitai.querySelector(".dot");
        const status = await civitaiStatus("checkpoints");
        dot.style.display = (status?.pending ?? 0) > 0 ? "" : "none";
        if (status?.pending) civitai.title = `${t("civitaiTitle")} — ${t("civitaiPending")}: ${status.pending}`;
    }

    adult.onclick = () => {
        blurAdult = !blurAdult;
        // 다시 가릴 때는 개별로 열어둔 것도 같이 덮는다
        if (blurAdult) revealed.clear();
        saveSettings({ mmBlurAdult: blurAdult });
        render();
    };
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
    paintCivitaiDot();
}
