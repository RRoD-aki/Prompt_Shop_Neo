// =========================
// プロンプト挿入機能（最重要）
// =========================
function setupInsertPrompt() {
    window.insertPrompt = function(text) {
        const textarea = getPromptShopTextarea();
        if (!textarea) {
            console.log("❌ textarea見つからない");
            return;
        }

        textarea.value += (textarea.value ? ", " : "") + text;
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
    };
}

// =========================
// PromptShop UI配置＆右下タブ開閉
// =========================
function setupPromptShop() {
    const root = document.getElementById("prompt-shop-root");

    if (!root) return;
    if (root.dataset.moved) return;

    root.dataset.moved = "true";

    // タブコンテンツ内から、画面下部固定UIとしてbody直下へ移動
    document.body.appendChild(root);

    root.style.cssText = `
        position: fixed;
        left: 0;
        right: 0;
        bottom: 0;
        z-index: 10000;
        pointer-events: none;
    `;

    const savedHeight = localStorage.getItem("promptShopNeoDockHeight") || "45vh";
    // 開閉状態は保存しない。WebUI起動/再読み込み時は必ず閉じた状態から始める。
    localStorage.removeItem("promptShopNeoDockOpen");
    let open = false;

    root.innerHTML = `
    <div id="prompt-shop-wrapper" style="
        position: relative;
        width: calc(100vw - 24px);
        max-width: none;
        margin: 0 12px;
        transform: translateY(calc(100% - 42px));
        transition: transform 0.25s ease;
        pointer-events: none;
    ">
        <div id="prompt-shop-header" role="button" aria-expanded="false" style="
            width: 220px;
            height: 42px;
            margin: 0 12px 0 auto;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            pointer-events: auto;
            user-select: none;
            background: #111;
            color: #fff;
            padding: 0 14px;
            border: 1px solid #333;
            border-bottom: none;
            border-radius: 12px 12px 0 0;
            font-size: 14px;
            font-weight: 700;
            box-shadow: 0 -8px 24px rgba(0,0,0,0.35);
        ">
            △ Prompt Shop
        </div>

        <div id="prompt-shop-resize-grip" title="ドラッグで高さ調整" style="
            height: 7px;
            cursor: ns-resize;
            pointer-events: auto;
            background: #18181b;
            border-left: 1px solid #333;
            border-right: 1px solid #333;
        "></div>

        <div id="prompt-shop-container" style="
            width: 100%;
            height: ${savedHeight};
            min-height: 220px;
            max-height: 85vh;
            overflow: hidden;
            pointer-events: auto;
            background: #0a0a0c;
            border: 1px solid #333;
            border-top: none;
            border-radius: 0 0 0 0;
            box-shadow: 0 -12px 32px rgba(0,0,0,0.45);
        ">
            <iframe src="/file=extensions/Prompt_shop_neo/assets/index.html?v=${Date.now()}"
                    style="width:100%; height:100%; border:none; display:block;">
            </iframe>
        </div>
    </div>
    `;

    const wrapper = document.getElementById("prompt-shop-wrapper");
    const header = document.getElementById("prompt-shop-header");
    const container = document.getElementById("prompt-shop-container");
    const grip = document.getElementById("prompt-shop-resize-grip");

    function applyDockState() {
        wrapper.style.transform = open
            ? "translateY(0)"
            : "translateY(calc(100% - 42px))";

        header.textContent = open ? "▽ Prompt Shop" : "△ Prompt Shop";
        header.setAttribute("aria-expanded", open ? "true" : "false");
    }

    header.onclick = () => {
        open = !open;
        applyDockState();
    };

    // 起動時・再描画時に旧版の残留状態を消す
    restorePromptShopResizeState();

    // 上端グリップをドラッグして高さ調整
    // iframe自体の pointer-events は変更しない。
    // 代わりにリサイズ中だけ透明シールドをbody直下に出して、iframeにカーソルが入っても
    // pointermove / pointerup を親画面側で取り続ける。
    grip.addEventListener("pointerdown", (e) => {
        if (e.button !== undefined && e.button !== 0) return;

        e.preventDefault();
        e.stopPropagation();

        restorePromptShopResizeState();

        if (!open) {
            open = true;
            applyDockState();
        }

        const startY = e.clientY;
        const startHeight = container.getBoundingClientRect().height;
        const oldBodyUserSelect = document.body.style.userSelect;
        const oldBodyCursor = document.body.style.cursor;

        const shield = document.createElement("div");
        shield.id = "prompt-shop-resize-shield";
        shield.style.cssText = `
            position: fixed;
            inset: 0;
            z-index: 2147483647;
            cursor: ns-resize;
            background: transparent;
            pointer-events: auto;
            user-select: none;
        `;
        document.body.appendChild(shield);

        document.body.style.userSelect = "none";
        document.body.style.cursor = "ns-resize";

        const onMove = (moveEvent) => {
            moveEvent.preventDefault();
            moveEvent.stopPropagation();

            const delta = startY - moveEvent.clientY;
            const maxHeight = Math.floor(window.innerHeight * 0.85);
            const nextHeight = Math.max(220, Math.min(maxHeight, startHeight + delta));

            container.style.height = `${nextHeight}px`;
        };

        const finishResize = () => {
            localStorage.setItem("promptShopNeoDockHeight", container.style.height);

            document.body.style.userSelect = oldBodyUserSelect;
            document.body.style.cursor = oldBodyCursor;

            shield.remove();

            window.removeEventListener("pointermove", onMove, true);
            window.removeEventListener("pointerup", finishResize, true);
            window.removeEventListener("pointercancel", finishResize, true);
            window.removeEventListener("blur", finishResize, true);
            shield.removeEventListener("pointermove", onMove, true);
            shield.removeEventListener("pointerup", finishResize, true);
            shield.removeEventListener("pointercancel", finishResize, true);

            promptShopResizeCleanup = null;
        };

        promptShopResizeCleanup = finishResize;

        window.addEventListener("pointermove", onMove, { capture: true, passive: false });
        window.addEventListener("pointerup", finishResize, true);
        window.addEventListener("pointercancel", finishResize, true);
        window.addEventListener("blur", finishResize, true);
        shield.addEventListener("pointermove", onMove, { capture: true, passive: false });
        shield.addEventListener("pointerup", finishResize, true);
        shield.addEventListener("pointercancel", finishResize, true);
    });

    const iframe = container.querySelector("iframe");
    if (iframe) {
        iframe.addEventListener("load", () => {
            setTimeout(() => broadcastPromptShopPrompt(true), 100);
        });
    }

    applyDockState();
    setupPromptShopPromptWatcher();
}

