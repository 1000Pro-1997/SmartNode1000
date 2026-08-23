/** 워크플로우 새 버전 확인과 합쳐서 올리기.
 *
 *  Civitai 창의 "내 모델" 탭에 끼워 쓴다. 로라·체크포인트의 업데이트 칸
 *  (fla_civitai_updates.js)과 같은 모양으로 내놓는다 — 왼쪽에 붙일 조작판
 *  하나(controls)와 오른쪽에 펼 목록 하나(pane).
 *
 *  로라·체크포인트와 다른 점이 둘 있다.
 *
 *  하나. 워크플로우는 해시로 못 찾는다. zip 에서 풀려 나온 .json 이라
 *  원본 파일의 해시와 맞지 않는다. 그래서 받을 때 적어 둔 출처(어느 글의
 *  몇 번 버전인지)에만 기댄다. SM1000 으로 받지 않은 것은 확인할 수 없다.
 *
 *  둘. 새 버전을 그냥 덮어쓰지 않는다. 내가 고쳐 놓은 프롬프트·로라·수치가
 *  날아가기 때문이다. 받았을 때의 원본을 가운데 두고 세 갈래로 합친 뒤
 *  새 파일로 낸다(원본은 그대로 둔다).
 */

import { t } from "./fla_i18n.js";
import { el, json, post, toast } from "./fla_civitai_util.js";

/** 합친 결과 보고서를 사람이 읽을 수 있게 편다. */
function reportBox(report) {
    const box = el("div", "fla-wf-rep");
    const count = (key) => report[key + "_count"] ?? (report[key] ?? []).length;
    const line = (label, values, tone) => {
        if (!values.length) return;
        const row = el("div", "line");
        row.append(el("span", "tag " + (tone || ""), label), el("span", null, values.join(", ")));
        box.appendChild(row);
    };

    if (report.two_way) box.appendChild(el("div", "warn", t("wfMergeTwoWay")));
    line(t("wfMergeKept").replace("{n}", count("kept_values")), report.kept_values ?? [], "keep");
    line(t("wfMergeTook").replace("{n}", count("took_values")), report.took_values ?? [], "take");
    line(t("wfMergeAdded").replace("{n}", count("added_upstream")), report.added_upstream ?? [], "take");
    line(t("wfMergeCarried").replace("{n}", count("carried_mine")), report.carried_mine ?? [], "keep");
    line(t("wfMergeRemoved").replace("{n}", count("removed_upstream")), report.removed_upstream ?? [], "warn");
    line(t("wfMergeShape").replace("{n}", count("shape_changed")), report.shape_changed ?? [], "warn");
    line(t("wfMergeDropped").replace("{n}", count("dropped_links")), report.dropped_links ?? [], "bad");
    box.appendChild(el("div", null, t("wfMergeLook").replace("{n}", report.kept_look ?? 0)));
    return box;
}


/** 조작판 하나와 목록 하나를 만들어 준다.
 *  onChanged 는 워크플로우 파일이 늘거나 바뀌었을 때 부른다. */
