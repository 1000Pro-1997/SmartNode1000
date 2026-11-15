/** 받기 관리 탭.
 *
 *  받는 일은 서버가 한다(대기열도 서버에 있다). 그래서 창을 닫았다 열어도
 *  받던 것은 계속 받아진다. 여기서는 물어보고 그릴 뿐이다.
 *
 *  Civitai 와 허깅페이스가 같은 줄을 쓴다. 한 곳에서 다 보이게 하려고
 *  일부러 하나로 모았다.
 *
 *  API 키가 없으면 받다가 막히는 글이 있다(로그인해야 받을 수 있는 것들).
 *  그럴 때는 목록 대신 키 등록으로 보내는 안내를 먼저 보여준다 — 실패한
 *  줄만 아래에 남기고 이유를 모른 채 두지 않으려는 것이다.
 */

import { t } from "./fla_i18n.js";
import { POLL, addCivitaiStyles, el, json, post, prettySize, refreshNodeChoices }
    from "./fla_civitai_util.js";

/** 받기 관리 화면을 만든다.
 *
 *  onFinished  대기열이 다 비었고 하나라도 받아졌을 때
 *  onNeedKey   "API 키 등록하러 가기" 를 눌렀을 때(창이 탭을 옮겨 준다)
 */
export function buildDownloadsView({ onFinished = null, onNeedKey = null } = {}) {
    addCivitaiStyles();

    const root = el("div", "fla-cv-page");

    // ---------------------------------------------- 위쪽 안내 두 가지
    //
    // 하나는 키가 없을 때, 하나는 키가 있어도 못 받는 글일 때다. 둘을 섞으면
    // 안 된다 — 키를 등록해도 안 풀리는 것을 등록하라고 하면 헛수고를 시킨다.
    const keyNote = el("div", "fla-cv-dlnote");
    const noteText = el("div");
    noteText.append(el("b", null, t("dlNoKey")), document.createTextNode(" " + t("dlNoKeyWhy")));
    const goKey = el("button", "fla-cv-btn go", t("dlGoKey"));
    goKey.onclick = () => onNeedKey?.();
    keyNote.append(noteText, goKey);
    keyNote.style.display = "none";

    const loginNote = el("div", "fla-cv-dlnote");
    const loginText = el("div");
    loginText.append(el("b", null, t("dlLoginOnly")), document.createTextNode(" " + t("dlLoginOnlyWhy")));
    const openSite = el("a", "fla-cv-btn go");
    openSite.target = "_blank";
    openSite.rel = "noopener noreferrer";
    openSite.textContent = t("dlOpenSite");
    openSite.style.cssText = "display:inline-flex;align-items:center;text-decoration:none";
    loginNote.append(loginText, openSite);
    loginNote.style.display = "none";

    // ---------------------------------------------- 브라우저로 받은 것 가져오기
    //
    // 로그인해야 받는 글은 브라우저로 받으면 다운로드 폴더에 떨어진다.
    // 그 다음(옮기기·이름·정보 채우기)을 여기서 이어받는다.
    const importBox = el("div", "fla-cv-dlimport");
    const importHead = el("div", "fla-cv-dlhead");
    importHead.append(el("span", null, t("dlImport")));
    const importCount = el("b", null, "");
    const rescan = el("button", "fla-cv-link", t("dlImportRescan"));
    importHead.append(importCount, el("div", "grow"), rescan);
    const importWhere = el("div", "fla-cv-dlwhere");
    const importList = el("div");
    importBox.append(importHead, importWhere, importList);

    // 담을 수 있는 종류. 서버가 아는 것을 그대로 쓴다(여기서 두 벌 적지 않는다).
    let kinds = [];
    const kindLabel = (kind) => kinds.find((k) => k.kind === kind)?.label || kind;

    // ---------------------------------------------- 지금 받는 것
    const nowBox = el("div", "fla-cv-dlnow");
    const nowTitle = el("div", "title");
    const nowWhere = el("div", "where");
    const track = el("div", "fla-cv-bar");
    const fill = el("div");
    track.appendChild(fill);
    const pct = el("div", "pct");
    const stop = el("button", "fla-cv-btn stop", t("civitaiStop"));
    const bar = el("div", "row");
    bar.append(track, pct, stop);
    nowBox.append(nowTitle, nowWhere, bar);

    // ---------------------------------------------- 대기열과 받은 것
    const body = el("div", "fla-cv-dlbody");

    root.append(keyNote, loginNote, nowBox, body);

    let timer = null;
    let saw = false;
    let hasKey = true;

    /** 어디서 받는지 알려주는 작은 딱지. 다운로드 폴더에서 가져온 것은 따로 표시한다. */
    function source(where) {
        const [text, tone] = where === "huggingface" ? ["HF", "hf"]
            : where === "import" ? [t("dlSrcImport"), "pc"]
            : ["Civitai", "cv"];
        const chip = el("span", "fla-cv-dlsrc", text);
        chip.classList.add(tone);
        return chip;
    }

    /** 들어간 자리. "LoRA / Flux" 처럼 종류와 하위 폴더를 함께 적는다. */
    function landed(item) {
        const kind = item.kind ? kindLabel(item.kind) : "";
        const folder = item.folder && item.folder !== "/" ? item.folder : "";
        return [kind, folder].filter(Boolean).join(" / ") || "/";
    }

    function section(label, count) {
        const head = el("div", "fla-cv-dlhead");
        head.append(el("span", null, label));
        if (count) head.appendChild(el("b", null, String(count)));
        return head;
    }

    function paint(state) {
        // ---- 지금 받는 것
        const busy = state.running || state.queued > 0;
        nowBox.style.display = busy ? "" : "none";
        if (busy) {
            const current = state.current;
            nowTitle.textContent = current
                ? (current.title || current.file_name || t("civitaiPreparing"))
                : t("civitaiPreparing");
            nowWhere.replaceChildren();
            if (current) {
                nowWhere.appendChild(source(current.source));
                nowWhere.appendChild(document.createTextNode(
                    `${current.file_name || ""}  →  ${landed(current)}`));
            }
            if (state.total > 0) {
                const percent = Math.round((state.received / state.total) * 100);
                fill.style.width = `${percent}%`;
                pct.textContent = `${percent}%  ·  ${prettySize(state.received)} / ${prettySize(state.total)}`;
            } else {
                fill.style.width = "0%";
                pct.textContent = state.received ? prettySize(state.received) : "";
            }
            stop.disabled = state.cancelled === true;
        }

        // ---- 대기열과 받은 것
        body.replaceChildren();
        const queue = state.queue ?? [];
        if (queue.length) {
            body.appendChild(section(t("dlWaiting"), queue.length));
            for (const job of queue) {
                const line = el("div", "fla-cv-dlrow");
                line.appendChild(source(job.source));
                line.appendChild(el("span", "name", job.title || job.path || String(job.version_id ?? "")));
                line.appendChild(el("span", "to", landed(job)));
                body.appendChild(line);
            }
        }

        const recent = state.recent ?? [];
        if (recent.length) {
            body.appendChild(section(t("dlRecent"), 0));
            for (const item of recent) {
                const line = el("div", `fla-cv-dlrow${item.error ? " bad" : ""}`);
                line.appendChild(source(item.source));
                line.appendChild(el("span", "name", item.title || item.file_name || ""));
                line.appendChild(el("span", "to", item.error || landed(item)));
                // 누르면 옮겨 간 폴더가 탐색기로 열린다(파일이 골라진 채로)
                if (!item.error && item.path && item.id) {
                    line.classList.add("open");
                    line.title = `${t("dlReveal")}\n${item.path}`;
                    line.appendChild(el("i", "pi pi-folder-open"));
                    line.onclick = async () => {
                        try {
                            const { data } = await post("/fla/civitai/download-reveal", { id: item.id });
                            if (!data?.ok) throw new Error(data?.error ?? "");
                        } catch (e) {
                            line.title = t("dlRevealFail") + (e.message || "");
                        }
                    };
                }
                // 브라우저로 가야 하는 것은 갈 곳을 함께 준다
                if (item.login_needed && item.url) {
                    const link = el("a", "fla-cv-dlopen", t("dlOpenSite"));
                    link.href = item.url;
                    link.target = "_blank";
                    link.rel = "noopener noreferrer";
                    line.appendChild(link);
                }
                body.appendChild(line);
            }
        }

        if (!busy && !queue.length && !recent.length) {
            body.appendChild(el("div", "fla-cv-empty", t("dlNothing")));
        }

        // ---- 브라우저로 받아 둔 파일
        body.appendChild(importBox);

        // ---- 위쪽 안내
        // 서버가 '로그인해야 받는 글' 을 따로 표시해 준다. 그건 키와 상관없다.
        const walled = [...(state.errors ?? []), ...recent].find((e) => e.login_needed);
        loginNote.style.display = walled ? "" : "none";
        if (walled) openSite.href = walled.url || "https://civitai.com";
        // 키가 없어서 실패한 것만 키 등록으로 안내한다
        const keyless = !hasKey && recent.some((r) => r.error && !r.login_needed);
        keyNote.style.display = keyless ? "" : "none";
    }

    /** 종류 이름표. 받은 줄과 가져올 카드가 함께 쓴다. */
    async function loadKinds() {
        if (kinds.length) return;
        try {
            const res = await fetch("/fla/model-kinds");
            const got = await res.json();
            kinds = got.kinds ?? [];
        } catch (e) {
            kinds = [];
        }
    }

    /** 다운로드 폴더에서 가져올 만한 것을 찾아 그린다. */
    async function loadImports() {
        rescan.disabled = true;
        await loadKinds();
        let data;
        try {
            const res = await fetch("/fla/import/scan");
            data = await res.json();
            if (!res.ok || data.ok === false) throw new Error(data.error || res.statusText);
        } catch (e) {
            importList.replaceChildren(el("div", "fla-cv-dlrow bad", t("dlImportFail") + e.message));
            return;
        } finally {
            rescan.disabled = false;
        }

        importWhere.textContent = t("dlImportWhere").replace("{where}", (data.folders ?? []).join(", "));
        const items = data.items ?? [];
        importCount.textContent = items.length ? String(items.length) : "";
        importList.replaceChildren();
        if (!items.length) {
            importList.appendChild(el("div", "fla-cv-empty", t("dlImportNone")));
            return;
        }
        const grid = el("div", "fla-cv-impgrid");
        for (const item of items) grid.appendChild(importCard(item));
        importList.appendChild(grid);
    }

    /** 언제 받았는지. 며칠 지난 것은 날짜로 적는다. */
    function when(seconds) {
        if (!seconds) return "";
        const gap = Date.now() / 1000 - seconds;
        if (gap < 3600) return t("dlWhenMinutes").replace("{n}", Math.max(1, Math.round(gap / 60)));
        if (gap < 86400) return t("dlWhenHours").replace("{n}", Math.round(gap / 3600));
        if (gap < 86400 * 7) return t("dlWhenDays").replace("{n}", Math.round(gap / 86400));
        return new Date(seconds * 1000).toLocaleDateString();
    }

    /** 워크플로우 JSON 카드. 모델과 달리 종류 고르기가 없다 — 갈 곳이 하나다. */
    function workflowCard(item) {
        const card = el("div", "fla-cv-impcard");

        const top = el("div", "head");
        const name = el("div", "name", item.name);
        name.title = item.path;
        top.appendChild(name);
        card.appendChild(top);

        const marks = el("div", "marks");
        marks.appendChild(el("span", "kind wf", t("dlImportWorkflow")));
        if (item.already) marks.appendChild(el("span", "dup", t("dlImportDup")));
        card.appendChild(marks);

        const facts = el("div", "facts");
        facts.append(el("span", null, prettySize(item.size)),
                     el("span", null, when(item.modified)),
                     el("span", null, t("dlImportWfNodes").replace("{n}", item.nodes)));
        card.appendChild(facts);

        const going = el("div", "going", "→ " + t("dlImportWfGoing"));
        card.appendChild(going);

        const row = el("div", "acts");
        const take = el("button", "fla-cv-dltake", t("dlImportTake"));
        take.onclick = async () => {
            take.disabled = true;
            take.textContent = t("dlImportTaking");
            try {
                const { data } = await post("/fla/import/take", { path: item.path });
                if (!data?.ok) throw new Error(data?.error ?? "");
                card.classList.add("sent");
                take.textContent = t("dlImportWfDone");
                // 어느 이름으로 들어갔는지 보여준다(겹치면 번호가 붙는다)
                going.textContent = "→ " + (data.workflow?.name ?? t("dlImportWfGoing"));
            } catch (e) {
                take.disabled = false;
                take.textContent = t("dlImportTake");
                card.appendChild(el("div", "err", t("dlImportFail") + (e.message || "")));
            }
        };
        row.append(take);
        card.appendChild(row);
        return card;
    }

    function importCard(item) {
        if (item.workflow) return workflowCard(item);
        const card = el("div", "fla-cv-impcard");

        const top = el("div", "head");
        const name = el("div", "name", item.title || item.name);
        name.title = item.path;
        top.appendChild(name);
        card.appendChild(top);

        // 무엇인지 — 파일 안을 보고 알아낸 것. 모르면 딱지를 붙이지 않는다.
        const marks = el("div", "marks");
        if (item.guess) {
            marks.appendChild(el("span", "kind", kindLabel(item.guess)));
        } else {
            marks.appendChild(el("span", "kind dim", t("dlImportUnknown")));
        }
        if (item.base_model) marks.appendChild(el("span", "base", item.base_model));
        if (item.already) marks.appendChild(el("span", "dup", t("dlImportDup")));
        card.appendChild(marks);

        const facts = el("div", "facts");
        facts.append(el("span", null, prettySize(item.size)),
                     el("span", null, when(item.modified)));
        if (item.tensors) facts.appendChild(el("span", null, t("dlImportTensors").replace("{n}", item.tensors)));
        card.appendChild(facts);

        // 누르기 전에 어디로 가는지 보여준다. 가져올 때 Civitai 가 더 나은
        // 답을 주면 그쪽으로 가므로 "대개 여기" 라는 뜻이다.
        const going = el("div", "going");
        const paintGoing = () => {
            const kind = where.value || item.guess;
            if (!kind) { going.textContent = t("dlImportAskFirst"); return; }
            // 손으로 종류를 바꾸면 폴더는 서버가 다시 정한다
            const folder = where.value && where.value !== item.guess ? "" : (item.folder || "");
            going.textContent = "→ " + kindLabel(kind) + (folder ? " / " + folder : "");
        };
        card.appendChild(going);

        // 종류는 자동이 기본. 자동이 틀렸을 때만 손으로 바꾼다.
        const row = el("div", "acts");
        const where = el("select", "fla-cv-dlpick");
        where.onchange = () => paintGoing();
        const auto = new Option(item.guess
            ? t("dlImportAutoAs").replace("{what}", kindLabel(item.guess))
            : t("dlImportAuto"), "");
        where.appendChild(auto);
        for (const entry of kinds) where.appendChild(new Option(entry.label, entry.kind));
        const take = el("button", "fla-cv-dltake", t("dlImportTake"));
        take.onclick = async () => {
            take.disabled = true;
            where.disabled = true;
            take.textContent = t("dlImportTaking");
            try {
                const { data } = await post("/fla/import/take",
                    { path: item.path, kind: where.value });
                if (!data?.ok) throw new Error(data?.error ?? "");
                card.classList.add("sent");
                saw = true;
                watch();
            } catch (e) {
                take.disabled = false;
                where.disabled = false;
                take.textContent = t("dlImportTake");
                card.appendChild(el("div", "err", t("dlImportFail") + (e.message || "")));
            }
        };
        row.append(where, take);
        card.appendChild(row);
        // where 를 다 만든 뒤에 그린다(만들기 전에 만지면 아직 없는 것을 만진다)
        paintGoing();
        return card;
    }

    async function watch() {
        clearTimeout(timer);
        let state;
        try {
            const { data } = await json("/fla/civitai/download-status");
            state = data?.download;
        } catch (e) {
            return;
        }
        if (!state) return;
        paint(state);
        if (state.running || state.queued > 0) {
            saw = true;
            timer = setTimeout(watch, POLL);
        } else if (saw) {
            saw = false;
            onFinished?.();
            loadImports();
            // 캔버스 노드의 고르는 칸에도 새 파일이 뜨게 한다
            refreshNodeChoices();
        }
    }

    rescan.onclick = () => loadImports();

    stop.onclick = async () => {
        stop.disabled = true;
        await post("/fla/civitai/download-cancel");
        watch();
    };

    return {
        root,
        /** 창이 키가 있는지 알려주면 안내를 켜고 끈다. */
        setHasKey(value) {
            hasKey = value !== false;
            if (hasKey) keyNote.style.display = "none";
        },
        /** 탭을 열 때. 도는 중이면 따라붙고, 가져올 것도 찾아본다. */
        async activate() {
            // 받은 줄에 종류 이름을 붙이려면 이름표가 먼저 있어야 한다
            await loadKinds();
            await watch();
            await loadImports();
        },
        /** 다른 화면에서 받기를 걸었을 때 깨운다. */
        watch,
        dispose() { clearTimeout(timer); },
    };
}
