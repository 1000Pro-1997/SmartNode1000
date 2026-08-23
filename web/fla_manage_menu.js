/** 관리창들이 같이 쓰는 오른쪽 클릭 메뉴와 알림.
 *
 *  체크포인트 창과 워크플로우 창이 같은 메뉴를 쓴다. 한쪽에만 넣어두면
 *  다른 창을 먼저 열었을 때 메뉴 모양이 무너지므로 여기로 뺐다.
 *  여기서는 아무것도 가져오지 않아 서로 물고 도는 일이 없다.
 */

/** 메뉴가 화면 밖으로 나가지 않게 두는 여백(px). */
const EDGE = 8;

export function addMenuStyles() {
    if (document.getElementById("fla-mm-menu-style")) return;
    const style = document.createElement("style");
    style.id = "fla-mm-menu-style";
    style.textContent = `
      .fla-mm-ctx{position:fixed;z-index:100022;top:0;left:0;min-width:180px;padding:5px;background:#292d34;border:1px solid #505763;border-radius:6px;box-shadow:0 8px 25px #000;font:14px Arial,sans-serif}
      .fla-mm-ctx button{display:block;width:100%;padding:8px 11px;color:#ddd;background:transparent;border:0;border-radius:4px;text-align:left;font-size:13px;cursor:pointer}
      .fla-mm-ctx button:hover{background:#3a424e}
      .fla-mm-ctx button.danger{color:#ff9a8f}.fla-mm-ctx button.danger:hover{color:#fff;background:#a83426}
      .fla-mm-ctx .rule{height:1px;margin:4px 6px;background:#3d444e}
    `;
    document.head.appendChild(style);
}

/** 열려 있는 메뉴를 모두 닫는다(빵부스러기 메뉴까지). */
export function closeMenus() {
    document.querySelectorAll(".fla-lp-menu,.fla-mm-ctx").forEach((menu) => menu.remove());
}

/** 커서 자리에 메뉴를 연다.
 *
 *  entries 는 [라벨, 할 일] 짝의 배열이다. 라벨 자리에 null 을 주면 가로줄이,
 *  세 번째 값에 true 를 주면 빨간 글씨(지우기 같은 것)가 된다.
 */
export function openContextMenu(entries, event) {
    addMenuStyles();
    closeMenus();

    const menu = document.createElement("div");
    menu.className = "fla-mm-ctx";
    for (const [label, action, danger] of entries) {
        if (label === null) {
            menu.appendChild(Object.assign(document.createElement("div"), { className: "rule" }));
            continue;
        }
        const button = document.createElement("button");
        if (danger) button.className = "danger";
        button.textContent = label;
        button.onclick = () => { closeMenus(); action(); };
        menu.appendChild(button);
    }

    document.body.appendChild(menu);
    // 크기를 알아야 자리를 잡을 수 있어서 붙인 다음에 옮긴다
    const box = menu.getBoundingClientRect();
    const left = Math.min(event.clientX, window.innerWidth - box.width - EDGE);
    const top = Math.min(event.clientY, window.innerHeight - box.height - EDGE);
    menu.style.left = `${Math.max(EDGE, left)}px`;
    menu.style.top = `${Math.max(EDGE, top)}px`;
    return menu;
}

/** 짧은 알림. 로라 창의 토스트 모양을 그대로 쓴다. */
export function toast(message, bad = false) {
    const box = document.createElement("div");
    box.className = `fla-lp-toast${bad ? " bad" : ""}`;
    box.textContent = message;
    document.body.appendChild(box);
    setTimeout(() => box.remove(), 2600);
}