export function buildWorkflowUpdatesView(onChanged = null) {
    // ---------------------------------------------- 왼쪽: 조작판
    const controls = el("div", "fla-cv-box");
    const head = el("div", "fla-cv-boxhead");
    head.appendChild(el("span", null, t("wfUpdates")));
    const body = el("div", "fla-cv-boxbody");
    controls.append(head, body);

    const count = el("div", "fla-cv-count");
    const check = el("button", "fla-cv-btn go", t("wfUpdatesCheck"));
    const when = el("div", "fla-cv-now");
    when.style.marginTop = "8px";
    const note = el("div", "fla-cv-tally");
    note.textContent = t("wfUpdatesHow");
    body.append(count, check, when, note);

    // ---------------------------------------------- 오른쪽: 목록
    const pane = el("div", "fla-cv-pane");
    const paneHead = el("div", "fla-cv-panehead");
    const title = el("h3", null, t("wfUpdates"));
    paneHead.appendChild(title);
    const list = el("div", "fla-cv-list");
    pane.append(paneHead, list);

    let items = [];
    let known = 0;
    let loaded = false;
    let busy = false;

    function paintCount() {
        count.replaceChildren(
            document.createTextNode(`${t("wfUpdatesKnown")}: `),
            el("b", null, String(known)));
        title.textContent = items.length
            ? `${t("wfUpdates")} (${items.length})`
            : t("wfUpdates");
    }

    /** 카드 하나. 왼쪽에 무엇이 어디로 가는지, 오른쪽에 단추 둘. */
    function row(item) {
        const box = el("div", "fla-wf-up-row");
        const main = el("div", "fla-wf-up-main");
        const name = el("div", "fla-wf-up-name", item.title);
        name.title = item.name;
        main.appendChild(name);
        main.appendChild(el("div", "fla-wf-up-sub",
            [item.model_name, item.creator && `@${item.creator}`].filter(Boolean).join("  ·  ")));

        const step = el("div", "fla-wf-up-step");
        step.append(el("span", "from", item.from_version || "?"),
                    document.createTextNode("→"),
                    el("span", "to", item.to_version || "?"));
        main.appendChild(step);
        if (!item.has_base) main.appendChild(el("div", "fla-wf-up-warn", t("wfMergeNoBase")));

        const acts = el("div", "fla-wf-up-acts");
        const look = el("button", "plain", t("wfMergePreview"));
        const go = el("button", null, t("wfMergeGo"));
        acts.append(look, go);

        let shown = null;
        look.onclick = async () => {
            if (shown) {
                shown.remove();
                shown = null;
                look.textContent = t("wfMergePreview");
                return;
            }
            look.disabled = true;
            look.textContent = t("loading");
            try {
                const { data } = await post("/fla/workflow-merge-preview",
                    { name: item.name, version_id: item.to_version_id });
                if (!data?.ok) throw new Error(data?.error ?? "");
                shown = reportBox(data.report);
                box.after(shown);
                look.textContent = t("wfMergeHide");
            } catch (e) {
                toast(t("wfMergeFail") + (e.message || ""), true);
                look.textContent = t("wfMergePreview");
            } finally {
                look.disabled = false;
            }
        };

        go.onclick = async () => {
            if (!confirm(t("wfMergeConfirm").replace("{name}", item.title))) return;
            go.disabled = true;
            look.disabled = true;
            try {
                const { data } = await post("/fla/workflow-merge", {
                    name: item.name,
                    version_id: item.to_version_id,
                    to_version: item.to_version,
                });
                if (!data?.ok) throw new Error(data?.error ?? "");
                toast(t("wfMergeDone").replace("{name}", data.name));
                if (shown) shown.remove();
                shown = reportBox(data.report);
                box.after(shown);
                go.textContent = t("wfMergeDoneShort");
                onChanged?.();
            } catch (e) {
                toast(t("wfMergeFail") + (e.message || ""), true);
                go.disabled = false;
                look.disabled = false;
            }
        };

        box.append(main, acts);
        return box;
    }

    function render() {
        paintCount();
        list.replaceChildren();
        if (!items.length) {
            list.appendChild(el("div", "fla-cv-empty", known
                ? t("wfUpdatesNone").replace("{n}", known)
                : t("wfUpdatesUnknown")));
            return;
        }
        for (const item of items) list.appendChild(row(item));
    }

    async function reload() {
        if (busy) return;
        busy = true;
        check.disabled = true;
        check.textContent = t("wfUpdatesChecking");
        try {
            const { data } = await json("/fla/workflow-updates");
            if (!data?.ok) throw new Error(data?.error ?? "");
            items = (data.items ?? []).filter((item) => item.name);
            known = data.known ?? 0;
            when.textContent = `${t("civitaiUpdateLast")}: ${new Date().toLocaleString()}`;
            render();
        } catch (e) {
            toast(t("wfUpdatesFail") + (e.message || ""), true);
        } finally {
            busy = false;
            check.disabled = false;
            check.textContent = t("wfUpdatesCheck");
        }
    }

    check.onclick = reload;
    render();

    return {
        controls,
        // 로라 쪽 업데이트 칸은 정리 상자를 하나 더 내놓는다. 워크플로우에는
        // 그런 것이 없으므로 빈 자리를 준다(부르는 쪽이 그대로 붙여도 되게).
        cleanup: el("div"),
        pane,
        /** 탭을 열 때. 처음 한 번만 물어본다(Civitai 를 여러 번 부르지 않게). */
        async activate() {
            if (loaded) return;
            loaded = true;
            await reload();
        },
        dispose() { /* 따로 멈출 것이 없다 */ },
    };
}
