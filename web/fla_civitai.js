/** Civitai 창 — 내 로라 정보 채우기, 업데이트 확인, 모델 찾기.
 *
 *  서버가 파일 해시로 모델을 찾아 <로라이름>.metadata.json 을 만든다.
 *  여기서는 부르고 진행률만 보여준다.
 *
 *  "내 로라" 탭은 좌우로 나뉜다. 왼쪽은 조작판(키·가져오기·업데이트 확인),
 *  오른쪽은 찾은 업데이트 목록이다. 목록 쪽은 fla_civitai_updates.js 가 만든다.
 *
 *  API 키가 없으면 발급 안내를 먼저 보여준다. 안내에 쓰는 그림은 Civitai 화면을
 *  다시 그린 것이다(실제 화면을 캡처해 두면 계정 이름·키가 같이 남는다).
 *
 *  로라 선택창(fla_lora_picker.js)이 이 파일을 부른다. 반대 방향으로는
 *  가져오지 않는다(서로 물고 도는 import 를 만들지 않으려고).
 */

import { t } from "./fla_i18n.js";
import { POLL, addCivitaiStyles, el, json, post, toast } from "./fla_civitai_util.js";
import { buildBrowseView } from "./fla_civitai_browse.js";
import { buildDownloadsView } from "./fla_civitai_downloads.js";
import { buildUpdatesView } from "./fla_civitai_updates.js";
import { buildWorkflowUpdatesView } from "./fla_workflow_updates.js";

// Civitai 계정 설정 페이지. 안내에서 바로 열어준다.
const ACCOUNT_URL = "https://civitai.com/user/account";

// "내 모델" 탭에서 오갈 수 있는 종류. 서버의 models.KINDS 와 짝이 맞는다.
const MY_KINDS = [
    ["loras", "civitaiMyLoras"],
    ["checkpoints", "civitaiMyCheckpoints"],
    ["workflows", "civitaiMyWorkflows"],
];

// 해시로 정보를 채울 수 있는 종류. 워크플로우는 zip 에서 풀려 나온 .json 이라
// 원본 해시와 맞지 않아 이 길을 못 탄다.
const HASHABLE = ["loras", "checkpoints"];

/** 키 유무와 남은 개수, 진행 중인 검사 상태를 한 번에 가져온다. */
export async function civitaiStatus(kind = "loras") {
    try {
        const { data } = await json(`/fla/civitai/status?kind=${encodeURIComponent(kind)}`);
        return data?.ok ? data : null;
    } catch (e) {
        return null;
    }
}

/** 로라 하나를 Civitai 에서 새로 받아온다. 상세 창 버튼이 쓴다.
 *  성공하면 서버가 준 결과를, 실패하면 null 을 준다(알림은 여기서 띄운다). */
export async function fetchLoraInfo(name, kind = "loras") {
    let result;
    try {
        result = await post("/fla/civitai/fetch", { name, kind });
    } catch (e) {
        toast(t("civitaiFetchFail") + String(e), true);
        return null;
    }
    if (result.data?.ok) {
        toast(t("civitaiFetchDone"));
        return result.data;
    }
    if (result.status === 404 && result.data?.missing) {
        toast(t("civitaiFetchMissing"), true);
        return null;
    }
    toast(t("civitaiFetchFail") + (result.data?.error ?? result.status), true);
    return null;
}


// -------------------------------------------------- 발급 안내 그림
//
// Civitai 화면을 흉내 낸 목업이다. 진짜 캡처를 넣으면 계정 이름과 키가
// 같이 남으므로 모양만 다시 그린다. 글자는 실제 화면과 같은 영어로 둔다.

/** 1단계 — 프로필 메뉴 맨 아래 톱니바퀴. */
function mockAccountMenu() {
    const box = el("div", "fla-cv-mock");
    const row = el("div", "fla-cv-mockrow");
    row.append(el("div", "fla-cv-mockavatar"), el("div", "fla-cv-mockname", t("civitaiMockAccount")), el("div", "fla-cv-mockchev", "›"));
    const bar = el("div", "fla-cv-mockbar");
    bar.append(el("div", "fla-cv-mockicon", "☀"), el("div", "fla-cv-mockicon on", "⚙"), el("div", "fla-cv-mockicon", "↦"));
    box.append(row, el("div", "fla-cv-mockrule"), bar, el("div", "fla-cv-mocktip", "↑ Account settings"));
    return box;
}

