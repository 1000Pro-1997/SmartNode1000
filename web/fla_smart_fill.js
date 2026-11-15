/** 스마트 모델 넣기 — 지금 띄운 워크플로우가 찾는 모델을 자동으로 채운다.
 *
 *  남에게 받은 워크플로우는 모델 이름에 그 사람의 폴더 구조가 박혀 있다.
 *  같은 파일을 갖고 있어도 하위 폴더가 다르면 노드는 빨갛게 뜬다. 세 단계로
 *  푼다.
 *
 *    1) 노드의 고르는 칸 목록에서 같은 파일 이름을 찾아 경로만 바꿔 넣는다.
 *       (하위 폴더가 다른 경우. 가장 흔하고 서버도 필요 없다.)
 *    2) 그래도 없으면 서버에게 모든 모델 종류를 뒤져 달라고 한다. 엉뚱한
 *       종류 폴더(체크포인트 자리의 VAE 같은 것)에서 나오면 제자리로
 *       옮기고 다시 넣는다.
 *    3) 어디에도 없는 것은 없다고 그대로 보여준다. 조용히 넘어가면
 *       실행하다가 만나게 되어 더 나쁘다.
 */

import { app } from "../../scripts/app.js";
import { t } from "./fla_i18n.js";
import { el, post, refreshNodeChoices } from "./fla_civitai_util.js";