function widenMainContainer() {
    const main = gradioApp()?.querySelector?.('.main-container');
    if (main) {
        main.style.maxWidth = "100%";
    }
}


// =========================
// リサイズ中の入力判定復旧
// =========================
let promptShopResizeCleanup = null;

function restorePromptShopResizeState() {
    if (typeof promptShopResizeCleanup === "function") {
        promptShopResizeCleanup();
        promptShopResizeCleanup = null;
    }

    // 旧版で iframe に pointer-events:none が残った場合の救済
    document.querySelectorAll('#prompt-shop-container iframe').forEach(iframe => {
        iframe.style.pointerEvents = "";
    });

    document.querySelectorAll('#prompt-shop-resize-shield').forEach(el => el.remove());
}

window.addEventListener("pointerup", restorePromptShopResizeState, true);
window.addEventListener("pointercancel", restorePromptShopResizeState, true);
window.addEventListener("blur", restorePromptShopResizeState, true);
document.addEventListener("visibilitychange", () => {
    if (document.hidden) restorePromptShopResizeState();
});


// =========================
// textarea監視 → iframeへ通知
// =========================
let promptShopPromptWatcherStarted = false;
let promptShopPromptWatchTimer = null;
let promptShopObservedTextarea = null;
let promptShopLastPromptValue = null;
const promptShopWatchedTextareas = new WeakSet();

function getPromptShopTextarea() {
    try {
        const app = gradioApp?.();
        if (!app) return null;

        return app.querySelector('#txt2img_prompt textarea') ||
               app.querySelector('#img2img_prompt textarea') ||
               app.querySelector('textarea[data-testid="textbox"]') ||
               null;
    } catch (err) {
        return null;
    }
}

function getPromptShopIframe() {
    return document.querySelector('#prompt-shop-container iframe');
}

function broadcastPromptShopPrompt(force = false) {
    const textarea = getPromptShopTextarea();
    const value = textarea ? (textarea.value || "") : "";

    if (!force && value === promptShopLastPromptValue) return;
    promptShopLastPromptValue = value;

    const iframe = getPromptShopIframe();
    if (iframe?.contentWindow) {
        iframe.contentWindow.postMessage({
            type: "promptShopPromptChanged",
            text: value
        }, "*");
    }
}

function bindPromptShopTextareaWatcher(textarea) {
    if (!textarea) return false;

    promptShopObservedTextarea = textarea;

    if (!promptShopWatchedTextareas.has(textarea)) {
        promptShopWatchedTextareas.add(textarea);
        ["input", "change", "keyup", "paste", "drop", "compositionend"].forEach(eventName => {
            textarea.addEventListener(eventName, () => broadcastPromptShopPrompt(true));
        });
    }

    broadcastPromptShopPrompt(true);
    return true;
}

function setupPromptShopPromptWatcher() {
    if (!promptShopPromptWatcherStarted) {
        promptShopPromptWatcherStarted = true;

        promptShopPromptWatchTimer = setInterval(() => {
            const textarea = getPromptShopTextarea();

            if (textarea && textarea !== promptShopObservedTextarea) {
                bindPromptShopTextareaWatcher(textarea);
                return;
            }

            broadcastPromptShopPrompt(false);
        }, 200);
    }

    bindPromptShopTextareaWatcher(getPromptShopTextarea());
}

// =========================
// iframeとの通信（保険）
// =========================
window.addEventListener("message", (event) => {
    if (event.data?.type === "insertPrompt") {
        window.insertPrompt(event.data.text);
    }
});

// =========================
// Gradio対応（超重要）
// =========================
onUiLoaded(() => {
    setupInsertPrompt();
    setupPromptShop();
    widenMainContainer();
    setupPromptShopPromptWatcher();
});

onUiUpdate(() => {
    setupInsertPrompt();
    setupPromptShop();
    widenMainContainer();
    setupPromptShopPromptWatcher();
});