/** 2단계 — API Keys 칸의 파란 버튼. */
function mockApiKeys() {
    const box = el("div", "fla-cv-mock");
    const head = el("div", "fla-cv-mockhead");
    head.append(el("b", null, "API Keys"), el("div", "fla-cv-mockbtn on", "+ Add API key"));
    box.append(head, el("div", "fla-cv-mockdim", "You can use API keys to interact with the site through the API as your user."));
    return box;
}

/** 3단계 — 이름과 권한을 고르는 창. Read 만 켜면 된다. */
function mockCreateDialog() {
    const box = el("div", "fla-cv-mock");
    box.append(el("div", "fla-cv-mocktitle", "Create API Key"));

    const name = el("div", "fla-cv-mockfield");
    name.append(el("span", null, "Name"), el("div", "fla-cv-mockinput", "ComfyUI"));
    const preset = el("div", "fla-cv-mockfield");
    preset.append(el("span", null, "Permission preset"), el("div", "fla-cv-mockinput", "Read only   ▾"));
    box.append(name, preset);

    const table = el("div", "fla-cv-mocktable");
    const cells = [
        ["Resource", "h"], ["Read", "h"], ["Write", "h"],
        ["Models", ""], ["☑", "yes"], ["☐", ""],
        ["Media & Posts", ""], ["☑", "yes"], ["☐", ""],
    ];
    for (const [text, cls] of cells) table.appendChild(el("div", cls, text));
    box.appendChild(table);

    const right = el("div", "fla-cv-mockright");
    right.appendChild(el("div", "fla-cv-mockbtn on", "Save"));
    box.appendChild(right);
    return box;
}

/** 4단계 — 한 번만 보여주는 키. */
function mockKeyResult() {
    const box = el("div", "fla-cv-mock");
    box.append(el("div", "fla-cv-mocktitle", "Here is your API Key:"));
    const row = el("div", "fla-cv-mockkey");
    row.append(el("span", null, "•".repeat(32)), el("span", null, "⧉"));
    box.append(row, el("div", "fla-cv-mockdim", "Be sure to save this, you won't be able to see it again."));
    return box;
}

const STEPS = [
    ["civitaiStep1", mockAccountMenu],
    ["civitaiStep2", mockApiKeys],
    ["civitaiStep3", mockCreateDialog],
    ["civitaiStep4", mockKeyResult],
];


/** Civitai 창을 연다. onFinished 는 로라 목록이 바뀌었을 때 부른다
 *  (정보를 채웠거나 새 모델을 받았을 때). */