// 모델 파일로 볼 확장자. 서버 imports.MODEL_EXTS 와 같다.
const MODEL_EXTS = [".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".gguf", ".sft", ".onnx"];

const isModelName = (value) => typeof value === "string"
    && MODEL_EXTS.some((ext) => value.toLowerCase().endsWith(ext));
/** 경로 구분자와 대소문자를 눌러 비교용으로 만든다(윈도우는 둘 다 섞인다). */
const norm = (value) => String(value).replaceAll("\\", "/").toLowerCase();
const baseOf = (value) => norm(value).split("/").pop();
const titleOf = (node) => node.title || node.type || "?";


// -------------------------------------------------- 워크플로우 훑기

/** 고르는 칸의 선택지 목록. 함수로 들어 있는 노드도 있다. */
function comboValues(node, widget) {
    let values = widget.options?.values;
    if (typeof values === "function") {
        try { values = values(widget, node); } catch (e) { values = null; }
    }
    return Array.isArray(values) ? values : null;
}

/** 모델 파일을 고르는 위젯을 전부 모은다. 서브그래프 안까지 본다. */
function collect() {
    const jobs = [];
    const seen = new Set();
    const walk = (graph) => {
        if (!graph || seen.has(graph)) return;
        seen.add(graph);
        for (const node of graph._nodes ?? graph.nodes ?? []) {
            for (const widget of node.widgets ?? []) {
                if (!isModelName(widget.value)) continue;
                const values = comboValues(node, widget);
                // 목록이 없는 것은 글자 칸이다. 값을 바꾸면 딴 뜻이 될 수 있다.
                if (!values) continue;
                jobs.push({ node, widget, values });
            }
            if (node.subgraph) walk(node.subgraph);
        }
    };
    walk(app.graph);
    return jobs;
}

/** 목록에서 같은 파일을 찾는다. 하위 폴더는 달라도 된다. */
function findMatch(value, values) {
    const exact = values.find((v) => norm(v) === norm(value));
    if (exact !== undefined) return { pick: exact, count: 1 };
    const candidates = values.filter((v) => baseOf(v) === baseOf(value));
    if (!candidates.length) return null;
    // 여럿이면 덜 깊은 폴더의 것을 고른다. 대개 그쪽이 본 파일이다.
    candidates.sort((a, b) => a.length - b.length);
    return { pick: candidates[0], count: candidates.length };
}

/** 이 칸이 어느 모델 폴더를 원하는지. 못 알아보면 빈 문자열.
 *
 *  파일을 옮길 때만 쓴다. 노드 종류를 먼저 보고(위젯 이름은 겹치는 것이
 *  있다 — CLIPLoader 와 CLIPVisionLoader 둘 다 clip_name 을 쓴다) 그
 *  다음 위젯 이름으로 짐작한다.
 */
function inferKind(node, widget) {
    const type = String(node.type || "");
    const name = String(widget.name || "");
    if (/clipvision/i.test(type)) return "clip_vision";
    if (/checkpointloader/i.test(type) || /^ckpt_name/.test(name)) return "checkpoints";
    if (/vaeloader/i.test(type) || /^vae_name/.test(name)) return "vae";
    if (/loraloader/i.test(type) || /^lora(_|\d|$)/.test(name)) return "loras";
    if (/unetloader|diffusionmodel/i.test(type) || /^unet_name/.test(name)) return "diffusion_models";
    if (/cliploader/i.test(type) || /^clip_name/.test(name)) return "text_encoders";
    if (/controlnet/i.test(type) || /^control_net/.test(name)) return "controlnet";
    if (/upscalemodel/i.test(type)) return "upscale_models";
    if (/^embedding/.test(name)) return "embeddings";
    return "";
}

function setValue(job, value) {
    job.widget.value = value;
    try { job.widget.callback?.(value); } catch (e) { /* 콜백이 까다로워도 값은 들어갔다 */ }
    job.node.setDirtyCanvas?.(true, true);
}


// -------------------------------------------------- 실제 일

async function run() {
    if (!app?.graph) return { noGraph: true };
    // 방금 받은 파일도 목록에 보이게 먼저 새로 읽는다
    await refreshNodeChoices();

    const jobs = collect();
    const fixed = [];      // 목록 안에서 경로만 고침
    const moved = [];      // 파일을 다른 종류 폴더에서 제자리로 옮김
    const elsewhere = [];  // 딴 폴더에서 찾았지만 갈 곳을 몰라 그대로 둠
    const missing = [];    // 어디에도 없음
    const failed = [];     // 옮기다 실패
    const leftovers = [];

    for (const job of jobs) {
        if (job.values.includes(job.widget.value)) continue; // 제자리다
        const match = findMatch(job.widget.value, job.values);
        if (match) {
            const from = job.widget.value;
            setValue(job, match.pick);
            fixed.push({ job, from, to: match.pick, many: match.count > 1 });
        } else {
            leftovers.push(job);
        }
    }

    if (leftovers.length) {
        const names = [...new Set(leftovers.map((job) => baseOf(job.widget.value)))];
        const { data } = await post("/fla/smart-fill/locate", { names });
        const foundMap = data?.ok ? (data.found ?? {}) : {};
        const pending = [];
        for (const job of leftovers) {
            const matches = foundMap[baseOf(job.widget.value)] ?? [];
            if (!matches.length) { missing.push(job); continue; }
            const target = inferKind(job.node, job.widget);
            if (!target) { elsewhere.push({ job, matches }); continue; }
            const inRight = matches.find((m) => m.kind === target);
            if (inRight) {
                // 파일은 제자리에 있는데 목록이 낡았을 뿐이다
                pending.push({ job, name: inRight.name, via: null });
                continue;
            }
            const source = matches[0];
            const { data: mv } = await post("/fla/smart-fill/move",
                { kind: source.kind, name: source.name, to_kind: target });
            if (mv?.ok) pending.push({ job, name: mv.name, via: mv.moved ? source : null });
            else failed.push({ job, error: mv?.error ?? "" });
        }
        if (pending.length) {
            // 옮긴 파일이 고르는 칸에 뜨게 한 번 더 새로 읽은 뒤 넣는다
            await refreshNodeChoices();
            for (const { job, name, via } of pending) {
                const values = comboValues(job.node, job.widget) ?? job.values;
                const entry = values.find((v) => norm(v) === norm(name))
                    ?? values.find((v) => baseOf(v) === baseOf(name))
                    ?? name;
                const from = job.widget.value;
                setValue(job, entry);
                if (via) moved.push({ job, from, to: entry, fromKind: via.kind });
                else fixed.push({ job, from, to: entry, many: false });
            }
        }
    }

    return { count: jobs.length, fixed, moved, elsewhere, missing, failed };
}


// -------------------------------------------------- 결과 창

function addStyles() {
    if (document.getElementById("fla-sf-style")) return;
    const style = document.createElement("style");
    style.id = "fla-sf-style";
    style.textContent = `
      .fla-sf-bg{position:fixed;inset:0;z-index:100010;background:#000b;display:grid;place-items:center;padding:3vh}
      .fla-sf{display:flex;flex-direction:column;width:min(640px,94vw);max-height:88vh;background:#181a1f;color:#ddd;border:1px solid #4b5360;border-radius:12px;overflow:hidden;box-shadow:0 22px 70px #000;font:14px Arial,sans-serif}
      .fla-sf-head{display:flex;align-items:center;gap:10px;padding:11px 14px;background:#22262d;border-bottom:1px solid #383e48}
      .fla-sf-head h2{margin:0;flex:1;font-size:15px;font-weight:700;color:#fff}
      .fla-sf-head .close{flex:none;width:32px;height:32px;padding:0;color:#ddd;background:#303640;border:1px solid #454c58;border-radius:7px;font-size:18px;cursor:pointer}
      .fla-sf-head .close:hover{background:#3a424e}
      .fla-sf-body{flex:1;min-height:0;padding:14px;overflow-y:auto}
      .fla-sf-note{padding:30px 10px;text-align:center;color:#98a1ad}
      .fla-sf-note.good{color:#69db7c}.fla-sf-note.bad{color:#ff9a8f}
      .fla-sf-sum{margin-bottom:12px;color:#fff;font-size:13px;font-weight:700}
      .fla-sf-sec{margin-bottom:14px}
      .fla-sf-sec>h3{display:flex;align-items:center;gap:7px;margin:0 0 7px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.4px}
      .fla-sf-sec>h3 .dot{width:8px;height:8px;border-radius:50%}
      .fla-sf-sec.fix>h3{color:#69db7c}.fla-sf-sec.fix .dot{background:#2f9e44}
      .fla-sf-sec.move>h3{color:#74c0fc}.fla-sf-sec.move .dot{background:#1971c2}
      .fla-sf-sec.else>h3{color:#ffd84d}.fla-sf-sec.else .dot{background:#f59f00}
      .fla-sf-sec.miss>h3{color:#ff9a8f}.fla-sf-sec.miss .dot{background:#c0392b}
      .fla-sf-why{margin:2px 0 7px;color:#7d858f;font-size:12px;line-height:1.5}
      .fla-sf-row{padding:7px 9px;margin-bottom:5px;background:#22262d;border:1px solid #383e48;border-radius:7px}
      .fla-sf-row .who{color:#fff;font-size:12px;font-weight:600}
      .fla-sf-row .what{margin-top:2px;color:#98a1ad;font-size:12px;line-height:1.5;overflow-wrap:anywhere}
    `;
    document.head.appendChild(style);
}

function section(body, kindClass, label, rows, why) {
    if (!rows.length) return;
    const sec = el("div", `fla-sf-sec ${kindClass}`);
    const head = el("h3");
    head.append(el("span", "dot"), document.createTextNode(`${label} · ${rows.length}`));
    sec.appendChild(head);
    if (why) sec.appendChild(el("div", "fla-sf-why", why));
    for (const [who, what] of rows) {
        const row = el("div", "fla-sf-row");
        row.append(el("div", "who", who), el("div", "what", what));
        sec.appendChild(row);
    }
    body.appendChild(sec);
}

function paint(body, report) {
    body.replaceChildren();
    if (report.noGraph) {
        body.appendChild(el("div", "fla-sf-note", t("sfNoGraph")));
        return;
    }
    if (!report.count) {
        body.appendChild(el("div", "fla-sf-note", t("sfNothing")));
        return;
    }
    const unresolved = report.missing.length + report.elsewhere.length + report.failed.length;
    if (!report.fixed.length && !report.moved.length && !unresolved) {
        body.appendChild(el("div", "fla-sf-note good", t("sfAllGood")));
        return;
    }

    body.appendChild(el("div", "fla-sf-sum", t("sfSummary")
        .replace("{fixed}", report.fixed.length)
        .replace("{moved}", report.moved.length)
        .replace("{missing}", unresolved)));

    section(body, "fix", t("sfFixedHead"), report.fixed.map((f) => [
        `${titleOf(f.job.node)} · ${f.job.widget.name}`,
        `${f.from} → ${f.to}${f.many ? " " + t("sfPickedOne") : ""}`,
    ]));
    section(body, "move", t("sfMovedHead"), report.moved.map((m) => [
        `${titleOf(m.job.node)} · ${m.job.widget.name}`,
        `${m.fromKind} → ${m.to}`,
    ]));
    section(body, "else", t("sfElseHead"), report.elsewhere.map(({ job, matches }) => [
        `${titleOf(job.node)} · ${job.widget.name}`,
        `${baseOf(job.widget.value)} — ${matches.map((m) => `${m.kind}/${m.name}`).join(", ")}`,
    ]), t("sfElseWhy"));
    section(body, "miss", t("sfMissingHead"), [
        ...report.missing.map((job) => [
            `${titleOf(job.node)} · ${job.widget.name}`, job.widget.value]),
        ...report.failed.map(({ job, error }) => [
            `${titleOf(job.node)} · ${job.widget.name}`, t("sfMoveFail") + error]),
    ], t("sfMissingWhy"));
}

/** 허브 타일이 부른다. 창을 먼저 띄우고 그 안에서 일한다. */
export async function openSmartFill() {
    addStyles();
    if (document.querySelector(".fla-sf-bg")) return;

    const bg = el("div", "fla-sf-bg");
    const panel = el("div", "fla-sf");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    const head = el("div", "fla-sf-head");
    const closeButton = el("button", "close", "×");
    head.append(el("h2", null, t("sfTitle")), closeButton);
    const body = el("div", "fla-sf-body");
    body.appendChild(el("div", "fla-sf-note", t("sfWorking")));
    panel.append(head, body);
    bg.appendChild(panel);

    const shut = () => { document.removeEventListener("keydown", key, true); bg.remove(); };
    // 캔버스 단축키가 먼저 먹지 않도록 캡처 단계에서 Esc 를 잡는다
    const key = (event) => { if (event.key === "Escape") { event.stopPropagation(); shut(); } };
    closeButton.onclick = shut;
    bg.onclick = (event) => { if (event.target === bg) shut(); };
    document.addEventListener("keydown", key, true);
    document.body.appendChild(bg);

    let report;
    try {
        report = await run();
    } catch (e) {
        body.replaceChildren(el("div", "fla-sf-note bad", String(e?.message || e)));
        return;
    }
    paint(body, report);
}