export function openCivitaiPanel(onFinished = null, startKind = "loras", browseType = null) {
    addCivitaiStyles();
    // 지금 보고 있는 내 모델 종류. 위쪽 단추로 바꾼다.
    let kind = MY_KINDS.some(([value]) => value === startKind) ? startKind : "loras";

    const bg = el("div", "fla-cv-bg");
    bg.innerHTML = `<div class="fla-cv" role="dialog" aria-modal="true"><div class="fla-cv-head"><div class="logo">C</div><h2></h2><div class="fla-cv-tabs"></div><div class="spacer"></div><button class="close" title="${t("cancel")}">×</button></div><div class="fla-cv-main"></div></div>`;
    document.body.appendChild(bg);
    // 무엇을 하는 창인지는 탭이 말해준다. 제목은 짧게 둔다.
    bg.querySelector("h2").textContent = "Civitai";
    const main = bg.querySelector(".fla-cv-main");
    const tabsHost = bg.querySelector(".fla-cv-tabs");

    let timer = null;
    let changed = false;
    // 키가 있어도 "키 변경" 을 누르면 안내 화면을 다시 보여준다
    let showGuide = false;
    // "키 없이 계속" 을 누르면 키가 없어도 조작판을 보여준다(공개 API 로도 대부분 된다)
    let skipped = false;
    // 업데이트 칸은 키가 있을 때 한 번만 깨운다
    let updatesAwake = false;

    const browse = buildBrowseView(() => { changed = true; });
    // 받기 관리 탭. 키가 없어 막히면 "내 모델" 탭의 키 등록으로 보낸다.
    const downloads = buildDownloadsView({
        onFinished: () => { changed = true; },
        onNeedKey: () => {
            showGuide = true;
            tabButtons[0].onclick();
            paintView(true);
            keyInput.focus();
        },
    });
    // 종류마다 업데이트 칸이 다르다. 둘 다 만들어 두고 갈아 끼운다.
    const modelUpdates = buildUpdatesView(() => { changed = true; }, kind === "workflows" ? "loras" : kind);
    const workflowUpdates = buildWorkflowUpdatesView(() => { changed = true; });
    let updates = kind === "workflows" ? workflowUpdates : modelUpdates;

    const close = () => {
        clearTimeout(timer);
        browse.dispose();
        downloads.dispose();
        modelUpdates.dispose();
        workflowUpdates.dispose();
        document.removeEventListener("keydown", key, true);
        bg.remove();
        // 받기가 백그라운드로 계속 돌 수 있으므로, 바뀐 게 있으면 목록을 새로 그린다
        if (changed) onFinished?.();
    };
    // 이 창이 열려 있는 동안에는 Esc 가 로라 선택창까지 닫지 않게 막는다
    const key = (event) => { if (event.key === "Escape") { event.stopPropagation(); close(); } };
    bg.querySelector(".close").onclick = close;
    bg.onclick = (event) => { if (event.target === bg) close(); };
    document.addEventListener("keydown", key, true);

    // ---------------------------------------------- 내 라이브러리 탭
    //
    // 키가 없을 때는 안내만 가운데에 넓게 보여주고, 키가 있으면 좌우로 쪼갠다.
    // 왼쪽은 조작판(키·가져오기·업데이트 확인), 오른쪽은 찾은 업데이트 목록.
    const libraryPage = el("div", "fla-cv-page");
    const libraryBody = el("div", "fla-cv-body");
    const narrow = el("div", "fla-cv-narrow");
    libraryBody.appendChild(narrow);
    const split = el("div", "fla-cv-split");
    const rail = el("div", "fla-cv-rail");
    split.append(rail, updates.pane);
    // 종류를 바꾸면 이 자리에 다른 칸을 끼운다
    const swapPane = (next) => split.replaceChild(next.pane, split.lastChild);
    libraryPage.append(libraryBody, split);

    /** 왼쪽 칸에 넣는 상자 하나. */
    function railBox(label) {
        const root = el("div", "fla-cv-box");
        const head = el("div", "fla-cv-boxhead");
        head.appendChild(el("span", null, label));
        const body = el("div", "fla-cv-boxbody");
        root.append(head, body);
        return { root, head, body };
    }

    // 종류 고르는 단추줄. 왼쪽 칸 맨 위에 둔다.
    const kindBar = el("div", "fla-cv-kinds");
    const kindButtons = MY_KINDS.map(([value, label]) => {
        const button = el("button", value === kind ? "on" : null);
        button.append(el("span", null, t(label)), el("b", null, ""));
        button.onclick = () => {
            if (kind === value) return;
            kind = value;
            kindButtons.forEach((b, i) => b.classList.toggle("on", MY_KINDS[i][0] === kind));
            applyKind();
            refresh();
        };
        kindBar.appendChild(button);
        return button;
    });

    // 안내(키 없을 때)
    const guide = el("div", "fla-cv-sec");
    const note = el("div", "fla-cv-note");
    note.append(el("b", null, t("civitaiNeedKey")), document.createTextNode(" " + t("civitaiNeedKeyDesc")));
    guide.appendChild(note);

    const open = el("button", "fla-cv-btn go", t("civitaiOpenAccount"));
    open.style.marginTop = "11px";
    open.onclick = () => window.open(ACCOUNT_URL, "_blank", "noopener");
    guide.appendChild(open);

    const steps = el("div", "fla-cv-steps");
    STEPS.forEach(([label, mock], index) => {
        const step = el("div", "fla-cv-step");
        step.appendChild(el("div", "fla-cv-num", String(index + 1)));
        const text = el("div", "fla-cv-steptext", t(label));
        text.appendChild(mock());
        step.appendChild(text);
        steps.appendChild(step);
    });
    guide.appendChild(steps);
    guide.appendChild(el("div", "fla-cv-warn", t("civitaiKeySecret")));

    const keyHead = el("h3", null, t("civitaiKey"));
    keyHead.style.marginTop = "16px";
    const keyRow = el("div", "fla-cv-key");
    const keyInput = el("input");
    keyInput.type = "password";
    keyInput.autocomplete = "off";
    keyInput.placeholder = t("civitaiPasteKey");
    const keySave = el("button", "fla-cv-btn go", t("save"));
    keyRow.append(keyInput, keySave);
    guide.append(keyHead, keyRow);

    const skipRow = el("div", "fla-cv-row");
    skipRow.style.marginTop = "10px";
    const skip = el("button", "fla-cv-link", t("civitaiSkip"));
    skipRow.appendChild(skip);
    guide.appendChild(skipRow);

    async function saveKey(value) {
        keySave.disabled = true;
        try {
            const { data } = await post("/fla/civitai/key", { key: value });
            if (!data?.ok) { toast(data?.error ?? t("civitaiFetchFail"), true); return false; }
            keyInput.value = "";
            toast(data.has_key ? t("civitaiKeySaved") : t("civitaiKeyCleared"));
            // 키를 지웠으면 안내를 다시 보여준다
            if (!data.has_key) skipped = false;
            // 키를 넣었으면 바로 가져오기 화면으로 넘어간다
            showGuide = false;
            await refresh();
            return true;
        } finally {
            keySave.disabled = false;
        }
    }

    keySave.onclick = () => {
        const value = keyInput.value.trim();
        if (!value) { toast(t("civitaiPasteKey"), true); return; }
        saveKey(value);
    };
    keyInput.addEventListener("keydown", (event) => { if (event.key === "Enter") keySave.onclick(); });
    skip.onclick = () => { showGuide = false; skipped = true; refresh(); };

    // 키 상자(키 있을 때)
    const keyBox = railBox(t("civitaiKey"));
    const keyState = el("div", "fla-cv-row");
    const keyStateText = el("div");
    keyStateText.style.cssText = "flex:1;min-width:0;color:#98a1ad;font-size:12px;align-self:center";
    const changeKey = el("button", "fla-cv-link", t("civitaiChangeKey"));
    const clearKey = el("button", "fla-cv-link", t("civitaiRemoveKey"));
    keyState.append(keyStateText, changeKey, clearKey);
    keyBox.body.appendChild(keyState);
    changeKey.onclick = () => { showGuide = true; paintView(true); };
    clearKey.onclick = () => saveKey("");

    // ---------------------------------------------- 브라우저 세션(선택)
    //
    // 글쓴이가 '로그인한 사람만 다운로드' 를 켜 둔 글은 API 키로 못 받는다.
    // 브라우저가 쓰는 세션 쿠키를 들고 가면 받아진다. 다만 이건 계정에
    // 로그인한 것과 같은 힘이라 기본은 접어 두고 경고를 함께 보여준다.
    const sessionBox = el("details", "fla-cv-session");
    const sessionHead = el("summary", null, t("sessionTitle"));
    const sessionState = el("span", "state", "");
    sessionHead.appendChild(sessionState);
    const sessionWhy = el("div", "why", t("sessionWhy"));
    const sessionWarn = el("div", "fla-cv-warn", t("sessionWarn"));
    const sessionRow = el("div", "fla-cv-key");
    const sessionInput = el("input");
    sessionInput.type = "password";
    sessionInput.autocomplete = "off";
    sessionInput.placeholder = t("sessionPaste");
    const sessionSave = el("button", "fla-cv-btn go", t("save"));
    sessionRow.append(sessionInput, sessionSave);
    const sessionClear = el("button", "fla-cv-link", t("sessionClear"));
    sessionClear.style.marginTop = "7px";
    const sessionHow = el("div", "fla-cv-tally", t("sessionHow"));
    sessionBox.append(sessionHead, sessionWhy, sessionWarn, sessionRow, sessionClear, sessionHow);
    // 다 만든 뒤에 붙인다(만들기 전에 붙이면 아직 없는 것을 만지게 된다)
    keyBox.body.appendChild(sessionBox);

    async function saveSession(value) {
        sessionSave.disabled = true;
        try {
            const { data } = await post("/fla/civitai/session", { session: value });
            if (!data?.ok) { toast(data?.error ?? t("civitaiFetchFail"), true); return; }
            sessionInput.value = "";
            toast(data.has_session ? t("sessionSaved") : t("sessionCleared"));
            refresh();
        } finally {
            sessionSave.disabled = false;
        }
    }
    sessionSave.onclick = () => {
        const value = sessionInput.value.trim();
        if (!value) { toast(t("sessionPaste"), true); return; }
        saveSession(value);
    };
    sessionInput.addEventListener("keydown", (event) => { if (event.key === "Enter") sessionSave.onclick(); });
    sessionClear.onclick = () => saveSession("");

    // 가져오기 상자
    const scanBox = railBox(t("civitaiScan"));
    const count = el("div", "fla-cv-count");
    const buttons = el("div", "fla-cv-row");
    const scanMissing = el("button", "fla-cv-btn go", t("civitaiScanMissing"));
    const scanAll = el("button", "fla-cv-btn", t("civitaiScanAll"));
    const stop = el("button", "fla-cv-btn stop", t("civitaiStop"));
    stop.style.display = "none";
    buttons.append(scanMissing, scanAll, stop);

    // 대표 이미지는 기본으로 건드리지 않는다. 직접 고른 그림을 말없이 바꾸면 곤란하다.
    const replaceRow = el("label", "fla-cv-check");
    const replace = el("input");
    replace.type = "checkbox";
    replaceRow.append(replace, el("span", null, t("civitaiReplacePreview")));

    const bar = el("div", "fla-cv-bar");
    const fill = el("div");
    bar.appendChild(fill);
    bar.style.display = "none";
    const now = el("div", "fla-cv-now");
    const tally = el("div", "fla-cv-tally");
    const errors = el("div", "fla-cv-errors");
    errors.style.display = "none";
    scanBox.body.append(count, buttons, replaceRow, bar, now, tally, errors);

    narrow.appendChild(guide);
    rail.append(kindBar, keyBox.root, scanBox.root, modelUpdates.controls, modelUpdates.cleanup,
                workflowUpdates.controls);

    /** 지금 고른 종류에 맞게 왼쪽 상자와 오른쪽 칸을 맞춘다. */
    function applyKind() {
        const hashable = HASHABLE.includes(kind);
        // 해시로 정보를 채울 수 없는 종류는 "한꺼번에 가져오기" 상자를 감춘다
        scanBox.root.style.display = hashable ? "" : "none";
        // 옛 버전 정리도 모델에만 뜻이 있다
        modelUpdates.controls.style.display = hashable ? "" : "none";
        modelUpdates.cleanup.style.display = hashable ? "" : "none";
        workflowUpdates.controls.style.display = hashable ? "none" : "";

        const next = hashable ? modelUpdates : workflowUpdates;
        if (next !== updates) {
            updates = next;
            swapPane(next);
        }
        if (hashable) modelUpdates.setKind(kind);
        if (updatesAwake) updates.activate();
    }

    applyKind();
    // 키가 있는지 알기 전까지는 둘 다 감춰 둔다(잘못된 화면이 잠깐 스치지 않게)
    guide.style.display = "none";
    split.style.display = "none";

    // ---------------------------------------------- 탭
    main.append(libraryPage, browse.root, downloads.root);

    const pages = [
        [t("civitaiTabMine"), libraryPage, () => { if (updatesAwake) updates.activate(); }],
        [t("civitaiTabBrowse"), browse.root, () => browse.activate()],
        [t("civitaiTabDownloads"), downloads.root, () => downloads.activate()],
    ];
    const tabButtons = pages.map(([label, page, onShow]) => {
        const button = el("button", null, label);
        button.onclick = () => {
            tabButtons.forEach((b) => b.classList.remove("on"));
            pages.forEach(([, p]) => p.classList.remove("on"));
            button.classList.add("on");
            page.classList.add("on");
            onShow?.();
        };
        tabsHost.appendChild(button);
        return button;
    });

    // ---------------------------------------------- 상태 그리기
    function paintView(hasKey) {
        const wantGuide = showGuide || (!hasKey && !skipped);
        guide.style.display = wantGuide ? "" : "none";
        libraryBody.style.display = wantGuide ? "" : "none";
        split.style.display = wantGuide ? "none" : "flex";
        if (wantGuide) libraryBody.scrollTop = 0;
        // 업데이트 확인은 키가 있어야 뜻이 있다(공개 API 로도 되지만 자주 막힌다)
        if (!wantGuide && !updatesAwake) {
            updatesAwake = true;
            updates.activate();
        }
    }

    function paint(status) {
        if (!status) return;
        paintView(status.has_key === true);
        downloads.setHasKey(status.has_key === true);
        keyStateText.textContent = status.has_key ? t("civitaiKeyOk") : t("civitaiKeyNone");
        clearKey.style.display = status.has_key ? "" : "none";
        sessionState.textContent = status.has_session ? t("sessionOn") : "";
        sessionState.classList.toggle("on", status.has_session === true);
        sessionClear.style.display = status.has_session ? "" : "none";

        // 종류 단추에 아직 정보 없는 개수를 찍는다
        const byKind = status.pending_by_kind ?? {};
        kindButtons.forEach((button, i) => {
            const count = byKind[MY_KINDS[i][0]] ?? 0;
            button.querySelector("b").textContent = count ? String(count) : "";
        });

        const p = status.progress ?? {};
        // 진행률은 지금 보고 있는 종류의 것일 때만 보여준다
        const running = p.running === true && (p.kind ?? "loras") === kind;
        count.replaceChildren(document.createTextNode(`${t("civitaiPending")}: `), el("b", null, String(status.pending ?? 0)));

        scanMissing.disabled = running || !(status.pending > 0);
        scanAll.disabled = running;
        replace.disabled = running;
        if (HASHABLE.includes(kind)) {
            scanBox.head.querySelector("span").textContent =
                `${t("civitaiScan")} — ${t(MY_KINDS.find(([v]) => v === kind)[1])}`;
        }
        stop.style.display = running ? "" : "none";
        stop.disabled = p.cancelled === true;

        const total = (p.kind ?? "loras") === kind ? (p.total ?? 0) : 0;
        if (total > 0) {
            bar.style.display = "";
            fill.style.width = `${Math.round(((p.done ?? 0) / total) * 100)}%`;
            now.textContent = running
                ? `${p.done ?? 0} / ${total}  ·  ${p.current || ""}`
                : `${p.done ?? 0} / ${total}  ·  ${p.cancelled ? t("civitaiStopped") : t("civitaiFinished")}`;
            tally.textContent = `${t("civitaiDone")} ${p.updated ?? 0}  ·  ${t("civitaiMissingCount")} ${p.missing ?? 0}  ·  ${t("civitaiFailed")} ${p.failed ?? 0}`;
        } else {
            bar.style.display = "none";
            now.textContent = "";
            tally.textContent = "";
        }

        if (p.errors?.length) {
            errors.style.display = "";
            errors.replaceChildren(...p.errors.map((item) => el("div", null, `${item.name} — ${item.error}`)));
        } else {
            errors.style.display = "none";
        }

        if ((p.updated ?? 0) > 0) changed = true;
    }

    async function refresh() {
        const status = await civitaiStatus(kind);
        paint(status);
        clearTimeout(timer);
        // 도는 동안에만 자주 물어본다. 끝나면 조용히 둔다.
        if (status?.progress?.running) timer = setTimeout(refresh, POLL);
        return status;
    }

    async function start(overwrite) {
        const result = await post("/fla/civitai/scan",
            { overwrite, replace_preview: replace.checked, kind });
        if (!result.data?.ok) {
            toast(result.data?.error ?? t("civitaiFetchFail"), true);
            return;
        }
        if ((result.data.progress?.total ?? 0) === 0) toast(t("civitaiNothing"));
        refresh();
    }

    scanMissing.onclick = () => start(false);
    scanAll.onclick = () => {
        if (!confirm(t("civitaiScanAllConfirm"))) return;
        start(true);
    };
    stop.onclick = async () => {
        stop.disabled = true;
        await post("/fla/civitai/cancel");
        refresh();
    };

    // 워크플로우 창에서 열면 바로 "모델 찾기" 로 가서 그 카테고리를 보여준다.
    // 워크플로우는 해시로 찾을 수 있는 것이 아니라 "내 모델" 탭에 들어가지 않는다.
    if (browseType !== null) {
        tabButtons[1].onclick();
        browse.setType(browseType);
    } else {
        tabButtons[0].onclick();
    }
    refresh();
}
