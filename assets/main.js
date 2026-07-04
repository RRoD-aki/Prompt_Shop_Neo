// Selectors
const promptGrid = document.getElementById('promptGrid');
const siteLogo = document.getElementById('siteLogo');
const sidebarNav = document.getElementById('sidebarNav');
const toast = document.getElementById('toast');
const menuToggle = document.getElementById('menuToggle');
const sidebar = document.getElementById('sidebar');
const searchInput = document.querySelector('.search-input');

let fileHandle = null;
let allPrompts = [];
let siteSettings = {};

let editMode = false;
let promptShopDraggingCardId = null;
let cardMinWidth = Number(localStorage.getItem("promptShopCardSize") || 180);
let promptShopInsertSpaceAfterComma = true;
let promptShopNoImageMode = localStorage.getItem("promptShopNoImageMode") === "true";
let promptShopAutoCommaSpacingTimer = null;
let promptShopAutoCommaSpacingApplying = false;

const PROMPT_SORTER_CHIP_TYPE_TAG = "tag";
const PROMPT_SORTER_CHIP_TYPE_NEWLINE = "newline";
const PROMPT_SORTER_NEWLINE_TOKEN = "\n";

function getPromptSorterChipKind(chipOrDescriptor) {
    if (!chipOrDescriptor) return PROMPT_SORTER_CHIP_TYPE_TAG;
    if (typeof chipOrDescriptor === "object") {
        return chipOrDescriptor.type === PROMPT_SORTER_CHIP_TYPE_NEWLINE ||
            chipOrDescriptor.tag === PROMPT_SORTER_NEWLINE_TOKEN
            ? PROMPT_SORTER_CHIP_TYPE_NEWLINE
            : PROMPT_SORTER_CHIP_TYPE_TAG;
    }

    return String(chipOrDescriptor) === PROMPT_SORTER_NEWLINE_TOKEN
        ? PROMPT_SORTER_CHIP_TYPE_NEWLINE
        : PROMPT_SORTER_CHIP_TYPE_TAG;
}

function isPromptSorterNewlineChip(chipOrDescriptor) {
    return getPromptSorterChipKind(chipOrDescriptor) === PROMPT_SORTER_CHIP_TYPE_NEWLINE;
}

function createPromptSorterParsedChip(tag, type = null) {
    const kind = type || (String(tag ?? "") === PROMPT_SORTER_NEWLINE_TOKEN
        ? PROMPT_SORTER_CHIP_TYPE_NEWLINE
        : PROMPT_SORTER_CHIP_TYPE_TAG);

    return {
        type: kind,
        tag: kind === PROMPT_SORTER_CHIP_TYPE_NEWLINE
            ? PROMPT_SORTER_NEWLINE_TOKEN
            : String(tag ?? "").trim()
    };
}

function promptSorterChipMatchesDescriptor(chip, descriptor) {
    const chipKind = getPromptSorterChipKind(chip);
    const descriptorKind = getPromptSorterChipKind(descriptor);

    if (chipKind !== descriptorKind) return false;
    if (chipKind === PROMPT_SORTER_CHIP_TYPE_NEWLINE) return true;

    return String(chip?.tag ?? "").trim() === String(descriptor?.tag ?? "").trim();
}

function getPromptDelimiter() {
    return promptShopInsertSpaceAfterComma ? ", " : ",";
}

function joinPromptTokens(tokens) {
    return (tokens || [])
        .map(token => String(token ?? "").trim())
        .filter(Boolean)
        .join(getPromptDelimiter());
}

function replaceSingleUnderscoresOnly(text) {
    // _ が1個だけの部分だけスペースにする。__ や ___ のような連続アンダーバーは保持する。
    // LoRAなど <...> に囲まれた範囲は、モデル名/LoRA名の _ を壊さないように対象外にする。
    const source = String(text ?? "");
    let result = "";
    let current = "";

    const replaceOutsideAngle = value => String(value ?? "").replace(/_+/g, match =>
        match.length === 1 ? " " : match
    );

    for (let i = 0; i < source.length; i++) {
        const ch = source[i];
        const prev = source[i - 1];

        if (prev !== "\\" && ch === "<") {
            let angle = ch;
            let foundClose = false;

            for (let j = i + 1; j < source.length; j++) {
                const angleCh = source[j];
                const anglePrev = source[j - 1];
                angle += angleCh;

                if (anglePrev !== "\\" && angleCh === ">") {
                    foundClose = true;
                    result += replaceOutsideAngle(current);
                    result += angle;
                    current = "";
                    i = j;
                    break;
                }
            }

            if (foundClose) continue;
        }

        current += ch;
    }

    result += replaceOutsideAngle(current);
    return result;
}

function findPromptAngleBracketEnd(text, startIndex) {
    const source = String(text ?? "");
    if (source[startIndex] !== "<") return -1;

    for (let i = startIndex + 1; i < source.length; i++) {
        const ch = source[i];
        const prev = source[i - 1];
        if (prev !== "\\" && ch === ">") return i;
    }

    return -1;
}

function pushPromptToken(result, token, withBreaks = false) {
    const tag = String(token ?? "").trim();
    if (!tag) return;

    if (withBreaks) {
        result.push(createPromptSorterParsedChip(tag, PROMPT_SORTER_CHIP_TYPE_TAG));
        return;
    }

    result.push(tag);
}

function replaceCurrentPromptSingleUnderscores() {
    const currentText = getPromptTextareaValue();
    if (currentText === null || currentText === undefined) return;

    const nextText = replaceSingleUnderscoresOnly(currentText);
    if (nextText === currentText) return;

    setPromptTextareaValue(nextText);
}

function normalizeTopLevelCommaSpacing(text) {
    const source = String(text ?? "");
    let result = "";
    const stack = [];
    const pairs = {
        "(": ")",
        "[": "]",
        "{": "}"
    };

    for (let i = 0; i < source.length; i++) {
        const ch = source[i];
        const prev = source[i - 1];

        if (prev !== "\\" && (ch === "(" || ch === "[" || ch === "{")) {
            stack.push(pairs[ch]);
            result += ch;
            continue;
        }

        if (prev !== "\\" && stack.length > 0 && ch === stack[stack.length - 1]) {
            stack.pop();
            result += ch;
            continue;
        }

        if (ch === "," && stack.length === 0) {
            result += ",";

            let j = i + 1;
            while (source[j] === " " || source[j] === "\t") {
                j++;
            }

            // 行末や改行直前には余計なスペースを足さない。
            // 次のタグが続く時だけ「, 」へ揃える。
            if (j < source.length && source[j] !== "\n" && source[j] !== "\r") {
                result += " ";
            }

            i = j - 1;
            continue;
        }

        result += ch;
    }

    return result;
}

function setPromptTextareaValuePreservingSelection(textarea, nextValue, previousValue) {
    const oldStart = typeof textarea.selectionStart === "number" ? textarea.selectionStart : null;
    const oldEnd = typeof textarea.selectionEnd === "number" ? textarea.selectionEnd : null;
    const oldDirection = textarea.selectionDirection || "none";

    textarea.value = nextValue;

    if (oldStart !== null && oldEnd !== null && document.activeElement === textarea) {
        const nextStart = normalizeTopLevelCommaSpacing(String(previousValue ?? "").slice(0, oldStart)).length;
        const nextEnd = normalizeTopLevelCommaSpacing(String(previousValue ?? "").slice(0, oldEnd)).length;

        try {
            textarea.setSelectionRange(nextStart, nextEnd, oldDirection);
        } catch (err) {
            // selectionRange非対応環境ではカーソル復元を諦める。
        }
    }

    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
}

function applyPromptCommaSpacingIfNeeded(options = {}) {
    const force = Boolean(options.force);
    if ((!force && !promptShopInsertSpaceAfterComma) || promptShopAutoCommaSpacingApplying) return false;

    const textarea = getPromptTextarea();
    const currentText = textarea ? (textarea.value || "") : (promptShopExternalPromptValue || "");
    const nextText = normalizeTopLevelCommaSpacing(currentText);

    if (nextText === currentText) return false;

    promptShopAutoCommaSpacingApplying = true;

    try {
        if (textarea) {
            setPromptTextareaValuePreservingSelection(textarea, nextText, currentText);
        }

        promptShopExternalPromptValue = nextText;
        lastPromptTextareaValue = nextText;
        scheduleActiveStateSync(true, nextText);
    } finally {
        promptShopAutoCommaSpacingApplying = false;
    }

    return true;
}

function setupPromptShopAutoCommaSpacing() {
    // 自動整形は入力中のカーソル位置が動く原因になるため使わない。
    // 整形したい時は下部ツールバーの「,後スペース整形」ボタンで手動実行する。
    return;
}

function applyPromptShopNoImageMode(save = false) {
    document.body.classList.toggle("promptshop-no-image-mode", promptShopNoImageMode);

    if (save) {
        localStorage.setItem("promptShopNoImageMode", promptShopNoImageMode ? "true" : "false");
    }

    schedulePromptShopFixedChromeLayout();
}

// =========================
// txt2img textarea realtime glow sync
// =========================
let promptShopExternalPromptValue = "";
let promptTextareaWatcherStarted = false;
let promptTextareaWatchTimer = null;
let observedPromptTextarea = null;
let lastPromptTextareaValue = null;
let promptSyncRaf = null;
const watchedPromptTextareas = new WeakSet();
let promptSorterDragIndex = null;
let promptSorterChipState = [];
let promptSorterChipStateInitialized = false;
let promptSorterChipSerial = 0;
let promptSorterOpenToolChipId = null;
let promptSorterSuppressToolCloseUntil = 0;
let promptSorterLastPointerX = 0;
let promptSorterLastPointerY = 0;
let promptSorterSelectedChipIds = new Set();
let promptSorterDragSelectionIds = null;
let promptSorterDragSession = null;
let promptSorterSelectionDrag = null;

// =========================
// fixed top/bottom chrome layout
// =========================
let promptShopFixedLayoutRaf = null;
let promptShopFixedLayoutObserverStarted = false;
let promptShopFixedLayoutResizeObserver = null;

function schedulePromptShopFixedChromeLayout() {
    if (promptShopFixedLayoutRaf) return;

    promptShopFixedLayoutRaf = requestAnimationFrame(() => {
        promptShopFixedLayoutRaf = null;
        updatePromptShopFixedChromeLayout();
    });
}

function updatePromptShopFixedChromeLayout() {
    const sorter = document.getElementById("promptSorterWrapper");
    const toolbar = document.getElementById("editToolbarWrapper");
    const root = document.documentElement;

    const sorterHeight = sorter ? Math.ceil(sorter.getBoundingClientRect().height) : 0;
    const toolbarHeight = toolbar ? Math.ceil(toolbar.getBoundingClientRect().height) : 0;

    root.style.setProperty("--prompt-sorter-fixed-height", `${sorterHeight}px`);
    root.style.setProperty("--prompt-toolbar-fixed-height", `${toolbarHeight}px`);
}

function observePromptShopFixedChromeElement(element) {
    if (!element || !promptShopFixedLayoutResizeObserver) return;
    if (element.dataset.promptShopFixedChromeObserved === "true") return;

    element.dataset.promptShopFixedChromeObserved = "true";
    promptShopFixedLayoutResizeObserver.observe(element);
}

function setupPromptShopFixedChromeLayout() {
    if (promptShopFixedLayoutObserverStarted) {
        observePromptShopFixedChromeElement(document.getElementById("promptSorterWrapper"));
        observePromptShopFixedChromeElement(document.getElementById("editToolbarWrapper"));
        schedulePromptShopFixedChromeLayout();
        return;
    }

    promptShopFixedLayoutObserverStarted = true;

    if (typeof ResizeObserver !== "undefined") {
        promptShopFixedLayoutResizeObserver = new ResizeObserver(schedulePromptShopFixedChromeLayout);
    }

    window.addEventListener("resize", schedulePromptShopFixedChromeLayout);
    observePromptShopFixedChromeElement(document.getElementById("promptSorterWrapper"));
    observePromptShopFixedChromeElement(document.getElementById("editToolbarWrapper"));
    schedulePromptShopFixedChromeLayout();
}


const PROMPT_SORTER_WEIGHT_STEP = 0.1;
const PROMPT_SORTER_DEFAULT_WEIGHT = 1.0;

const LUCIDE_ICON_OPTIONS = [
    "package", "smile", "heart", "star", "sparkles",
    "image", "camera", "palette", "wand-sparkles",
    "tag", "zap", "activity", "flame", "eye",
    "user", "shirt", "gem", "flower", "leaf",
    "droplets", "cloud", "moon", "sun", "folder"
];

const ICON_LABELS = {
    package: "📦",
    smile: "😊",
    heart: "❤️",
    star: "⭐",
    sparkles: "✨",
    image: "🖼️",
    camera: "📷",
    palette: "🎨",
    "wand-sparkles": "🪄",
    tag: "🏷️",
    zap: "⚡",
    activity: "📊",
    flame: "🔥",
    eye: "👁️",
    user: "👤",
    shirt: "👕",
    gem: "💎",
    flower: "🌸",
    leaf: "🍃",
    droplets: "💧",
    cloud: "☁️",
    moon: "🌙",
    sun: "☀️",
    folder: "📁"
};

function createIconOptions(selected = "package") {
    return LUCIDE_ICON_OPTIONS.map(icon => `
        <option value="${icon}" ${icon === selected ? "selected" : ""}>
            ${ICON_LABELS[icon] || ""} ${icon}
        </option>
    `).join("");
}
// Fetch Data from API
async function init() {
    try {
        if (window.STATIC_DATA) {
            siteSettings = window.STATIC_DATA.settings;
            allPrompts = window.STATIC_DATA.prompts;
        } else {
            // 🔥 JSON読み込み
            const res = await fetch(`prompts.json?v=${Date.now()}`, {
                cache: "no-store"
            });
            const data = await res.json();

            siteSettings = data.settings;
            allPrompts = data.prompts;

            // ↓ 後から上書き
            loadSavedPrompts();
        }

        loadSavedPrompts(); // ←ローカル上書き

        renderSettings();
        applyPromptShopNoImageMode(false);
        renderSidebar();
        renderToolbar();
        renderPromptSorter();
        setupPromptShopFixedChromeLayout();
        renderPrompts();
        applyCardSize();
        setupPromptTextareaWatcher();
        // カンマ後スペース整形は手動ボタンで実行する。

    } catch (err) {
        console.error('Failed to initialize:', err);
    }
}

function renderSettings() {
    siteLogo.textContent = siteSettings.siteTitle || 'PROMPT MARKET';
    document.title = siteSettings.siteTitle || 'Prompt Market';
}

function renderSidebar() {
    const selectedCategory = getCurrentCategory ? getCurrentCategory() : 'all';
    sidebarNav.innerHTML = '';
    
    // "Show All" item
    const allItem = document.createElement('a');
    allItem.href = '#';
    allItem.className = `nav-item ${selectedCategory === 'all' ? 'active' : ''}`;
    allItem.setAttribute('data-category', 'all');
    allItem.innerHTML = `<i data-lucide="layout-grid"></i><span>すべて表示</span><span class="count-badge">${allPrompts.length}</span>`;
    sidebarNav.appendChild(allItem);

    // Dynamic Categories
    const uncategorizedCount = allPrompts.filter(isUncategorizedPrompt).length;

    if (uncategorizedCount > 0) {
        const uncategorizedItem = document.createElement('div');
        uncategorizedItem.className = `nav-item ${selectedCategory === 'uncategorized' ? 'active' : ''}`;
        uncategorizedItem.setAttribute('data-category', 'uncategorized');
        uncategorizedItem.innerHTML = `
            <i data-lucide="circle-help"></i>
            <span>未分類</span>
            <span class="count-badge">${uncategorizedCount}</span>
        `;
        sidebarNav.appendChild(uncategorizedItem);
    }
    (siteSettings.categories || []).forEach(cat => {
        const group = document.createElement('div');
        group.className = 'nav-group';
        group.innerHTML = `<div class="nav-label">${cat.name}</div>`;
        
        const wrapper = document.createElement('div');
        wrapper.className = 'nav-item-wrapper';
        
        const subCatIds = cat.subCategories ? cat.subCategories.map(s => s.id) : [];
        const parentPromptsCount = allPrompts.filter(p => p.category === cat.id || subCatIds.includes(p.category)).length;

        const mainItem = document.createElement('div');
        mainItem.className = `nav-item ${selectedCategory === cat.id ? 'active' : ''}`;
        mainItem.setAttribute('data-category', cat.id);
        mainItem.innerHTML = `<i data-lucide="${cat.icon || 'package'}"></i><span>${cat.name}</span><span class="count-badge">${parentPromptsCount}</span>`;
        wrapper.appendChild(mainItem);
        
        if (cat.subCategories && cat.subCategories.length > 0) {
            const subContainer = document.createElement('div');
            subContainer.className = 'nav-sub';
            cat.subCategories.forEach(sub => {
                const subCount = allPrompts.filter(p => p.category === sub.id).length;
                const subItem = document.createElement('div');
                subItem.className = `nav-sub-item ${selectedCategory === sub.id ? 'active' : ''}`;
                subItem.setAttribute('data-category', sub.id);
                subItem.innerHTML = `<span>${sub.name}</span><span class="count-badge">${subCount}</span>`;
                subContainer.appendChild(subItem);
            });
            wrapper.appendChild(subContainer);
        }
        
        group.appendChild(wrapper);
        sidebarNav.appendChild(group);
    });

    lucide.createIcons();
    attachNavListeners();
    attachPromptCardCategoryBarDrop();
}

function attachNavListeners() {
    const navItems = document.querySelectorAll('.nav-item, .nav-sub-item');

    navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();

            navItems.forEach(i => i.classList.remove('active'));
            item.classList.add('active');

            const category = item.getAttribute('data-category');
            renderPrompts(category, getCurrentSearchValue());

            // スクロール
            setTimeout(() => {
                window.scrollTo({
                    top: 0,
                    behavior: "smooth"
                });

                document.documentElement.scrollTop = 0;
                document.body.scrollTop = 0;
            }, 0);

            // モバイル用
            if (window.innerWidth <= 768) {
                sidebar.classList.remove('open');
            }
        });
    });
}

// Render Function
function renderPrompts(filter = 'all', searchQuery = '') {
    hidePromptShopTooltip();
    clearPromptCardDropHighlights();
    promptGrid.innerHTML = '';
    promptGrid.removeAttribute('data-drop-category');
    
    // Grouping is used for "Show All" or "Parent Category" filters without search
    const isParentFilter = siteSettings.categories.some(c => c.id === filter);
    const hasCategories = (siteSettings.categories || []).length > 0;
    const useGrouping = hasCategories && (filter === 'all' || isParentFilter) && searchQuery === '';

    if (useGrouping) {
        promptGrid.classList.remove('prompt-grid');
        
        const categoriesToRender = filter === 'all' 
            ? siteSettings.categories 
            : [siteSettings.categories.find(c => c.id === filter)];

        if (filter === "all") {
            const uncategorizedPrompts = allPrompts.filter(isUncategorizedPrompt);

            if (uncategorizedPrompts.length > 0) {
                const section = document.createElement("section");
                section.className = "category-section";
                section.dataset.dropCategory = "uncategorized";
                section.innerHTML = `<h2 class="category-header" data-drop-category="uncategorized">未分類</h2>`;

                const grid = document.createElement("div");
                grid.className = "prompt-grid";
                grid.dataset.dropCategory = "uncategorized";

                uncategorizedPrompts.forEach(p => {
                    grid.appendChild(createPromptCard(p));
                });

                section.appendChild(grid);
                promptGrid.appendChild(section);
            }
        }

        categoriesToRender.forEach(parentCat => {
            const parentPrompts = allPrompts.filter(p => p.category === parentCat.id);
            const subCategorySections = [];

            (parentCat.subCategories || []).forEach(sub => {
                const subPrompts = allPrompts.filter(p => p.category === sub.id);
                if (subPrompts.length > 0 || editMode) {
                    subCategorySections.push({ id: sub.id, title: sub.name, prompts: subPrompts });
                }
            });
            if (parentPrompts.length > 0 || subCategorySections.length > 0 || editMode) {
                const section = document.createElement('section');
                section.className = 'category-section';
                section.dataset.dropCategory = parentCat.id;
                section.innerHTML = `<h2 class="category-header" data-drop-category="${escapeHtml(parentCat.id)}">${parentCat.name}</h2>`;
                
                if (parentPrompts.length > 0 || editMode) {
                    const grid = document.createElement('div');
                    grid.className = 'prompt-grid';
                    grid.dataset.dropCategory = parentCat.id;
                    parentPrompts.forEach(p => grid.appendChild(createPromptCard(p)));
                    if (parentPrompts.length === 0 && editMode) {
                        grid.appendChild(createPromptShopEmptyCategoryDropHint(parentCat.name));
                    }
                    section.appendChild(grid);
                }

                subCategorySections.forEach(subGroup => {
                    const subHeader = document.createElement('h3');
                    subHeader.className = 'sub-category-header';
                    subHeader.style.margin = '2rem 0 1rem';
                    subHeader.style.fontSize = '1.1rem';
                    subHeader.style.color = 'var(--text-secondary)';
                    subHeader.style.borderLeft = '3px solid var(--accent)';
                    subHeader.style.paddingLeft = '0.75rem';
                    subHeader.textContent = subGroup.title;
                    subHeader.dataset.dropCategory = subGroup.id;
                    section.appendChild(subHeader);

                    const grid = document.createElement('div');
                    grid.className = 'prompt-grid';
                    grid.dataset.dropCategory = subGroup.id;
                    subGroup.prompts.forEach(p => grid.appendChild(createPromptCard(p)));
                    if (subGroup.prompts.length === 0 && editMode) {
                        grid.appendChild(createPromptShopEmptyCategoryDropHint(subGroup.title));
                    }
                    section.appendChild(grid);
                });
                
                promptGrid.appendChild(section);
            }
        });
    } else {
        // Flat list (filtered or searching)
        promptGrid.classList.add('prompt-grid');
        promptGrid.dataset.dropCategory = isValidPromptShopCategoryId(filter) ? filter : (filter === 'uncategorized' ? 'uncategorized' : '');
        
        const targetParent = (siteSettings.categories || []).find(c => c.id === filter);
        const subCatIds = targetParent ? targetParent.subCategories.map(s => s.id) : [];

        const filtered = allPrompts.filter(p => {
            const matchesCategory =
                filter === 'all' ||
                (filter === 'uncategorized' && isUncategorizedPrompt(p)) ||
                p.category === filter ||
                subCatIds.includes(p.category);
            const matchesSearch = p.title.toLowerCase().includes(searchQuery.toLowerCase()) || 
                                 p.prompt.toLowerCase().includes(searchQuery.toLowerCase());
            return matchesCategory && matchesSearch;
        });

        if (filtered.length === 0) {
            promptGrid.innerHTML = '<p style="color: var(--text-secondary); grid-column: 1/-1; text-align: center; padding: 3rem;">該当するプロンプトが見つかりませんでした。編集モード中は、この空欄へカードをドロップしてカテゴリ変更できます。</p>';
            attachDragAndDrop();
            return;
        }

        filtered.forEach(p => {
            promptGrid.appendChild(createPromptCard(p));
        });
    }
    
    lucide.createIcons();
    attachDragAndDrop();
    // 再描画後に選択状態を復元
    setTimeout(syncActiveStates, 0);
}


function createPromptShopEmptyCategoryDropHint(categoryName = "このカテゴリ") {
    const hint = document.createElement("div");
    hint.className = "promptshop-category-empty-drop-hint";
    hint.textContent = `空のカテゴリです。編集モード中はここへカードをドロップして「${categoryName}」へ移動できます。`;
    return hint;
}

function getAllCategoryIds() {
    const ids = [];

    (siteSettings.categories || []).forEach(cat => {
        ids.push(cat.id);
        (cat.subCategories || []).forEach(sub => ids.push(sub.id));
    });

    return ids;
}

function isUncategorizedPrompt(p) {
    const ids = getAllCategoryIds();
    return !p.category || !ids.includes(p.category);
}

function getCategoryName(id) {
    for (const cat of siteSettings.categories || []) {
        if (cat.id === id) return cat.name;
        if (cat.subCategories) {
            const sub = cat.subCategories.find(s => s.id === id);
            if (sub) return sub.name;
        }
    }
    return 'その他';
}

function createPromptCard(p) {
    if (!p.id) {
        p.id = String(Date.now()) + "-" + Math.random().toString(36).slice(2);
    }

    const card = document.createElement('div');
    card.className = 'prompt-card';
    card.dataset.id = p.id;

    const fullImageSrc = p.image || 'assets/no-image.png';
    const cardImageSrc = promptShopNoImageMode ? 'assets/no-image.png' : fullImageSrc;

    card.innerHTML = `
        <button class="delete-card-btn" onclick="event.stopPropagation(); deletePromptCard('${p.id}')">×</button>
        <button class="edit-card-btn" onclick="event.stopPropagation(); openEditPromptDialog('${p.id}')">✎</button>
        <button class="delete-image-btn" onclick="event.stopPropagation(); deleteCardImageOnly('${p.id}')">🖼️×</button>
        <button class="export-card-btn" onclick="event.stopPropagation(); exportPromptCardPng('${p.id}')">PNG</button>
        <img src="${escapeHtml(cardImageSrc)}"
             data-full-src="${escapeHtml(fullImageSrc)}"
             class="card-image"
             draggable="false"
             onerror="this.src='assets/no-image.png'">

        <div class="card-body">
            <h3>${p.title}</h3>
            <div class="prompt-text">${p.prompt}</div>
        </div>
    `;

    const textFrame = card.querySelector(".card-body");

    textFrame.onmouseenter = () => {
        hidePromptShopTooltip();
        tooltip = document.createElement("div");
        tooltip.className = "custom-tooltip";
        tooltip.textContent = `${p.title || ""}\n\n${p.prompt || ""}`.trim();
        document.body.appendChild(tooltip);
        tooltip.style.display = "block";
    };

    textFrame.onmouseleave = () => {
        hidePromptShopTooltip();
    };

    card.onclick = () => copyPrompt(p.prompt, card);

    const img = card.querySelector(".card-image");
    img.ondragstart = (e) => {
        if (editMode) e.preventDefault();
    };

    return card;
}
function attachDragAndDrop() {
    const cards = document.querySelectorAll(".prompt-card");

    cards.forEach(card => {
        const id = card.dataset.id;

        card.draggable = editMode;

        card.ondragstart = (e) => {
            if (!editMode) {
                e.preventDefault();
                return;
            }

            hidePromptShopTooltip();
            clearPromptCardDropHighlights();
            promptShopDraggingCardId = id;

            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("application/x-prompt-card", id);
            e.dataTransfer.setData("text/plain", id);

            card.classList.add("dragging-card");
        };

        card.ondragend = () => {
            promptShopDraggingCardId = null;
            card.classList.remove("dragging-card");
            card.classList.remove("drag-over");
            clearPromptCardDropHighlights();
            hidePromptShopTooltip();
        };

        card.ondragover = (e) => {
            if (!editMode) return;
            if (!getPromptShopDraggedCardId(e.dataTransfer) && !(e.dataTransfer.files && e.dataTransfer.files.length > 0)) return;
            e.preventDefault();
            card.classList.add("drag-over");
        };

        card.ondragleave = () => {
            card.classList.remove("drag-over");
        };

        card.ondrop = (e) => {
            if (!editMode) return;

            e.preventDefault();
            e.stopPropagation();
            card.classList.remove("drag-over");
            hidePromptShopTooltip();

            const file = e.dataTransfer.files && e.dataTransfer.files[0];

            if (file && file.type && file.type.startsWith("image/")) {
                handleImageDrop(file, id);
                return;
            }

            const draggedId = getPromptShopDraggedCardId(e.dataTransfer) ||
                e.dataTransfer.getData("application/x-prompt-card") ||
                e.dataTransfer.getData("text/plain");

            if (!draggedId || draggedId === id) return;

            const targetCategory = getPromptShopDropCategory(card);
            movePromptBefore(draggedId, id, { category: targetCategory });
        };
    });

    attachPromptCardListCategoryDrop();
}
function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Actions
function normalizePromptList(value) {
    const text = String(value ?? "");
    const result = [];
    let current = "";
    const stack = [];
    const pairs = {
        "(": ")",
        "[": "]",
        "{": "}"
    };

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const prev = text[i - 1];

        // バックスラッシュでエスケープされた文字はそのまま扱う
        if (prev !== "\\" && (ch === "(" || ch === "[" || ch === "{")) {
            stack.push(pairs[ch]);
            current += ch;
            continue;
        }

        if (prev !== "\\" && stack.length > 0 && ch === stack[stack.length - 1]) {
            stack.pop();
            current += ch;
            continue;
        }

        // LoRAなど <...> は、前後にカンマがなくても単独タグとして切り出す。
        // 例: prompt<lora:name:1>prompt2 → prompt / <lora:name:1> / prompt2
        if (prev !== "\\" && stack.length === 0 && ch === "<") {
            const angleEnd = findPromptAngleBracketEnd(text, i);
            if (angleEnd !== -1) {
                pushPromptToken(result, current, false);
                pushPromptToken(result, text.slice(i, angleEnd + 1), false);
                current = "";
                i = angleEnd;
                continue;
            }
        }

        // 括弧の外側にあるカンマ/改行だけをタグ区切りとして扱う
        if ((ch === "," || ch === "\n" || ch === "\r") && stack.length === 0) {
            pushPromptToken(result, current, false);
            current = "";

            // Windows改行は1つの区切りとして扱う。
            if (ch === "\r" && text[i + 1] === "\n") i++;
            continue;
        }

        current += ch;
    }

    pushPromptToken(result, current, false);

    return result;
}

function normalizePromptListWithBreaks(value) {
    const text = String(value ?? "");
    const result = [];
    let current = "";
    const stack = [];
    const pairs = {
        "(": ")",
        "[": "]",
        "{": "}"
    };

    const pushCurrentTag = () => {
        pushPromptToken(result, current, true);
        current = "";
    };

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const prev = text[i - 1];

        if (prev !== "\\" && (ch === "(" || ch === "[" || ch === "{")) {
            stack.push(pairs[ch]);
            current += ch;
            continue;
        }

        if (prev !== "\\" && stack.length > 0 && ch === stack[stack.length - 1]) {
            stack.pop();
            current += ch;
            continue;
        }

        // LoRAなど <...> は、前後にカンマがなくても単独のタグチップとして切り出す。
        if (prev !== "\\" && stack.length === 0 && ch === "<") {
            const angleEnd = findPromptAngleBracketEnd(text, i);
            if (angleEnd !== -1) {
                pushCurrentTag();
                pushPromptToken(result, text.slice(i, angleEnd + 1), true);
                i = angleEnd;
                continue;
            }
        }

        if (ch === "," && stack.length === 0) {
            pushCurrentTag();
            continue;
        }

        if ((ch === "\n" || ch === "\r") && stack.length === 0) {
            pushCurrentTag();
            result.push(createPromptSorterParsedChip(PROMPT_SORTER_NEWLINE_TOKEN, PROMPT_SORTER_CHIP_TYPE_NEWLINE));

            // Windows改行は1つの改行チップとして扱う。
            if (ch === "\r" && text[i + 1] === "\n") i++;
            continue;
        }

        current += ch;
    }

    pushCurrentTag();

    return result;
}

function findTopLevelNumericSuffixColon(text) {
    const stack = [];
    const openByClose = {
        ")": "(",
        "]": "[",
        "}": "{"
    };

    for (let i = text.length - 1; i >= 0; i--) {
        const ch = text[i];
        const prev = text[i - 1];

        if (prev !== "\\" && (ch === ")" || ch === "]" || ch === "}")) {
            stack.push(openByClose[ch]);
            continue;
        }

        if (prev !== "\\" && stack.length > 0 && ch === stack[stack.length - 1]) {
            stack.pop();
            continue;
        }

        if (ch === ":" && stack.length === 0) {
            const tail = text.slice(i + 1).trim();
            if (/^[+-]?\d*\.?\d+$/.test(tail)) {
                return i;
            }
        }
    }

    return -1;
}

function parsePromptAngleBracketToken(token) {
    const text = String(token ?? "").trim();

    if (!(text.startsWith("<") && text.endsWith(">"))) {
        return null;
    }

    const inner = text.slice(1, -1).trim();
    if (!inner || inner.includes("\n") || inner.includes("\r")) {
        return null;
    }

    const weightColonIndex = findTopLevelNumericSuffixColon(inner);
    let content = inner;
    let weight = null;

    if (weightColonIndex !== -1) {
        content = inner.slice(0, weightColonIndex).trim();
        weight = inner.slice(weightColonIndex + 1).trim() || null;
    }

    return {
        content,
        weight,
        original: text
    };
}

function buildPromptAngleBracketToken(content, weight = null) {
    const cleanContent = String(content ?? "").trim();
    if (!cleanContent) return "";

    const cleanWeight = weight === null || weight === undefined
        ? ""
        : String(weight).trim();

    return cleanWeight
        ? `<${cleanContent}:${cleanWeight}>`
        : `<${cleanContent}>`;
}

function setPromptAngleBracketTokenWeight(token, weight) {
    const angle = parsePromptAngleBracketToken(token);
    if (!angle) return String(token ?? "").trim();

    return buildPromptAngleBracketToken(angle.content, formatPromptWeight(weight));
}

function parsePromptGroupToken(token) {
    const text = String(token ?? "").trim();

    if (!(text.startsWith("(") && text.endsWith(")"))) {
        return null;
    }

    const inner = text.slice(1, -1).trim();
    if (!inner) {
        return { items: [], weight: null, original: text };
    }

    const weightColonIndex = findTopLevelNumericSuffixColon(inner);
    let contentPart = inner;
    let weight = null;

    if (weightColonIndex !== -1) {
        contentPart = inner.slice(0, weightColonIndex).trim();
        weight = inner.slice(weightColonIndex + 1).trim() || null;
    }

    return {
        items: normalizePromptList(contentPart),
        weight,
        original: text
    };
}

function buildPromptGroupToken(items, weight = null) {
    const cleanItems = items.map(s => String(s ?? "").trim()).filter(Boolean);
    if (cleanItems.length === 0) return "";

    const inner = joinPromptTokens(cleanItems);
    return weight ? `(${inner}:${weight})` : `(${inner})`;
}

function getSemanticTagsFromToken(token) {
    const group = parsePromptGroupToken(token);
    if (group) {
        return group.items
            .flatMap(item => getSemanticTagsFromToken(item))
            .map(s => String(s ?? "").trim())
            .filter(Boolean);
    }

    const plain = String(token ?? "").trim();
    return plain ? [plain] : [];
}

function getSemanticPromptList(promptText) {
    const topLevelList = normalizePromptList(String(promptText ?? ""));
    return topLevelList.flatMap(getSemanticTagsFromToken);
}

function uniquePromptTags(tags) {
    return [...new Set(
        (tags || [])
            .map(s => String(s ?? "").trim())
            .filter(Boolean)
    )];
}

function getUniqueSemanticTagsFromToken(token) {
    return uniquePromptTags(getSemanticTagsFromToken(token));
}

function getUniqueSemanticTagsFromPromptText(promptText) {
    return uniquePromptTags(getSemanticPromptList(promptText));
}

function getUniqueSemanticTagsFromTokens(tokens) {
    return uniquePromptTags(
        (tokens || []).flatMap(token => getSemanticTagsFromToken(token))
    );
}

function promptContainsAllTags(promptText, tags) {
    const currentSet = new Set(getSemanticPromptList(promptText));
    const targetTags = getUniqueSemanticTagsFromTokens(tags);

    if (targetTags.length === 0) return false;

    return targetTags.every(tag => currentSet.has(tag));
}

function removeSemanticTagFromToken(token, targetTag) {
    const target = String(targetTag ?? "").trim();
    const trimmed = String(token ?? "").trim();

    if (!target || !trimmed) return trimmed;

    const group = parsePromptGroupToken(trimmed);
    if (!group) {
        return trimmed === target ? "" : trimmed;
    }

    let changed = false;
    const remaining = [];

    group.items.forEach(item => {
        const itemText = String(item ?? "").trim();
        if (!itemText) return;

        if (itemText === target) {
            changed = true;
            return;
        }

        const semanticTags = getSemanticTagsFromToken(itemText);
        if (semanticTags.includes(target)) {
            const rebuiltChild = removeSemanticTagFromToken(itemText, target);
            changed = true;
            if (rebuiltChild) remaining.push(rebuiltChild);
            return;
        }

        remaining.push(itemText);
    });

    if (!changed) return trimmed;

    return buildPromptGroupToken(remaining, group.weight);
}

function removeSemanticTagFromPromptText(promptText, targetTag) {
    const target = String(targetTag ?? "").trim();
    if (!target) return String(promptText ?? "");

    const topLevelList = normalizePromptList(String(promptText ?? ""));
    const nextTokens = [];

    topLevelList.forEach(token => {
        const rebuilt = removeSemanticTagFromToken(token, target);
        if (rebuilt) nextTokens.push(rebuilt);
    });

    return joinPromptTokens(nextTokens);
}
window.copyPrompt = (text, el) => {
    const textarea = getPromptTextarea();
    if (!textarea) return;

    const card = el?.classList?.contains('prompt-card')
        ? el
        : el?.closest('.prompt-card');

    const currentText = textarea.value;
    const addText = text.trim();

    if (!addText) return;

    const addList = normalizePromptList(addText);
    const addSemanticTags = getUniqueSemanticTagsFromTokens(addList);

    const exists = promptContainsAllTags(currentText, addList);

    if (exists) {
        let newText = currentText;

        // (prompt:1.1) のような強調タグカードは、見た目の文字列ではなく
        // 中身の semantic tag を基準に削除する。
        // これにより、連打時に (prompt:1.1), (prompt:1.1) と増えず、通常カード同様にトグルする。
        addSemanticTags.forEach(t => {
            newText = removeSemanticTagFromPromptText(newText, t);
        });

        textarea.value = newText;
        // 発光状態はsyncActiveStates側で一括更新
    } else {
        const currentSemanticSet = new Set(getSemanticPromptList(currentText));
        const missingTags = addList.filter(token => {
            const tokenSemanticTags = getUniqueSemanticTagsFromToken(token);
            if (tokenSemanticTags.length === 0) return false;
            return tokenSemanticTags.some(tag => !currentSemanticSet.has(tag));
        });
        const needsComma =
            currentText.trim() &&
            !currentText.trim().endsWith(",");

        textarea.value =
            currentText +
            (needsComma && missingTags.length > 0 ? getPromptDelimiter() : "") +
            joinPromptTokens(missingTags);
        
        // 発光状態はsyncActiveStates側で一括更新
    }

    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    syncActiveStates();
};
function syncActiveStates(promptValue = null) {
    const currentText = promptValue ?? getPromptTextareaValue();

    // textareaがまだ取れない初期表示時でも、親inject.jsから受け取った値があれば使う
    if (currentText === null || currentText === undefined) return;

    const currentList = getSemanticPromptList(String(currentText));
    const currentSet = new Set(currentList);

    document.querySelectorAll('.prompt-card').forEach(card => {
        const text = card.querySelector('.prompt-text')?.textContent?.trim();

        card.classList.remove(
            "active",
            "prompt-match-single",
            "prompt-match-partial"
        );

        if (!text) return;

        const uniqueCardList = getUniqueSemanticTagsFromPromptText(text);
        if (uniqueCardList.length === 0) return;

        const matchedCount = uniqueCardList.filter(t => currentSet.has(t)).length;
        if (matchedCount === 0) return;

        const isFullMatch = matchedCount === uniqueCardList.length;

        // 単独/複合を問わず、カード内の全タグが含まれていれば完全一致＝緑
        // 並び順は無視する。例: 「1,2,3」と「2,1,3」は完全一致扱い。
        if (isFullMatch) {
            card.classList.add("prompt-match-single");
            return;
        }

        // 複合プロンプトの一部だけ含まれている場合：水色
        if (uniqueCardList.length >= 2) {
            card.classList.add("prompt-match-partial");
        }
    });
}

function getPromptTextarea() {
    try {
        const app = window.parent?.gradioApp?.();
        if (!app) return null;

        return app.querySelector('#txt2img_prompt textarea') ||
               app.querySelector('#img2img_prompt textarea') ||
               app.querySelector('textarea[data-testid="textbox"]') ||
               null;
    } catch (err) {
        // iframe側から親に触れない環境では、inject.jsからのpostMessageを使う
        return null;
    }
}

function getPromptTextareaValue() {
    const textarea = getPromptTextarea();
    if (textarea) return textarea.value || "";
    return promptShopExternalPromptValue || "";
}

function setPromptTextareaValue(nextValue) {
    const value = String(nextValue ?? "");
    const textarea = getPromptTextarea();

    if (textarea) {
        textarea.value = value;
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        textarea.dispatchEvent(new Event("change", { bubbles: true }));
    }

    promptShopExternalPromptValue = value;
    scheduleActiveStateSync(true, value);
}

function createPromptSorterChipState(tag, removed = false, preservedId = null, type = null) {
    const kind = type || (String(tag ?? "") === PROMPT_SORTER_NEWLINE_TOKEN
        ? PROMPT_SORTER_CHIP_TYPE_NEWLINE
        : PROMPT_SORTER_CHIP_TYPE_TAG);

    return {
        id: preservedId || `chip-${Date.now()}-${promptSorterChipSerial++}`,
        tag: kind === PROMPT_SORTER_CHIP_TYPE_NEWLINE
            ? PROMPT_SORTER_NEWLINE_TOKEN
            : String(tag ?? "").trim(),
        removed: Boolean(removed),
        type: kind
    };
}

function syncPromptSorterStateFromPrompt(promptValue) {
    const activeChips = normalizePromptListWithBreaks(String(promptValue ?? ""));

    if (!promptSorterChipStateInitialized) {
        promptSorterChipState = activeChips.map(chip =>
            createPromptSorterChipState(chip.tag, false, null, chip.type)
        );
        promptSorterChipStateInitialized = true;
        return;
    }

    const hasRemovedChips = promptSorterChipState.some(chip => chip.removed);

    // 一時除去中のチップがない場合は、textareaの並びをそのまま正とする。
    if (!hasRemovedChips) {
        promptSorterChipState = activeChips.map((nextChip, index) => {
            const old = promptSorterChipState[index];
            // 同じ位置のチップIDをできるだけ維持する。
            // 強度表記を 1.0 → 1 のように手編集した直後でも、開いているツールが消えにくくなる。
            if (old && !old.removed && promptSorterChipMatchesDescriptor(old, nextChip)) {
                return { ...old, tag: nextChip.tag, type: nextChip.type, removed: false };
            }
            return createPromptSorterChipState(nextChip.tag, false, null, nextChip.type);
        });
        return;
    }

    // 一時除去チップがある場合は、そのチップだけ位置を保ちつつ、textarea側の現行タグを取り込む。
    const used = new Array(activeChips.length).fill(false);
    const nextState = [];

    promptSorterChipState.forEach(chip => {
        if (chip.removed) {
            nextState.push(chip);
            return;
        }

        const foundIndex = activeChips.findIndex((nextChip, index) =>
            !used[index] && promptSorterChipMatchesDescriptor(chip, nextChip)
        );

        if (foundIndex !== -1) {
            used[foundIndex] = true;
            nextState.push({
                ...chip,
                tag: activeChips[foundIndex].tag,
                type: activeChips[foundIndex].type,
                removed: false
            });
        }
    });

    activeChips.forEach((nextChip, index) => {
        if (!used[index]) {
            nextState.push(createPromptSorterChipState(nextChip.tag, false, null, nextChip.type));
        }
    });

    promptSorterChipState = nextState;
}

function getPromptSorterActiveChips() {
    return promptSorterChipState
        .filter(chip => !chip.removed)
        .map(chip => ({ ...chip }));
}

function getPromptSorterActiveTags() {
    return getPromptSorterActiveChips()
        .filter(chip => !isPromptSorterNewlineChip(chip))
        .map(chip => String(chip.tag ?? "").trim())
        .filter(Boolean);
}

function buildPromptTextFromPromptSorterChips(chips) {
    const lines = [[]];

    (chips || []).forEach(chip => {
        if (isPromptSorterNewlineChip(chip)) {
            lines.push([]);
            return;
        }

        const tag = String(chip?.tag ?? chip ?? "").trim();
        if (tag) lines[lines.length - 1].push(tag);
    });

    return lines.map(tokens => joinPromptTokens(tokens)).join("\n");
}

function trimPromptSorterSelection() {
    const validIds = new Set(promptSorterChipState.map(chip => chip.id));
    promptSorterSelectedChipIds = new Set(
        [...promptSorterSelectedChipIds].filter(id => validIds.has(id))
    );
}

function setPromptSorterSelection(ids, { keepOpen = false } = {}) {
    const validIds = new Set(promptSorterChipState.map(chip => chip.id));
    promptSorterSelectedChipIds = new Set(
        [...new Set(ids || [])].filter(id => validIds.has(id))
    );

    if (!keepOpen && promptSorterOpenToolChipId && !promptSorterSelectedChipIds.has(promptSorterOpenToolChipId)) {
        // 選択し直した時、開いているツールが選択外なら閉じる。
        promptSorterOpenToolChipId = null;
    }

    applyPromptSorterSelectionClass();
}

function clearPromptSorterSelection({ keepOpen = false } = {}) {
    promptSorterSelectedChipIds.clear();
    if (!keepOpen) promptSorterOpenToolChipId = null;
    applyPromptSorterSelectionClass();
}

function applyPromptSorterSelectionClass() {
    document.querySelectorAll(".prompt-sorter-chip").forEach(chip => {
        chip.classList.toggle(
            "prompt-sorter-chip-selected",
            promptSorterSelectedChipIds.has(chip.dataset.chipId)
        );
    });
}

function getPromptSorterSelectedIndexes() {
    return promptSorterChipState
        .map((chip, index) => promptSorterSelectedChipIds.has(chip.id) ? index : -1)
        .filter(index => index >= 0);
}

function getPromptSorterOperationIndexes(index) {
    const chip = promptSorterChipState[index];
    if (!chip) return [];

    const selectedIndexes = getPromptSorterSelectedIndexes();
    if (promptSorterSelectedChipIds.has(chip.id) && selectedIndexes.length >= 2) {
        return selectedIndexes;
    }

    return [index];
}

function commitPromptSorterStateToTextarea() {
    const nextText = buildPromptTextFromPromptSorterChips(getPromptSorterActiveChips());
    setPromptTextareaValue(nextText);
    updatePromptSorter(nextText);
}

function normalizeWeightValue(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return PROMPT_SORTER_DEFAULT_WEIGHT;

    // NegPIP向けに 0.0 と負数を許可する。
    // 上限だけは暴走防止のため従来通り 5.0 に丸める。
    const rounded = Math.round(n * 10) / 10;
    const safeRounded = Object.is(rounded, -0) ? 0 : rounded;
    return Math.min(5, safeRounded);
}

function formatPromptWeight(value) {
    const n = normalizeWeightValue(value);
    return n.toFixed(1);
}

function isDefaultPromptWeight(value) {
    return Math.abs(normalizeWeightValue(value) - PROMPT_SORTER_DEFAULT_WEIGHT) < 0.0001;
}

function wrapPromptTokenWithParentheses(innerText, layers) {
    let text = String(innerText ?? "").trim();
    for (let i = 0; i < layers; i++) {
        text = `(${text})`;
    }
    return text;
}

function unwrapPlainPromptParentheses(token) {
    let current = String(token ?? "").trim();
    let layers = 0;

    while (current) {
        const group = parsePromptGroupToken(current);
        if (!group || group.weight !== null || group.items.length !== 1) break;

        const next = String(group.items[0] ?? "").trim();
        if (!next || next === current) break;

        layers++;
        current = next;
    }

    return { layers, inner: current };
}

function getPromptTokenWeight(token) {
    const text = String(token ?? "").trim();
    if (!text) return PROMPT_SORTER_DEFAULT_WEIGHT;

    const unwrapped = unwrapPlainPromptParentheses(text);
    const angle = parsePromptAngleBracketToken(unwrapped.inner);
    if (angle && angle.weight !== null) {
        return normalizeWeightValue(angle.weight);
    }

    const group = parsePromptGroupToken(unwrapped.inner);
    if (group && group.weight !== null) {
        return normalizeWeightValue(group.weight);
    }

    return PROMPT_SORTER_DEFAULT_WEIGHT;
}

function setPromptTokenWeight(token, weight) {
    const text = String(token ?? "").trim();
    if (!text) return "";

    const nextWeight = formatPromptWeight(weight);
    const isDefaultWeight = isDefaultPromptWeight(weight);
    const unwrapped = unwrapPlainPromptParentheses(text);
    const unwrappedAngle = parsePromptAngleBracketToken(unwrapped.inner);

    // LoRAなど <...> 形式は、外側に()を付けず、末尾の数値だけを更新する。
    // 例: <lora:name:1> → <lora:name:1.1>
    if (unwrappedAngle) {
        return setPromptAngleBracketTokenWeight(unwrapped.inner, weight);
    }

    const group = parsePromptGroupToken(unwrapped.inner);

    if (group) {
        if (group.items.length === 0) return text;

        // 旧版でできた (<lora:name:1>:1.1) 形式も、次回操作時に <lora:name:1.2> 形式へ補正する。
        if (group.items.length === 1) {
            const angleItem = parsePromptAngleBracketToken(group.items[0]);
            if (angleItem) {
                return setPromptAngleBracketTokenWeight(group.items[0], weight);
            }
        }

        if (group.weight !== null) {
            // 1.0 は強調無しとして扱う。
            // (prompt:1.0) は prompt、((prompt:1.0)) は ((prompt)) のように、
            // 既存の括弧数が2個以上なら括弧だけ残す。
            if (isDefaultWeight) {
                if (group.items.length === 1) {
                    const nested = unwrapPlainPromptParentheses(group.items[0]);
                    const totalLayers = unwrapped.layers + nested.layers + 1;
                    const baseText = nested.inner;

                    return totalLayers <= 1
                        ? baseText
                        : wrapPromptTokenWithParentheses(baseText, totalLayers);
                }

                const plainGroup = buildPromptGroupToken(group.items, null);
                return unwrapped.layers > 0
                    ? wrapPromptTokenWithParentheses(plainGroup, unwrapped.layers)
                    : plainGroup;
            }

            // 旧挙動でできる (((prompt)):1.1) 型は、次回操作時に (((prompt:1.2))) 型へ補正する。
            if (group.items.length === 1) {
                const nested = unwrapPlainPromptParentheses(group.items[0]);
                const nestedGroup = parsePromptGroupToken(nested.inner);

                if (nested.layers > 0 && (!nestedGroup || nestedGroup.items.length <= 1)) {
                    const weightedInner = nestedGroup
                        ? buildPromptGroupToken(nestedGroup.items, nextWeight).slice(1, -1)
                        : `${nested.inner}:${nextWeight}`;
                    return wrapPromptTokenWithParentheses(weightedInner, unwrapped.layers + nested.layers + 1);
                }
            }
        }

        const weightedGroup = buildPromptGroupToken(group.items, nextWeight);
        return unwrapped.layers > 0
            ? wrapPromptTokenWithParentheses(weightedGroup, unwrapped.layers)
            : weightedGroup;
    }

    if (isDefaultWeight) {
        return unwrapped.layers <= 1
            ? unwrapped.inner
            : wrapPromptTokenWithParentheses(unwrapped.inner, unwrapped.layers);
    }

    const weightedText = `${unwrapped.inner}:${nextWeight}`;
    return wrapPromptTokenWithParentheses(weightedText, Math.max(1, unwrapped.layers));
}

function increasePromptTokenBrackets(token) {
    const text = String(token ?? "").trim();
    if (!text) return "";

    const unwrapped = unwrapPlainPromptParentheses(text);
    if (parsePromptAngleBracketToken(unwrapped.inner)) {
        return unwrapped.inner;
    }

    return `(${text})`;
}

function decreasePromptTokenBrackets(token) {
    const text = String(token ?? "").trim();
    if (!text) return "";

    const unwrapped = unwrapPlainPromptParentheses(text);
    if (parsePromptAngleBracketToken(unwrapped.inner)) {
        return unwrapped.inner;
    }

    const group = parsePromptGroupToken(text);
    if (!group) return text;

    // (tag:1.3) のような数値強調は、括弧を1段外すと通常タグへ戻す。
    if (group.weight !== null) {
        return group.items.join(", ");
    }

    return text.slice(1, -1).trim();
}

function replacePromptSorterChip(index, replacementText) {
    if (!Number.isInteger(index) || index < 0 || index >= promptSorterChipState.length) return;

    const sourceChip = promptSorterChipState[index];
    const replacementTokens = normalizePromptList(String(replacementText ?? ""));
    const nextChips = replacementTokens.map((tag, tokenIndex) =>
        createPromptSorterChipState(tag, sourceChip.removed, tokenIndex === 0 ? sourceChip.id : null)
    );

    promptSorterOpenToolChipId = nextChips[0]?.id || null;
    promptSorterChipState.splice(index, 1, ...nextChips);
    commitPromptSorterStateToTextarea();
}

function adjustPromptSorterChipWeight(index, direction) {
    const chip = promptSorterChipState[index];
    if (!chip) return;

    const currentWeight = getPromptTokenWeight(chip.tag);
    const nextWeight = currentWeight + (direction * PROMPT_SORTER_WEIGHT_STEP);
    replacePromptSorterChip(index, setPromptTokenWeight(chip.tag, nextWeight));
}

function adjustPromptSorterChipBrackets(index, direction) {
    const chip = promptSorterChipState[index];
    if (!chip) return;

    const nextTag = direction > 0
        ? increasePromptTokenBrackets(chip.tag)
        : decreasePromptTokenBrackets(chip.tag);

    replacePromptSorterChip(index, nextTag);
}

function togglePromptSorterChipTemporaryRemoval(index) {
    const chip = promptSorterChipState[index];
    if (!chip) return;

    promptSorterOpenToolChipId = chip.id;
    chip.removed = !chip.removed;
    commitPromptSorterStateToTextarea();
}

function deletePromptSorterChip(index) {
    if (!Number.isInteger(index) || index < 0 || index >= promptSorterChipState.length) return;

    const nextOpenChip = promptSorterChipState[index + 1] || promptSorterChipState[index - 1] || null;
    promptSorterOpenToolChipId = nextOpenChip?.id || null;
    promptSorterChipState.splice(index, 1);
    trimPromptSorterSelection();
    commitPromptSorterStateToTextarea();
}

function replacePromptSorterChipGroup(indexes, replacementText, options = {}) {
    const uniqueIndexes = [...new Set(indexes)]
        .filter(index => Number.isInteger(index) && index >= 0 && index < promptSorterChipState.length)
        .sort((a, b) => a - b);

    if (uniqueIndexes.length === 0) return;

    const firstIndex = uniqueIndexes[0];
    const sourceChip = promptSorterChipState[firstIndex];
    const selectedSet = new Set(uniqueIndexes);
    const insertIndex = promptSorterChipState
        .slice(0, firstIndex)
        .filter((_, index) => !selectedSet.has(index))
        .length;

    const replacementTokens = normalizePromptList(String(replacementText ?? ""));
    const removed = options.removed ?? uniqueIndexes.every(index => promptSorterChipState[index]?.removed);
    const nextChips = replacementTokens.map((tag, tokenIndex) =>
        createPromptSorterChipState(tag, removed, tokenIndex === 0 ? sourceChip.id : null)
    );

    const nextState = promptSorterChipState.filter((_, index) => !selectedSet.has(index));
    nextState.splice(insertIndex, 0, ...nextChips);

    promptSorterChipState = nextState;
    promptSorterOpenToolChipId = nextChips[0]?.id || null;
    setPromptSorterSelection(nextChips.map(chip => chip.id), { keepOpen: true });
    commitPromptSorterStateToTextarea();
}

function deletePromptSorterChipGroup(indexes) {
    const uniqueIndexes = [...new Set(indexes)]
        .filter(index => Number.isInteger(index) && index >= 0 && index < promptSorterChipState.length)
        .sort((a, b) => a - b);

    if (uniqueIndexes.length === 0) return;

    const selectedSet = new Set(uniqueIndexes);
    const nextOpenChip =
        promptSorterChipState[uniqueIndexes[uniqueIndexes.length - 1] + 1] ||
        promptSorterChipState[uniqueIndexes[0] - 1] ||
        null;

    promptSorterChipState = promptSorterChipState.filter((_, index) => !selectedSet.has(index));
    promptSorterOpenToolChipId = nextOpenChip?.id || null;
    clearPromptSorterSelection({ keepOpen: true });
    commitPromptSorterStateToTextarea();
}

function getPromptSorterGroupItems(indexes) {
    return indexes
        .map(index => promptSorterChipState[index])
        .filter(Boolean)
        .map(chip => String(chip.tag ?? "").trim())
        .filter(Boolean);
}

function adjustPromptSorterChipGroupWeight(indexes, direction) {
    const items = getPromptSorterGroupItems(indexes);
    if (items.length === 0) return;

    if (items.length === 1) {
        const index = indexes[0];
        adjustPromptSorterChipWeight(index, direction);
        setPromptSorterSelection([promptSorterOpenToolChipId].filter(Boolean), { keepOpen: true });
        return;
    }

    const groupToken = buildPromptGroupToken(items, null);
    const currentWeight = getPromptTokenWeight(groupToken);
    const nextWeight = currentWeight + (direction * PROMPT_SORTER_WEIGHT_STEP);
    replacePromptSorterChipGroup(indexes, setPromptTokenWeight(groupToken, nextWeight), { removed: false });
}

function adjustPromptSorterChipGroupBrackets(indexes, direction) {
    const items = getPromptSorterGroupItems(indexes);
    if (items.length === 0) return;

    if (items.length === 1) {
        const index = indexes[0];
        adjustPromptSorterChipBrackets(index, direction);
        setPromptSorterSelection([promptSorterOpenToolChipId].filter(Boolean), { keepOpen: true });
        return;
    }

    const groupToken = buildPromptGroupToken(items, null);
    const nextToken = direction > 0
        ? groupToken
        : decreasePromptTokenBrackets(groupToken);

    replacePromptSorterChipGroup(indexes, nextToken, { removed: false });
}

function togglePromptSorterChipGroupTemporaryRemoval(indexes) {
    const chips = indexes.map(index => promptSorterChipState[index]).filter(Boolean);
    if (chips.length === 0) return;

    // 1つでも有効チップがあれば一括で一時除去。全て除去済みなら一括復帰。
    const shouldRemove = chips.some(chip => !chip.removed);
    chips.forEach(chip => {
        chip.removed = shouldRemove;
    });

    promptSorterOpenToolChipId = chips[0]?.id || null;
    setPromptSorterSelection(chips.map(chip => chip.id), { keepOpen: true });
    commitPromptSorterStateToTextarea();
}

function insertPromptSorterNewlineBefore(index) {
    if (!Number.isInteger(index) || index < 0 || index > promptSorterChipState.length) return;

    const targetChip = promptSorterChipState[index] || null;
    const newlineChip = createPromptSorterChipState(
        PROMPT_SORTER_NEWLINE_TOKEN,
        false,
        null,
        PROMPT_SORTER_CHIP_TYPE_NEWLINE
    );

    promptSorterChipState.splice(index, 0, newlineChip);
    promptSorterOpenToolChipId = targetChip?.id || newlineChip.id;
    setPromptSorterSelection([newlineChip.id], { keepOpen: true });
    commitPromptSorterStateToTextarea();
}

function handlePromptSorterChipToolClick(index, action) {
    const chip = promptSorterChipState[index];
    const indexes = getPromptSorterOperationIndexes(index);
    const keepOpenChipId = chip && action !== "delete" ? chip.id : null;
    if (keepOpenChipId) {
        keepPromptSorterToolOpenBriefly(keepOpenChipId);
    }

    switch (action) {
        case "weight-minus":
            adjustPromptSorterChipGroupWeight(indexes, -1);
            break;
        case "weight-plus":
            adjustPromptSorterChipGroupWeight(indexes, 1);
            break;
        case "bracket-minus":
            adjustPromptSorterChipGroupBrackets(indexes, -1);
            break;
        case "bracket-plus":
            adjustPromptSorterChipGroupBrackets(indexes, 1);
            break;
        case "temporary-remove":
            togglePromptSorterChipGroupTemporaryRemoval(indexes);
            break;
        case "insert-newline-before":
            insertPromptSorterNewlineBefore(index);
            break;
        case "delete":
            deletePromptSorterChipGroup(indexes);
            break;
    }

    if (keepOpenChipId) {
        keepPromptSorterToolOpenBriefly(promptSorterOpenToolChipId || keepOpenChipId);
    }
}


function applyPromptSorterOpenToolClass() {
    document.querySelectorAll(".prompt-sorter-chip").forEach(chip => {
        const isOpen = promptSorterOpenToolChipId && chip.dataset.chipId === promptSorterOpenToolChipId;
        chip.classList.toggle("prompt-sorter-chip-tool-open", Boolean(isOpen));
    });
}

function getPromptSorterOpenChipElement() {
    if (!promptSorterOpenToolChipId) return null;
    return [...document.querySelectorAll(".prompt-sorter-chip")]
        .find(chip => chip.dataset.chipId === promptSorterOpenToolChipId) || null;
}

function isElementInsidePromptSorterOpenTool(target) {
    const chip = getPromptSorterOpenChipElement();
    return Boolean(chip && target && chip.contains(target));
}

function isPointerInsidePromptSorterOpenTool() {
    if (!promptSorterOpenToolChipId) return false;
    const target = document.elementFromPoint(promptSorterLastPointerX, promptSorterLastPointerY);
    return isElementInsidePromptSorterOpenTool(target);
}

function setPromptSorterOpenTool(chipId) {
    promptSorterOpenToolChipId = chipId || null;
    applyPromptSorterOpenToolClass();
}

function keepPromptSorterToolOpenBriefly(chipId) {
    if (chipId) promptSorterOpenToolChipId = chipId;
    promptSorterSuppressToolCloseUntil = Date.now() + 250;
    requestAnimationFrame(() => {
        applyPromptSorterOpenToolClass();
        if (Date.now() >= promptSorterSuppressToolCloseUntil && !isPointerInsidePromptSorterOpenTool()) {
            setPromptSorterOpenTool(null);
        }
    });
}

function getPromptSorterSelectionRect(a, b) {
    const left = Math.min(a.x, b.x);
    const top = Math.min(a.y, b.y);
    const right = Math.max(a.x, b.x);
    const bottom = Math.max(a.y, b.y);
    return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function rectsIntersect(a, b) {
    return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
}

function updatePromptSorterMarqueeSelection(currentPoint) {
    if (!promptSorterSelectionDrag) return;

    const rect = getPromptSorterSelectionRect(promptSorterSelectionDrag.start, currentPoint);
    const marquee = promptSorterSelectionDrag.marquee;

    marquee.style.left = `${rect.left}px`;
    marquee.style.top = `${rect.top}px`;
    marquee.style.width = `${rect.width}px`;
    marquee.style.height = `${rect.height}px`;

    const selectedIds = [];
    document.querySelectorAll(".prompt-sorter-chip").forEach(chip => {
        const chipRect = chip.getBoundingClientRect();
        if (rectsIntersect(rect, chipRect)) {
            selectedIds.push(chip.dataset.chipId);
        }
    });

    setPromptSorterSelection(selectedIds, { keepOpen: true });
}

function finishPromptSorterMarqueeSelection() {
    if (!promptSorterSelectionDrag) return;

    promptSorterSelectionDrag.marquee.remove();
    promptSorterSelectionDrag = null;

    document.removeEventListener("pointermove", onPromptSorterSelectionPointerMove, true);
    document.removeEventListener("pointerup", onPromptSorterSelectionPointerUp, true);
    document.removeEventListener("pointercancel", onPromptSorterSelectionPointerUp, true);

    // 選択数表示や一括ボタン表記を、ドラッグ選択完了時に更新する。
    updatePromptSorter(getPromptTextareaValue());
}

function onPromptSorterSelectionPointerMove(e) {
    if (!promptSorterSelectionDrag) return;

    e.preventDefault();
    updatePromptSorterMarqueeSelection({ x: e.clientX, y: e.clientY });
}

function onPromptSorterSelectionPointerUp(e) {
    if (promptSorterSelectionDrag) {
        updatePromptSorterMarqueeSelection({ x: e.clientX, y: e.clientY });
    }
    finishPromptSorterMarqueeSelection();
}

function onPromptSorterSelectionPointerDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    if (e.target.closest?.(".prompt-sorter-chip")) return;
    if (e.target.closest?.(".prompt-sorter-chip-tools")) return;

    const chipArea = document.getElementById("promptSorterChipArea");
    if (!chipArea || !chipArea.contains(e.target)) return;

    e.preventDefault();
    e.stopPropagation();

    clearPromptSorterSelection({ keepOpen: false });

    const marquee = document.createElement("div");
    marquee.className = "prompt-sorter-selection-rect";
    document.body.appendChild(marquee);

    promptSorterSelectionDrag = {
        start: { x: e.clientX, y: e.clientY },
        marquee
    };

    updatePromptSorterMarqueeSelection({ x: e.clientX, y: e.clientY });

    document.addEventListener("pointermove", onPromptSorterSelectionPointerMove, { capture: true, passive: false });
    document.addEventListener("pointerup", onPromptSorterSelectionPointerUp, true);
    document.addEventListener("pointercancel", onPromptSorterSelectionPointerUp, true);
}

function setupPromptSorterOutsideToolClose() {
    if (window.promptSorterOutsideToolCloseBound) return;
    window.promptSorterOutsideToolCloseBound = true;

    document.addEventListener("pointermove", (e) => {
        promptSorterLastPointerX = e.clientX;
        promptSorterLastPointerY = e.clientY;

        if (!promptSorterOpenToolChipId) return;
        if (Date.now() < promptSorterSuppressToolCloseUntil) return;
        if (isElementInsidePromptSorterOpenTool(e.target)) return;

        setPromptSorterOpenTool(null);
    }, true);

    document.addEventListener("pointerdown", (e) => {
        promptSorterLastPointerX = e.clientX;
        promptSorterLastPointerY = e.clientY;

        const inSorterChip = e.target.closest?.(".prompt-sorter-chip");
        if (inSorterChip) return;
        setPromptSorterOpenTool(null);
    }, true);
}

function renderPromptSorter() {
    const toolbarWrapper = document.getElementById("editToolbarWrapper");
    const appContainer = document.querySelector(".app-container");
    const mainContent = document.querySelector(".main-content");

    if (!toolbarWrapper && !mainContent) return;

    let wrapper = document.getElementById("promptSorterWrapper");

    if (!wrapper) {
        wrapper = document.createElement("div");
        wrapper.id = "promptSorterWrapper";
        wrapper.innerHTML = `
            <div id="promptSorterPanel" class="prompt-sorter-panel">
                <div id="promptSorterChipArea" class="prompt-sorter-chip-area"></div>
            </div>
        `;

        if (toolbarWrapper && appContainer && toolbarWrapper.parentNode === document.body) {
            document.body.insertBefore(wrapper, appContainer);
        } else if (mainContent) {
            mainContent.prepend(wrapper);
        }

        const chipArea = wrapper.querySelector("#promptSorterChipArea");
        chipArea.addEventListener("pointerdown", onPromptSorterSelectionPointerDown);
        chipArea.addEventListener("dragover", onPromptSorterAreaDragOver);
        chipArea.addEventListener("dragleave", onPromptSorterAreaDragLeave);
        chipArea.addEventListener("drop", onPromptSorterAreaDropToEnd);
        setupPromptSorterOutsideToolClose();
        setupPromptSorterDragGuards();
    }

    setupPromptSorterOutsideToolClose();
    setupPromptSorterDragGuards();
    updatePromptSorter(getPromptTextareaValue());
    setupPromptShopFixedChromeLayout();
}

function isPromptLoraTagToken(tagText) {
    const text = String(tagText ?? "").trim();
    if (!(text.startsWith("<") && text.endsWith(">"))) return false;

    const inner = text.slice(1, -1).trim();
    return /^lora(?::|$)/i.test(inner);
}

function findPromptSorterMeta(tagText) {
    if (isPromptSorterNewlineChip(tagText)) {
        return {
            type: "newline",
            top: "改行",
            bottom: "↵"
        };
    }

    const originalTag = String(tagText || "").trim();

    // LoRAタグはカード登録済みでも専用色を優先する。
    if (isPromptLoraTagToken(originalTag)) {
        return {
            type: "lora",
            top: "LoRA",
            bottom: originalTag
        };
    }

    const semanticTags = getUniqueSemanticTagsFromToken(originalTag);

    const singleCard = semanticTags
        .map(tag => allPrompts.find(p => {
            const list = getUniqueSemanticTagsFromPromptText(p.prompt || "");
            return list.length === 1 && list[0] === tag;
        }))
        .find(Boolean);

    if (singleCard) {
        return {
            type: "single",
            top: singleCard.title || semanticTags[0] || originalTag,
            bottom: originalTag || singleCard.prompt || semanticTags[0] || ""
        };
    }

    const compositeCard = allPrompts.find(p => {
        const list = getUniqueSemanticTagsFromPromptText(p.prompt || "");
        return list.length >= 2 && list.some(tag => semanticTags.includes(tag));
    });

    if (compositeCard) {
        return {
            type: "partial",
            top: originalTag,
            bottom: originalTag
        };
    }

    return {
        type: "plain",
        top: originalTag,
        bottom: originalTag
    };
}


function isPromptSorterDragActive() {
    return Boolean(promptSorterDragSession && promptSorterDragSession.active);
}

function createPromptSorterTransparentDragImage() {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    return canvas;
}

function createPromptSorterDragGhost(chipElement, selectedIds) {
    const ghost = chipElement.cloneNode(true);
    const toolBox = ghost.querySelector(".prompt-sorter-chip-tools");
    if (toolBox) toolBox.remove();

    ghost.classList.remove(
        "prompt-sorter-chip-tool-open",
        "prompt-sorter-chip-selected",
        "dragging",
        "dragging-group",
        "drag-over"
    );
    ghost.classList.add("prompt-sorter-drag-ghost");
    ghost.removeAttribute("id");
    ghost.draggable = false;
    ghost.setAttribute("aria-hidden", "true");

    if ((selectedIds || []).length >= 2) {
        const badge = document.createElement("div");
        badge.className = "prompt-sorter-drag-ghost-count";
        badge.textContent = `${selectedIds.length}件`;
        ghost.appendChild(badge);
    }

    document.body.appendChild(ghost);
    return ghost;
}

function updatePromptSorterDragGhostPosition(clientX, clientY) {
    if (!isPromptSorterDragActive()) return null;

    const session = promptSorterDragSession;
    const ghost = session.ghostElement;
    if (!ghost) return null;

    const left = clientX - (session.pointerOffsetX || 0);
    const top = clientY - (session.pointerOffsetY || 0);

    ghost.style.left = `${left}px`;
    ghost.style.top = `${top}px`;
    ghost.style.width = `${session.ghostWidth}px`;
    ghost.style.minHeight = `${session.ghostHeight}px`;

    const rect = ghost.getBoundingClientRect();
    session.ghostRect = rect;
    return rect;
}

function getPromptSorterInsertionIndexFromGhostRect(ghostRect) {
    const chipArea = document.getElementById("promptSorterChipArea");
    if (!chipArea || !ghostRect) return 0;

    const chips = [...chipArea.querySelectorAll(".prompt-sorter-chip")];
    if (chips.length === 0) return 0;

    const ghostCenterX = ghostRect.left + ghostRect.width / 2;
    const ghostCenterY = ghostRect.top + ghostRect.height / 2;

    const rects = chips.map(chip => {
        const rect = chip.getBoundingClientRect();
        const verticalOverlap = Math.max(
            0,
            Math.min(ghostRect.bottom, rect.bottom) - Math.max(ghostRect.top, rect.top)
        );

        return {
            index: Number(chip.dataset.index),
            rect,
            centerY: rect.top + rect.height / 2,
            centerX: rect.left + rect.width / 2,
            verticalOverlap
        };
    }).filter(item => Number.isFinite(item.index));

    if (rects.length === 0) return 0;

    const topMost = Math.min(...rects.map(item => item.rect.top));
    const bottomMost = Math.max(...rects.map(item => item.rect.bottom));

    if (ghostCenterY < topMost) return 0;
    if (ghostCenterY > bottomMost) return promptSorterChipState.length;

    // 掴んでいるチップの矩形が重なっている行を優先する。
    // 重なっていない時だけ、中心Yが近い行へ寄せる。
    const overlapping = rects.filter(item => item.verticalOverlap > 0);
    const rowAnchor = (overlapping.length > 0
        ? overlapping.reduce((best, item) => {
            if (!best) return item;
            if (item.verticalOverlap !== best.verticalOverlap) {
                return item.verticalOverlap > best.verticalOverlap ? item : best;
            }
            return Math.abs(ghostCenterY - item.centerY) < Math.abs(ghostCenterY - best.centerY)
                ? item
                : best;
        }, null)
        : rects.reduce((best, item) => {
            const dist = Math.abs(ghostCenterY - item.centerY);
            return !best || dist < best.dist ? { item, dist } : best;
        }, null)?.item);

    if (!rowAnchor) return promptSorterChipState.length;

    const rowTolerance = Math.max(10, rowAnchor.rect.height * 0.85);
    const rowItems = rects
        .filter(item => Math.abs(item.centerY - rowAnchor.centerY) <= rowTolerance)
        .sort((a, b) => a.rect.left - b.rect.left || a.index - b.index);

    if (rowItems.length === 0) return promptSorterChipState.length;

    // Sortable系UIに近く、掴んだチップの中心が相手チップ中心を越えた時に押し出す。
    // 横長チップに少し触れただけで遠い先頭スロットへ飛ぶ問題を避ける。
    for (const item of rowItems) {
        if (ghostCenterX < item.centerX) return item.index;
    }

    return Math.min(promptSorterChipState.length, rowItems[rowItems.length - 1].index + 1);
}

function getPromptSorterInsertionIndexFromChipEvent(e, chipElement) {
    // タグチップ上に触れている時は、必ずそのチップの「前」へ挿入する。
    // 左右半分で前後を切り替えると、表示位置と確定位置がズレて見えやすいため使わない。
    const fallbackIndex = Number(chipElement?.dataset?.index ?? 0);
    return Number.isFinite(fallbackIndex) ? fallbackIndex : 0;
}

function getPromptSorterInsertionIndexFromPoint(clientX, clientY) {
    const chipArea = document.getElementById("promptSorterChipArea");
    if (!chipArea) return 0;

    const elementAtPoint = document.elementFromPoint(clientX, clientY);
    const hoveredChip = elementAtPoint?.closest?.(".prompt-sorter-chip");

    // チップに触れている時は、触れているチップの前へ出す。
    // これで先頭への挿入も「1個目に触れるだけ」で可能になる。
    if (hoveredChip && chipArea.contains(hoveredChip)) {
        const index = Number(hoveredChip.dataset.index);
        return Number.isFinite(index) ? index : 0;
    }

    const chips = [...chipArea.querySelectorAll(".prompt-sorter-chip")];
    if (chips.length === 0) return 0;

    const rects = chips.map(chip => {
        const rect = chip.getBoundingClientRect();
        return {
            index: Number(chip.dataset.index),
            rect,
            centerY: rect.top + rect.height / 2,
            centerX: rect.left + rect.width / 2
        };
    }).filter(item => Number.isFinite(item.index));

    if (rects.length === 0) return 0;

    const topMost = Math.min(...rects.map(item => item.rect.top));
    const bottomMost = Math.max(...rects.map(item => item.rect.bottom));

    if (clientY < topMost) return 0;
    if (clientY > bottomMost) return promptSorterChipState.length;

    // 折り返し行があるため、まずY座標が近い行を決める。
    const nearestByY = rects.reduce((best, item) => {
        const dist = Math.abs(clientY - item.centerY);
        return !best || dist < best.dist ? { item, dist } : best;
    }, null)?.item;

    if (!nearestByY) return promptSorterChipState.length;

    const rowTolerance = Math.max(10, nearestByY.rect.height * 0.75);
    const rowItems = rects
        .filter(item => Math.abs(item.centerY - nearestByY.centerY) <= rowTolerance)
        .sort((a, b) => a.index - b.index);

    if (rowItems.length === 0) return promptSorterChipState.length;

    // チップとチップの隙間では、カーソルのX位置に近い挿入境界へ寄せる。
    for (const item of rowItems) {
        if (clientX < item.centerX) return item.index;
    }

    return Math.min(promptSorterChipState.length, rowItems[rowItems.length - 1].index + 1);
}

function getPromptSorterInitialInsertionIndex(originalState, dragIdSet, sourceIndex) {
    const safeSourceIndex = Math.max(0, Math.min(Number(sourceIndex) || 0, originalState.length));
    return originalState
        .slice(0, safeSourceIndex)
        .filter(chip => !dragIdSet.has(chip.id))
        .length;
}

function getPromptSorterCurrentChipRects() {
    const chipArea = document.getElementById("promptSorterChipArea");
    if (!chipArea) return new Map();

    const rects = new Map();
    chipArea.querySelectorAll(".prompt-sorter-chip").forEach(chip => {
        const chipId = chip.dataset.chipId;
        if (!chipId) return;
        rects.set(chipId, chip.getBoundingClientRect());
    });

    return rects;
}

function animatePromptSorterChipLayout(updateFn) {
    const beforeRects = getPromptSorterCurrentChipRects();

    updateFn();

    if (beforeRects.size === 0) return;

    const chipArea = document.getElementById("promptSorterChipArea");
    if (!chipArea) return;

    chipArea.querySelectorAll(".prompt-sorter-chip").forEach(chip => {
        const chipId = chip.dataset.chipId;
        const beforeRect = chipId ? beforeRects.get(chipId) : null;
        if (!beforeRect) return;

        const afterRect = chip.getBoundingClientRect();
        const dx = beforeRect.left - afterRect.left;
        const dy = beforeRect.top - afterRect.top;

        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;

        chip.classList.add("prompt-sorter-chip-layout-animating");

        if (typeof chip.animate === "function") {
            const animation = chip.animate([
                { transform: `translate(${dx}px, ${dy}px)` },
                { transform: "translate(0, 0)" }
            ], {
                duration: 135,
                easing: "cubic-bezier(0.2, 0, 0, 1)"
            });

            animation.onfinish = () => chip.classList.remove("prompt-sorter-chip-layout-animating");
            animation.oncancel = () => chip.classList.remove("prompt-sorter-chip-layout-animating");
            return;
        }

        chip.style.transition = "none";
        chip.style.transform = `translate(${dx}px, ${dy}px)`;
        requestAnimationFrame(() => {
            chip.style.transition = "transform 135ms cubic-bezier(0.2, 0, 0, 1)";
            chip.style.transform = "translate(0, 0)";
            window.setTimeout(() => {
                chip.style.transition = "";
                chip.style.transform = "";
                chip.classList.remove("prompt-sorter-chip-layout-animating");
            }, 160);
        });
    });
}

function appendPromptSorterInsertSlot(chipArea, index) {
    if (!isPromptSorterDragActive()) return;
    if (promptSorterDragSession.insertionIndex !== index) return;

    const slot = document.createElement("div");
    slot.className = "prompt-sorter-insert-slot";
    slot.setAttribute("aria-hidden", "true");

    const width = Math.max(54, Math.min(220, promptSorterDragSession.slotWidth || 92));
    const height = Math.max(20, Math.min(42, promptSorterDragSession.slotHeight || 24));
    slot.style.width = `${width}px`;
    slot.style.minHeight = `${height}px`;

    const count = promptSorterDragSession.dragIds?.length || 1;
    slot.innerHTML = `<span>${count >= 2 ? `${count}件を挿入` : "ここへ挿入"}</span>`;
    chipArea.appendChild(slot);
}

function beginPromptSorterChipDrag(e, index, chipState, chipElement) {
    const selectedIds = promptSorterSelectedChipIds.has(chipState.id) && promptSorterSelectedChipIds.size >= 2
        ? [...promptSorterSelectedChipIds]
        : [chipState.id];

    const dragIdSet = new Set(selectedIds);
    const originalState = promptSorterChipState.map(chip => ({ ...chip }));
    const moving = originalState.filter(chip => dragIdSet.has(chip.id));
    if (moving.length === 0) return false;

    promptSorterDragIndex = index;
    promptSorterDragSelectionIds = selectedIds;
    promptSorterOpenToolChipId = null;
    setPromptSorterSelection(selectedIds, { keepOpen: true });

    const rect = chipElement.getBoundingClientRect();
    promptSorterDragSession = {
        active: true,
        originalState,
        dragIds: selectedIds,
        moving,
        insertionIndex: null,
        slotWidth: selectedIds.length >= 2
            ? Math.min(220, Math.max(rect.width, selectedIds.length * 58))
            : rect.width,
        slotHeight: rect.height,
        committed: false
    };

    const chipArea = document.getElementById("promptSorterChipArea");
    chipArea?.classList.add("prompt-sorter-drag-active");
    document.body.classList.add("prompt-sorter-chip-dragging");

    chipElement.classList.add("dragging");
    document.querySelectorAll(".prompt-sorter-chip-selected").forEach(el => el.classList.add("dragging-group"));

    if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("application/x-prompt-sorter-chip", "1");
        e.dataTransfer.setData("text/plain", String(index));

        try {
            e.dataTransfer.setDragImage(createPromptSorterTransparentDragImage(), 0, 0);
        } catch (err) {
            // setDragImage非対応環境では通常のドラッグ画像にフォールバックする。
        }
    }

    requestAnimationFrame(() => {
        if (!isPromptSorterDragActive()) return;
        const currentDragIdSet = new Set(promptSorterDragSession.dragIds);
        promptSorterChipState = promptSorterDragSession.originalState.filter(chip => !currentDragIdSet.has(chip.id));
        updatePromptSorter(getPromptTextareaValue());
    });

    return true;
}

function previewPromptSorterDragInsertion(toIndex) {
    if (!isPromptSorterDragActive()) return;

    const safeIndex = Math.max(0, Math.min(Number(toIndex) || 0, promptSorterChipState.length));
    if (promptSorterDragSession.insertionIndex === safeIndex) return;

    promptSorterDragSession.insertionIndex = safeIndex;
    animatePromptSorterChipLayout(() => updatePromptSorter(getPromptTextareaValue()));
}

function finishPromptSorterChipDrag(commit = false) {
    if (!isPromptSorterDragActive()) return;

    const session = promptSorterDragSession;
    const chipArea = document.getElementById("promptSorterChipArea");

    session.ghostElement?.remove?.();

    promptSorterDragSession = null;
    promptSorterDragIndex = null;
    promptSorterDragSelectionIds = null;

    chipArea?.classList.remove("prompt-sorter-drag-active", "drag-over-root");
    clearPromptSorterCardDropPreview();
    document.body.classList.remove("prompt-sorter-chip-dragging");
    document.querySelectorAll(".prompt-sorter-chip.dragging, .prompt-sorter-chip.dragging-group, .prompt-sorter-chip.drag-over")
        .forEach(el => el.classList.remove("dragging", "dragging-group", "drag-over"));

    if (commit && session.insertionIndex !== null) {
        const dragIdSet = new Set(session.dragIds);
        const remaining = session.originalState.filter(chip => !dragIdSet.has(chip.id));
        const insertIndex = Math.max(0, Math.min(session.insertionIndex, remaining.length));
        remaining.splice(insertIndex, 0, ...session.moving);

        promptSorterChipState = remaining;
        setPromptSorterSelection(session.moving.map(chip => chip.id), { keepOpen: true });
        promptSorterOpenToolChipId = session.moving[0]?.id || null;
        commitPromptSorterStateToTextarea();
        return;
    }

    promptSorterChipState = session.originalState;
    setPromptSorterSelection(session.moving.map(chip => chip.id), { keepOpen: true });
    promptSorterOpenToolChipId = session.moving[0]?.id || null;
    updatePromptSorter(getPromptTextareaValue());
}

function setupPromptSorterDragGuards() {
    if (window.promptSorterDragGuardsBound) return;
    window.promptSorterDragGuardsBound = true;

    document.addEventListener("dragend", () => {
        finishPromptSorterChipDrag(false);
    }, true);

    document.addEventListener("drop", (e) => {
        if (!isPromptSorterDragActive()) return;
        const chipArea = document.getElementById("promptSorterChipArea");
        if (chipArea && chipArea.contains(e.target)) return;
        finishPromptSorterChipDrag(false);
    }, true);
}

function beginPromptSorterChipPointerDrag(index, chipState, chipElement, selectedIds, startPoint, currentPoint) {
    const dragIdSet = new Set(selectedIds);
    const originalState = promptSorterChipState.map(chip => ({ ...chip }));
    const moving = originalState.filter(chip => dragIdSet.has(chip.id));
    if (moving.length === 0) return false;

    promptSorterDragIndex = index;
    promptSorterDragSelectionIds = selectedIds;
    promptSorterOpenToolChipId = null;
    setPromptSorterSelection(selectedIds, { keepOpen: true });

    const rect = chipElement.getBoundingClientRect();
    const pointerOffsetX = Math.max(0, Math.min(rect.width, (startPoint?.x ?? rect.left) - rect.left));
    const pointerOffsetY = Math.max(0, Math.min(rect.height, (startPoint?.y ?? rect.top) - rect.top));
    const ghostElement = createPromptSorterDragGhost(chipElement, selectedIds);

    promptSorterDragSession = {
        active: true,
        originalState,
        dragIds: selectedIds,
        moving,
        insertionIndex: getPromptSorterInitialInsertionIndex(originalState, dragIdSet, index),
        slotWidth: selectedIds.length >= 2
            ? Math.min(220, Math.max(rect.width, selectedIds.length * 58))
            : rect.width,
        slotHeight: rect.height,
        pointerOffsetX,
        pointerOffsetY,
        ghostElement,
        ghostWidth: rect.width,
        ghostHeight: rect.height,
        ghostRect: null,
        committed: false
    };

    updatePromptSorterDragGhostPosition(currentPoint?.x ?? startPoint?.x ?? rect.left, currentPoint?.y ?? startPoint?.y ?? rect.top);

    promptSorterChipState = originalState.filter(chip => !dragIdSet.has(chip.id));

    const chipArea = document.getElementById("promptSorterChipArea");
    chipArea?.classList.add("prompt-sorter-drag-active");
    document.body.classList.add("prompt-sorter-chip-dragging");

    animatePromptSorterChipLayout(() => updatePromptSorter(getPromptTextareaValue()));
    return true;
}

function isPointInsidePromptSorterChipArea(clientX, clientY) {
    const chipArea = document.getElementById("promptSorterChipArea");
    if (!chipArea) return false;

    const areaRect = chipArea.getBoundingClientRect();
    return clientX >= areaRect.left &&
        clientX <= areaRect.right &&
        clientY >= areaRect.top &&
        clientY <= areaRect.bottom;
}

function onPromptSorterChipPointerDown(e, index, chipState, chipElement) {
    if (e.button !== undefined && e.button !== 0) return;
    if (e.target.closest?.(".prompt-sorter-chip-tools")) return;

    const startX = e.clientX;
    const startY = e.clientY;
    let started = false;

    const selectedIds = promptSorterSelectedChipIds.has(chipState.id) && promptSorterSelectedChipIds.size >= 2
        ? [...promptSorterSelectedChipIds]
        : [chipState.id];

    const cleanup = () => {
        document.removeEventListener("pointermove", onMove, true);
        document.removeEventListener("pointerup", onUp, true);
        document.removeEventListener("pointercancel", onCancel, true);
    };

    const startDragIfNeeded = (moveEvent) => {
        if (started) return true;

        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;
        if ((dx * dx) + (dy * dy) < 16) return false;

        started = beginPromptSorterChipPointerDrag(
            index,
            chipState,
            chipElement,
            selectedIds,
            { x: startX, y: startY },
            { x: moveEvent.clientX, y: moveEvent.clientY }
        );
        return started;
    };

    const onMove = (moveEvent) => {
        if (!startDragIfNeeded(moveEvent)) return;

        moveEvent.preventDefault();
        moveEvent.stopPropagation();

        const ghostRect = updatePromptSorterDragGhostPosition(moveEvent.clientX, moveEvent.clientY);
        updatePromptSorterCardDropPreview(moveEvent.clientX, moveEvent.clientY);
        previewPromptSorterDragInsertion(
            getPromptSorterInsertionIndexFromGhostRect(ghostRect)
        );
    };

    const onUp = (upEvent) => {
        cleanup();

        if (!started) return;

        upEvent.preventDefault();
        upEvent.stopPropagation();

        const insideArea = isPointInsidePromptSorterChipArea(upEvent.clientX, upEvent.clientY);
        const cardDropTarget = insideArea ? null : getPromptShopCardListDropTarget(upEvent.clientX, upEvent.clientY);

        if (insideArea) {
            const ghostRect = updatePromptSorterDragGhostPosition(upEvent.clientX, upEvent.clientY);
            previewPromptSorterDragInsertion(
                getPromptSorterInsertionIndexFromGhostRect(ghostRect)
            );
        }

        if (cardDropTarget) {
            const droppedChips = (promptSorterDragSession?.moving || [])
                .map(chip => ({ ...chip }));

            finishPromptSorterChipDrag(false);
            createPromptCardFromSorterDrop(droppedChips, cardDropTarget);
            return;
        }

        finishPromptSorterChipDrag(insideArea);
    };

    const onCancel = (cancelEvent) => {
        cleanup();
        if (!started) return;

        cancelEvent.preventDefault();
        cancelEvent.stopPropagation();
        finishPromptSorterChipDrag(false);
    };

    document.addEventListener("pointermove", onMove, { capture: true, passive: false });
    document.addEventListener("pointerup", onUp, true);
    document.addEventListener("pointercancel", onCancel, true);
}

function updatePromptSorter(promptValue = null) {
    const chipArea = document.getElementById("promptSorterChipArea");
    if (!chipArea) return;

    if (!isPromptSorterDragActive()) {
        syncPromptSorterStateFromPrompt(String(promptValue ?? getPromptTextareaValue() ?? ""));
        trimPromptSorterSelection();

        if (promptSorterOpenToolChipId && !promptSorterChipState.some(chip => chip.id === promptSorterOpenToolChipId)) {
            promptSorterOpenToolChipId = null;
        }
    }

    chipArea.innerHTML = "";

    if (promptSorterChipState.length === 0 && !isPromptSorterDragActive()) {
        chipArea.innerHTML = `
            <div class="prompt-sorter-empty">プロンプト欄のタグがここに表示されます。ドラッグ＆ドロップで並び順を変更できます。
            </div>
        `;
        schedulePromptShopFixedChromeLayout();
        return;
    }

    if (isPromptSorterDragActive() && promptSorterDragSession.insertionIndex === null) {
        chipArea.classList.add("prompt-sorter-drag-active");
    }

    promptSorterChipState.forEach((chipState, index) => {
        appendPromptSorterInsertSlot(chipArea, index);
        const tag = chipState.tag;
        const isNewlineChip = isPromptSorterNewlineChip(chipState);
        const meta = findPromptSorterMeta(isNewlineChip ? PROMPT_SORTER_NEWLINE_TOKEN : tag);
        const chip = document.createElement("div");
        chip.className = `prompt-sorter-chip prompt-sorter-chip-${meta.type}`;
        const isSelectedChip = promptSorterSelectedChipIds.has(chipState.id);
        const selectedIndexesForTool = getPromptSorterOperationIndexes(index);
        const selectedCountForTool = selectedIndexesForTool.length;
        const selectedChipsForTool = selectedIndexesForTool.map(i => promptSorterChipState[i]).filter(Boolean);
        const temporaryButtonLabel = selectedCountForTool >= 2
            ? (selectedChipsForTool.every(chip => chip.removed) ? "一括復帰" : "一括除去")
            : (chipState.removed ? "復帰" : "一時除去");
        const newlineToolHtml = isNewlineChip
            ? `
                <div class="prompt-sorter-tool-row prompt-sorter-tool-actions prompt-sorter-tool-actions-compact">
                    <button type="button" data-action="temporary-remove" title="一時除去 / 復帰">${temporaryButtonLabel}</button>
                    <button type="button" data-action="delete" title="完全削除">${selectedCountForTool >= 2 ? "一括削除" : "削除"}</button>
                </div>
            `
            : `
                ${selectedCountForTool >= 2 ? `<div class="prompt-sorter-tool-selection-note">選択 ${selectedCountForTool}件</div>` : ""}
                <div class="prompt-sorter-tool-row">
                    <button type="button" data-action="weight-minus" title="強調数を下げる">－</button>
                    <span>強調</span>
                    <button type="button" data-action="weight-plus" title="強調数を上げる">＋</button>
                </div>
                <div class="prompt-sorter-tool-row">
                    <button type="button" data-action="bracket-minus" title="括弧を減らす">－</button>
                    <span>括弧</span>
                    <button type="button" data-action="bracket-plus" title="括弧を増やす">＋</button>
                </div>
                <div class="prompt-sorter-tool-row prompt-sorter-tool-actions">
                    <button type="button" data-action="insert-newline-before" title="このタグの前に改行チップを入れる">改行</button>
                    <button type="button" data-action="temporary-remove" title="一時除去 / 復帰">${temporaryButtonLabel}</button>
                    <button type="button" data-action="delete" title="完全削除">${selectedCountForTool >= 2 ? "一括削除" : "削除"}</button>
                </div>
            `;

        if (chipState.removed) chip.classList.add("prompt-sorter-chip-muted");
        if (isSelectedChip) chip.classList.add("prompt-sorter-chip-selected");
        if (chipState.id === promptSorterOpenToolChipId) chip.classList.add("prompt-sorter-chip-tool-open");

        // タグチップの並び替えはブラウザ標準D&Dではなく、pointer操作で独自処理する。
        // 標準D&Dだとドラッグ元を非表示にした時に🚫カーソルが点滅しやすい。
        chip.draggable = false;
        chip.dataset.index = String(index);
        chip.dataset.chipId = chipState.id;
        chip.dataset.tag = isNewlineChip ? "__promptshop_newline__" : tag;
        chip.dataset.type = isNewlineChip ? PROMPT_SORTER_CHIP_TYPE_NEWLINE : PROMPT_SORTER_CHIP_TYPE_TAG;
        chip.dataset.removed = chipState.removed ? "true" : "false";
        if (isNewlineChip) chip.setAttribute("aria-label", "改行チップ");

        chip.innerHTML = `
            <div class="prompt-sorter-chip-texts">
                <div class="prompt-sorter-chip-top">${escapeHtml(meta.top)}</div>
                <div class="prompt-sorter-chip-bottom">${escapeHtml(meta.bottom)}</div>
            </div>
            <div class="prompt-sorter-chip-tools" aria-label="タグ操作ツール">
                ${newlineToolHtml}
            </div>
        `;

        const toolBox = chip.querySelector(".prompt-sorter-chip-tools");

        const openChipTool = () => {
            if (isPromptSorterDragActive()) return;
            setPromptSorterOpenTool(chipState.id);
        };

        // ツールはhoverで開き、別チップへ移るか外側をクリックするまで維持する。
        // これにより、ボタン連打時の再描画・mouseleaveタイマー競合による消失を避ける。
        chip.addEventListener("pointerenter", openChipTool);
        toolBox.addEventListener("pointerenter", openChipTool);

        toolBox.addEventListener("pointerdown", (e) => {
            promptSorterSuppressToolCloseUntil = Date.now() + 250;
            openChipTool();
            e.stopPropagation();
        });
        toolBox.addEventListener("mousedown", (e) => {
            e.stopPropagation();
        });
        toolBox.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();

            const button = e.target.closest("button[data-action]");
            if (!button) return;

            promptSorterSuppressToolCloseUntil = Date.now() + 250;
            setPromptSorterOpenTool(chipState.id);
            handlePromptSorterChipToolClick(index, button.dataset.action);
        });

        // ツール内のボタン連打/ダブルクリックが、チップ本体のdblclick扱いにならないように止める。
        ["dblclick", "mouseup"].forEach(eventName => {
            toolBox.addEventListener(eventName, (e) => {
                e.preventDefault();
                e.stopPropagation();
            });
        });

        chip.addEventListener("dblclick", (e) => {
            const isChipText = e.target.closest?.(".prompt-sorter-chip-texts");
            const isTool = e.target.closest?.(".prompt-sorter-chip-tools");

            if (!isChipText || isTool) {
                return;
            }

            e.preventDefault();
            e.stopPropagation();
            togglePromptSorterChipTemporaryRemoval(index);
        });

        chip.addEventListener("pointerdown", (e) => {
            onPromptSorterChipPointerDown(e, index, chipState, chip);
        });

        chipArea.appendChild(chip);
    });

    appendPromptSorterInsertSlot(chipArea, promptSorterChipState.length);

    schedulePromptShopFixedChromeLayout();
}

function onPromptSorterAreaDragOver(e) {
    e.preventDefault();
    const chipArea = document.getElementById("promptSorterChipArea");
    if (!chipArea) return;

    if (isPromptSorterDragActive()) {
        e.dataTransfer.dropEffect = "move";
        chipArea.classList.add("prompt-sorter-drag-active");

        const hoveredChip = e.target.closest?.('.prompt-sorter-chip');
        if (hoveredChip) {
            previewPromptSorterDragInsertion(getPromptSorterInsertionIndexFromChipEvent(e, hoveredChip));
        } else {
            previewPromptSorterDragInsertion(promptSorterChipState.length);
        }
        return;
    }

    const hoveredChip = e.target.closest?.('.prompt-sorter-chip');
    chipArea.classList.toggle("drag-over-root", !hoveredChip);
}

function onPromptSorterAreaDragLeave(e) {
    const chipArea = document.getElementById("promptSorterChipArea");
    if (!chipArea) return;

    if (!chipArea.contains(e.relatedTarget)) {
        chipArea.classList.remove("drag-over-root");
    }
}

function onPromptSorterAreaDropToEnd(e) {
    const chipArea = document.getElementById("promptSorterChipArea");
    if (!chipArea) return;

    chipArea.classList.remove("drag-over-root");

    if (isPromptSorterDragActive()) {
        e.preventDefault();
        e.stopPropagation();

        const hoveredChip = e.target.closest?.('.prompt-sorter-chip');
        if (hoveredChip) {
            previewPromptSorterDragInsertion(getPromptSorterInsertionIndexFromChipEvent(e, hoveredChip));
        } else {
            previewPromptSorterDragInsertion(promptSorterChipState.length);
        }
        finishPromptSorterChipDrag(true);
        return;
    }

    const hoveredChip = e.target.closest?.('.prompt-sorter-chip');
    if (hoveredChip) return;

    e.preventDefault();
    reorderPromptSorterDragSelectionToIndex(promptSorterChipState.length - 1, { toEnd: true });
}

function reorderPromptSorterDragSelectionToIndex(toIndex, options = {}) {
    if (isPromptSorterDragActive()) {
        previewPromptSorterDragInsertion(options.toEnd ? promptSorterChipState.length : toIndex);
        finishPromptSorterChipDrag(true);
        return;
    }

    const dragIds = promptSorterDragSelectionIds && promptSorterDragSelectionIds.length > 0
        ? promptSorterDragSelectionIds
        : (promptSorterDragIndex !== null && promptSorterChipState[promptSorterDragIndex]
            ? [promptSorterChipState[promptSorterDragIndex].id]
            : []);

    const dragIdSet = new Set(dragIds);
    const moving = promptSorterChipState.filter(chip => dragIdSet.has(chip.id));
    if (moving.length === 0) return;

    const targetChip = promptSorterChipState[toIndex];
    if (!options.toEnd && targetChip && dragIdSet.has(targetChip.id)) return;

    const remaining = promptSorterChipState.filter(chip => !dragIdSet.has(chip.id));
    let insertIndex = remaining.length;

    if (!options.toEnd && targetChip) {
        const found = remaining.findIndex(chip => chip.id === targetChip.id);
        if (found !== -1) insertIndex = found;
    }

    remaining.splice(insertIndex, 0, ...moving);
    promptSorterChipState = remaining;
    setPromptSorterSelection(moving.map(chip => chip.id), { keepOpen: true });
    promptSorterOpenToolChipId = moving[0]?.id || null;

    commitPromptSorterStateToTextarea();
}

function reorderPromptSorterTags(fromIndex, toIndex) {
    if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex)) return;
    if (fromIndex < 0 || toIndex < 0) return;
    if (fromIndex >= promptSorterChipState.length || toIndex >= promptSorterChipState.length) return;
    if (fromIndex === toIndex) return;

    promptSorterDragSelectionIds = [promptSorterChipState[fromIndex].id];
    reorderPromptSorterDragSelectionToIndex(toIndex);
}

function escapeHtml(text) {
    return String(text ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function scheduleActiveStateSync(force = false, valueOverride = null) {
    if (promptSyncRaf) return;

    promptSyncRaf = requestAnimationFrame(() => {
        promptSyncRaf = null;

        const value = valueOverride ?? getPromptTextareaValue();
        if (!force && value === lastPromptTextareaValue) return;

        lastPromptTextareaValue = value;
        syncActiveStates(value);
        updatePromptSorter(value);
    });
}

function bindPromptTextareaWatcher(textarea) {
    if (!textarea) return false;

    observedPromptTextarea = textarea;
    lastPromptTextareaValue = textarea.value || "";

    if (!watchedPromptTextareas.has(textarea)) {
        watchedPromptTextareas.add(textarea);

        ["input", "change", "keyup", "paste", "drop", "compositionend"].forEach(eventName => {
            textarea.addEventListener(eventName, () => scheduleActiveStateSync(true));
        });
    }

    scheduleActiveStateSync(true);
    return true;
}

function setupPromptTextareaWatcher() {
    if (promptTextareaWatcherStarted) return;
    promptTextareaWatcherStarted = true;

    bindPromptTextareaWatcher(getPromptTextarea());

    // Gradio側でtextareaが差し替わる場合と、イベントを伴わない値変更への保険。
    promptTextareaWatchTimer = setInterval(() => {
        const textarea = getPromptTextarea();

        if (textarea && textarea !== observedPromptTextarea) {
            bindPromptTextareaWatcher(textarea);
            return;
        }

        const value = textarea ? (textarea.value || "") : (promptShopExternalPromptValue || "");
        if (value !== lastPromptTextareaValue) {
            lastPromptTextareaValue = value;
            syncActiveStates(value);
            updatePromptSorter(value);
        }
    }, 200);
}

window.addEventListener("message", (event) => {
    if (event.data?.type !== "promptShopPromptChanged") return;

    promptShopExternalPromptValue = event.data.text || "";
    scheduleActiveStateSync(true, promptShopExternalPromptValue);
});
function loadSavedPrompts() {
    return;
}

function savePrompts() {
    localStorage.setItem("promptShopPrompts", JSON.stringify(allPrompts));
}

function applyCardSize() {
    document.documentElement.style.setProperty("--card-min-width", `${cardMinWidth}px`);
    localStorage.setItem("promptShopCardSize", String(cardMinWidth));
}

function renderToolbar() {
    const mainContent = document.querySelector(".main-content");
    if (!mainContent || document.getElementById("editToolbarWrapper")) return;

    const wrapper = document.createElement("div");
    wrapper.id = "editToolbarWrapper";

    wrapper.innerHTML = `
        <div id="editToolbar" class="edit-toolbar sticky-toolbar">
            <div class="toolbar-left-controls">
                <button id="normalizeCommaSpacingBtn" type="button" title="現在のプロンプト欄だけ、カンマの後ろを半角スペースありに整えます">,後スペース整形</button>
                <button id="replaceSingleUnderscoreBtn" type="button" title="__ のような連続アンダーバーはそのまま残します">単独の_をスペースに置換</button>
                <label class="toolbar-switch-control" title="カード画像を隠して、タイトル1行＋プロンプト1行の軽量表示にします">
                    <input id="noImageModeToggle" type="checkbox" ${promptShopNoImageMode ? "checked" : ""}>
                    <span class="toolbar-switch-track" aria-hidden="true"></span>
                    <span>画像なしモード</span>
                </label>
            </div>

            <div class="toolbar-right-controls">
                <button id="categoryManagerBtn">カテゴリ管理</button>
                <button id="toggleEditMode">編集モード ON</button>
                <button id="addCardBtn">＋カード追加</button>
                <button id="importPngBtn">＋カードインポート</button>
                <button id="addCurrentImageBtn">生成画像をカード化</button>
                <button id="exportBtn">JSON書き出し</button>

                <label class="card-size-control">
                    サイズ
                    <input id="cardSizeSlider" type="range" min="120" max="320" value="${cardMinWidth}">
                </label>

                <div class="toolbar-search-wrapper">
                    <input class="toolbar-search-input" type="text" placeholder="プロンプトを検索...">
                </div>
            </div>
        </div>
    `;

    const appContainer = document.querySelector(".app-container");

    if (appContainer) {
        document.body.insertBefore(wrapper, appContainer);
    } else {
        mainContent.prepend(wrapper);
    }

    setupPromptShopFixedChromeLayout();

    const normalizeCommaSpacingBtn = document.getElementById("normalizeCommaSpacingBtn");
    if (normalizeCommaSpacingBtn) {
        normalizeCommaSpacingBtn.onclick = () => {
            const changed = applyPromptCommaSpacingIfNeeded({ force: true });
            if (!changed && typeof showToast === "function") {
                showToast("整形するカンマはありません");
            }
        };
    }

    document.getElementById("replaceSingleUnderscoreBtn").onclick = replaceCurrentPromptSingleUnderscores;

    const noImageModeToggle = document.getElementById("noImageModeToggle");
    if (noImageModeToggle) {
        noImageModeToggle.checked = promptShopNoImageMode;
        noImageModeToggle.onchange = (e) => {
            promptShopNoImageMode = Boolean(e.target.checked);
            applyPromptShopNoImageMode(true);
            renderPrompts(getCurrentCategory(), getCurrentSearchValue());
        };
    }

    document.getElementById("exportBtn").onclick = exportPromptsJSON;
    document.getElementById("categoryManagerBtn").onclick = openCategoryManager;
    document.getElementById("addCurrentImageBtn").onclick = addCurrentImageCard;
    document.getElementById("importPngBtn").onclick = importPromptCardsFromPng;
    document.getElementById("toggleEditMode").onclick = () => {
        editMode = !editMode;
        document.body.classList.toggle("edit-mode", editMode);
        document.getElementById("toggleEditMode").textContent = editMode ? "編集中：クリックで終了" : "編集モード ON";
        renderPrompts(getCurrentCategory(), getCurrentSearchValue());
        schedulePromptShopFixedChromeLayout();
    };

    document.getElementById("addCardBtn").onclick = addCardDialog;

    document.getElementById("cardSizeSlider").oninput = (e) => {
        cardMinWidth = Number(e.target.value);
        applyCardSize();
    };

    const toolbarSearch = document.querySelector(".toolbar-search-input");
    toolbarSearch.addEventListener("input", (e) => {
        const activeItem = document.querySelector(".nav-item.active, .nav-sub-item.active");
        const category = activeItem ? activeItem.getAttribute("data-category") : "all";
        renderPrompts(category, e.target.value);
    });
}


function getPromptShopDraggedCardId(dataTransfer) {
    if (!dataTransfer) return promptShopDraggingCardId || "";

    const types = Array.from(dataTransfer.types || []);
    const hasPromptCardType = types.includes("application/x-prompt-card");
    if (!hasPromptCardType && !promptShopDraggingCardId) return "";

    return dataTransfer.getData("application/x-prompt-card") || promptShopDraggingCardId || "";
}

function normalizePromptShopCategoryDropValue(categoryId) {
    const id = String(categoryId ?? "").trim();
    if (id === "uncategorized") return "";
    if (isValidPromptShopCategoryId(id)) return id;
    return null;
}

function getPromptShopDropCategoryFromElement(element) {
    if (!element) return null;

    const targetCard = element.closest?.(".prompt-card");
    if (targetCard?.dataset?.id) {
        const targetItem = allPrompts.find(p => String(p.id) === String(targetCard.dataset.id));
        if (!targetItem) return null;
        return isValidPromptShopCategoryId(targetItem.category) ? targetItem.category : "";
    }

    const categoryTarget = element.closest?.("[data-drop-category], .nav-item[data-category], .nav-sub-item[data-category]");
    if (!categoryTarget) return null;

    const rawCategory = categoryTarget.dataset?.dropCategory ?? categoryTarget.getAttribute?.("data-category") ?? "";
    if (rawCategory === "all") return null;

    return normalizePromptShopCategoryDropValue(rawCategory);
}

function clearPromptCardDropHighlights() {
    document.querySelectorAll(
        ".prompt-card-category-drop-over, .prompt-card-category-drop-target, .prompt-card.drag-over"
    ).forEach(el => {
        el.classList.remove(
            "prompt-card-category-drop-over",
            "prompt-card-category-drop-target",
            "drag-over"
        );
    });
}

function setActivePromptShopCategory(category = "all") {
    const navItems = [...document.querySelectorAll('.nav-item, .nav-sub-item')];
    const preferred = String(category || "all");
    let target = navItems.find(item => item.getAttribute('data-category') === preferred);

    if (!target) {
        target = navItems.find(item => item.getAttribute('data-category') === 'all') || null;
    }

    navItems.forEach(item => item.classList.remove('active'));
    target?.classList.add('active');

    return target?.getAttribute('data-category') || 'all';
}

function rerenderPromptShopAfterCardMove(preferredCategory = getCurrentCategory(), preferredSearch = getCurrentSearchValue()) {
    hidePromptShopTooltip();
    clearPromptCardDropHighlights();
    renderSidebar();
    const resolvedCategory = setActivePromptShopCategory(preferredCategory);
    renderPrompts(resolvedCategory, preferredSearch);
}

function movePromptCardToCategory(draggedId, targetCategory, options = {}) {
    const normalizedCategory = targetCategory === null || targetCategory === undefined
        ? null
        : String(targetCategory);

    if (normalizedCategory === null) return false;

    const fromIndex = allPrompts.findIndex(p => String(p.id) === String(draggedId));
    if (fromIndex === -1) return false;

    const [moved] = allPrompts.splice(fromIndex, 1);
    moved.category = normalizedCategory;

    if (options.appendToCategory) {
        let insertIndex = -1;
        allPrompts.forEach((prompt, index) => {
            const promptCategory = isValidPromptShopCategoryId(prompt.category) ? prompt.category : "";
            if (promptCategory === normalizedCategory) insertIndex = index;
        });
        allPrompts.splice(insertIndex + 1, 0, moved);
    } else {
        allPrompts.splice(fromIndex, 0, moved);
    }

    promptShopDraggingCardId = null;
    savePrompts();
    autoSaveDebounced();
    rerenderPromptShopAfterCardMove(options.keepCategory ?? getCurrentCategory(), options.search ?? getCurrentSearchValue());
    return true;
}

function attachPromptCardCategoryBarDrop() {
    const navItems = document.querySelectorAll('.nav-item[data-category], .nav-sub-item[data-category]');

    navItems.forEach(item => {
        item.ondragover = (e) => {
            if (!editMode) return;
            const draggedId = getPromptShopDraggedCardId(e.dataTransfer);
            const category = getPromptShopDropCategoryFromElement(item);
            if (!draggedId || category === null) return;

            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            item.classList.add("prompt-card-category-drop-over");
        };

        item.ondragleave = () => {
            item.classList.remove("prompt-card-category-drop-over");
        };

        item.ondrop = (e) => {
            if (!editMode) return;
            const draggedId = getPromptShopDraggedCardId(e.dataTransfer);
            const category = getPromptShopDropCategoryFromElement(item);
            if (!draggedId || category === null) return;

            e.preventDefault();
            e.stopPropagation();
            hidePromptShopTooltip();
            item.classList.remove("prompt-card-category-drop-over");
            movePromptCardToCategory(draggedId, category, {
                appendToCategory: true,
                keepCategory: getCurrentCategory(),
                search: getCurrentSearchValue()
            });
        };
    });
}

function attachPromptCardListCategoryDrop() {
    const dropZones = document.querySelectorAll(
        '.prompt-grid[data-drop-category], #promptGrid[data-drop-category], .category-section[data-drop-category], .category-header[data-drop-category], .sub-category-header[data-drop-category]'
    );

    dropZones.forEach(zone => {
        zone.ondragover = (e) => {
            if (!editMode) return;
            const draggedId = getPromptShopDraggedCardId(e.dataTransfer);
            const category = getPromptShopDropCategoryFromElement(zone);
            if (!draggedId || category === null) return;

            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            zone.classList.add("prompt-card-category-drop-over");
        };

        zone.ondragleave = (e) => {
            if (zone.contains(e.relatedTarget)) return;
            zone.classList.remove("prompt-card-category-drop-over");
        };

        zone.ondrop = (e) => {
            if (!editMode) return;

            const draggedId = getPromptShopDraggedCardId(e.dataTransfer);
            const category = getPromptShopDropCategoryFromElement(zone);
            if (!draggedId || category === null) return;

            e.preventDefault();
            e.stopPropagation();
            hidePromptShopTooltip();
            zone.classList.remove("prompt-card-category-drop-over");

            movePromptCardToCategory(draggedId, category, {
                appendToCategory: true,
                keepCategory: getCurrentCategory(),
                search: getCurrentSearchValue()
            });
        };
    });
}

function getCurrentSearchValue() {
    return document.querySelector(".toolbar-search-input")?.value || "";
}

function getCurrentCategory() {
    const activeItem = document.querySelector(".nav-item.active, .nav-sub-item.active");
    return activeItem ? activeItem.getAttribute("data-category") : "all";
}

function isValidPromptShopCategoryId(categoryId) {
    const id = String(categoryId ?? "").trim();
    if (!id || id === "all" || id === "uncategorized") return false;
    return getAllCategoryIds().includes(id);
}

function getPromptShopDropCategory(dropTarget = null) {
    const categoryFromElement = getPromptShopDropCategoryFromElement(dropTarget);
    if (categoryFromElement !== null) return categoryFromElement;

    const currentCategory = getCurrentCategory();
    if (isValidPromptShopCategoryId(currentCategory)) return currentCategory;

    // 「すべて表示」などカテゴリを特定できない場所へのドロップは未分類カードとして作成する。
    return "";
}

function getPromptShopCardListDropTarget(clientX, clientY) {
    const target = document.elementFromPoint(clientX, clientY);
    if (!target) return null;

    if (target.closest?.("#promptSorterWrapper, #editToolbarWrapper, .sidebar, .promptshop-modal")) {
        return null;
    }

    return target.closest?.(".prompt-card, .prompt-grid, .category-header, .sub-category-header, .category-section, .gallery-container, #promptGrid") || null;
}

function clearPromptSorterCardDropPreview() {
    document.querySelectorAll(".prompt-sorter-card-drop-target").forEach(el => {
        el.classList.remove("prompt-sorter-card-drop-target");
    });
}

function updatePromptSorterCardDropPreview(clientX, clientY) {
    clearPromptSorterCardDropPreview();
    const target = getPromptShopCardListDropTarget(clientX, clientY);
    if (!target) return null;

    const previewTarget = target.closest?.(".prompt-card") || target.closest?.(".prompt-grid") || target;
    previewTarget.classList.add("prompt-sorter-card-drop-target");
    return target;
}

function createPromptCardFromSorterDrop(tagsOrChips, dropTarget = null) {
    const items = tagsOrChips || [];
    const hasChipObjects = items.some(item => item && typeof item === "object" && "tag" in item);
    const promptText = hasChipObjects
        ? buildPromptTextFromPromptSorterChips(items)
        : joinPromptTokens(
            items
                .map(tag => String(tag ?? "").trim())
                .filter(Boolean)
        );

    if (!String(promptText || "").trim()) return false;

    const cardTitle = String(promptText || "")
        .replace(/[\r\n]+/g, " / ")
        .replace(/\s+/g, " ")
        .trim();

    const newPrompt = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        title: cardTitle,
        prompt: promptText,
        image: "assets/no-image.png",
        category: getPromptShopDropCategory(dropTarget)
    };

    const targetCard = dropTarget?.closest?.(".prompt-card");
    const targetId = targetCard?.dataset?.id;
    const insertIndex = targetId
        ? allPrompts.findIndex(p => String(p.id) === String(targetId))
        : -1;

    if (insertIndex >= 0) {
        allPrompts.splice(insertIndex, 0, newPrompt);
    } else {
        allPrompts.push(newPrompt);
    }

    const currentCategory = getCurrentCategory();
    const currentSearch = getCurrentSearchValue();
    saveJsonAuto();
    rerenderPromptShopAfterCardMove(currentCategory, currentSearch);
    return true;
}

function updatePromptShopModalOpenClass() {
    document.body.classList.toggle(
        "promptshop-modal-open",
        Boolean(document.querySelector(".promptshop-modal"))
    );
}

function removePromptShopModal(modal) {
    modal?.remove?.();
    updatePromptShopModalOpenClass();
}

async function deletePromptShopTempImage(imagePath, label = "一時画像削除") {
    const path = String(imagePath ?? "").trim();
    if (!path || path === "assets/no-image.png" || !path.startsWith("assets/")) return;

    try {
        await fetch("/promptshop/delete-image", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path })
        });
    } catch (err) {
        console.error(`${label}失敗:`, err);
    }
}

function getPromptShopModalFormValue(id) {
    return String(document.getElementById(id)?.value ?? "").trim();
}

function normalizePromptShopModalPrompt(value) {
    return normalizePromptList(String(value ?? "").trim()).join(",");
}

function getPromptShopModalImageValue(id) {
    return getPromptShopModalFormValue(id) || "assets/no-image.png";
}

function confirmPromptShopDiscardChangesIfNeeded(hasChanges, message = "変更内容があります。破棄して閉じますか？") {
    if (typeof hasChanges === "function" && !hasChanges()) return true;
    return confirm(message);
}

function bindPromptShopModalBackdropCancel(modal, cancelFn) {
    const box = modal.querySelector(".promptshop-modal-box");
    const ignoreBackdropCancelUntil = Date.now() + 250;

    modal.addEventListener("pointerdown", (e) => {
        if (e.target !== modal) return;
        e.preventDefault();
        e.stopPropagation();
        if (Date.now() < ignoreBackdropCancelUntil) return;
        cancelFn?.();
    }, true);

    modal.addEventListener("click", (e) => {
        if (e.target !== modal) return;
        e.preventDefault();
        e.stopPropagation();
    }, true);

    box?.addEventListener("pointerdown", (e) => e.stopPropagation());
    box?.addEventListener("click", (e) => e.stopPropagation());
}

function addCardDialog() {
    const modal = document.createElement("div");
    modal.className = "promptshop-modal";

    const categoryOptions = [];

    (siteSettings.categories || []).forEach(cat => {
        categoryOptions.push(`<option value="${cat.id}">【親】${cat.name}</option>`);

        (cat.subCategories || []).forEach(sub => {
            categoryOptions.push(`<option value="${sub.id}">　└ ${sub.name}</option>`);
        });
    });

    modal.innerHTML = `
        <div class="promptshop-modal-box">
            <h3>カード追加</h3>

            <label>タイトル</label>
            <input id="newPromptTitle" type="text">

            <label>プロンプト</label>
            <textarea id="newPromptText" rows="10"></textarea>

            <input id="newPromptImage" type="hidden" value="assets/no-image.png">

            <div id="imageDropArea" style="
                border:2px dashed rgba(255,255,255,0.2);
                border-radius:8px;
                padding:12px;
                text-align:center;
                margin-top:8px;
                color:#888;
                cursor:pointer;
            ">
                ここに画像をドロップ
            </div>
            <button id="useCurrentImageBtn">現在の生成画像を使用</button>
            <label>カテゴリ</label>
            <select id="newPromptCategory">
                ${categoryOptions.join("")}
            </select>

            <div class="promptshop-modal-actions">
                <button id="cancelAddCard">キャンセル</button>
                <button id="confirmAddCard">追加</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);
    document.body.classList.add("promptshop-modal-open");

    const box = modal.querySelector(".promptshop-modal-box");
    box.style.height = "80vh";
    box.style.maxHeight = "80vh";
    box.style.overflowY = "auto";

    const dropArea = document.getElementById("imageDropArea");
    const imageInput = document.getElementById("newPromptImage");
    const newPromptCategory = document.getElementById("newPromptCategory");

    const initialAddCardState = {
        title: getPromptShopModalFormValue("newPromptTitle"),
        prompt: normalizePromptShopModalPrompt(getPromptShopModalFormValue("newPromptText")),
        image: getPromptShopModalImageValue("newPromptImage"),
        category: newPromptCategory?.value || ""
    };

    const hasAddCardChanges = () => {
        return getPromptShopModalFormValue("newPromptTitle") !== initialAddCardState.title ||
            normalizePromptShopModalPrompt(getPromptShopModalFormValue("newPromptText")) !== initialAddCardState.prompt ||
            getPromptShopModalImageValue("newPromptImage") !== initialAddCardState.image ||
            (newPromptCategory?.value || "") !== initialAddCardState.category;
    };

    document.getElementById("useCurrentImageBtn").onclick = async () => {
        const img = await getCurrentGeneratedImage();

        if (!img) {
            alert("生成画像が見つかりません");
            return;
        }

        const oldImage = imageInput.value;

        try {
            const res = await fetch("/promptshop/import-image-from-src", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ src: img.src })
            });

            const data = await res.json();

            if (!data.ok) {
                alert("画像取り込み失敗");
                return;
            }

            imageInput.value = data.path;

            if (
                oldImage &&
                oldImage !== data.path &&
                oldImage !== "assets/no-image.png"
            ) {
                await fetch("/promptshop/delete-image", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ path: oldImage })
                });
            }

        } catch (err) {
            console.error(err);
            alert("失敗");
        }
    };

    dropArea.ondragover = (e) => {
        e.preventDefault();
        dropArea.style.borderColor = "#4f46e5";
        dropArea.textContent = "ここに離してアップロード";
    };

    dropArea.ondragleave = () => {
        dropArea.style.borderColor = "rgba(255,255,255,0.2)";
        dropArea.textContent = "ここに画像をドロップ";
    };

    dropArea.ondrop = async (e) => {
        e.preventDefault();
        dropArea.style.borderColor = "rgba(255,255,255,0.2)";

        const file = e.dataTransfer.files[0];

        if (!file || !file.type.startsWith("image/")) {
            alert("画像ファイルのみ対応");
            dropArea.textContent = "ここに画像をドロップ";
            return;
        }

        dropArea.textContent = "アップロード中...";

        try {
            const dataPath = await uploadPromptShopImageFile(file);
            const oldImage = imageInput.value;

            imageInput.value = dataPath;
            await applyCardMetadataFromImageFile(file, "newPromptTitle", "newPromptText");
            dropArea.textContent = "✅ アップロード完了";

            // カード追加前に差し替えられた一時画像を削除
            if (
                oldImage &&
                oldImage !== dataPath &&
                oldImage !== "assets/no-image.png" &&
                oldImage.startsWith("assets/")
            ) {
                try {
                    const delRes = await fetch("/promptshop/delete-image", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ path: oldImage })
                    });

                    const delData = await delRes.json();
                    console.log("追加画面の旧一時画像削除結果:", delData);
                } catch (err) {
                    console.error("追加画面の旧一時画像削除失敗:", err);
                }
            }
        } catch (err) {
            console.error(err);
            alert("アップロード失敗");
            dropArea.textContent = "ここに画像をドロップ";
        }
    };

    let addCardClosing = false;
    const cancelAddCard = async () => {
        if (addCardClosing) return;
        if (!confirmPromptShopDiscardChangesIfNeeded(
            hasAddCardChanges,
            "入力中のカード追加内容があります。破棄して閉じますか？"
        )) return;

        addCardClosing = true;

        await deletePromptShopTempImage(imageInput.value, "追加キャンセル時の一時画像削除");
        removePromptShopModal(modal);
    };

    bindPromptShopModalBackdropCancel(modal, cancelAddCard);
    document.getElementById("cancelAddCard").onclick = cancelAddCard;

    document.getElementById("confirmAddCard").onclick = () => {
        const title = document.getElementById("newPromptTitle").value.trim();
        const promptText = document.getElementById("newPromptText").value.trim();
        const image = document.getElementById("newPromptImage").value.trim();
        const category = document.getElementById("newPromptCategory").value;

        if (!title || !promptText || !category) {
            alert("タイトル・プロンプト・カテゴリは必須です");
            return;
        }

        allPrompts.push({
            id: String(Date.now()),
            title,
            prompt: normalizePromptList(promptText).join(","),
            image: image || "assets/no-image.png",
            category
        });

        saveJsonAuto();
        renderSidebar();
        renderPrompts(getCurrentCategory(), getCurrentSearchValue());

        removePromptShopModal(modal);
    };
}


async function deletePromptCard(id) {
    const item = allPrompts.find(p => String(p.id) === String(id));
    if (!item) return;

    if (!confirm("このカードを削除しますか？\nアップロード画像も一緒に削除します。")) return;

    try {
        if (
            item.image &&
            item.image.startsWith("assets/") &&
            item.image !== "assets/no-image.png"
        ) {
            await fetch("/promptshop/delete-image", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path: item.image })
            });
        }
    } catch (err) {
        console.error("画像削除失敗:", err);
    }

    allPrompts = allPrompts.filter(p => String(p.id) !== String(id));

    saveJsonAuto();
    renderSidebar();
    renderPrompts(getCurrentCategory(), getCurrentSearchValue());
}

function sanitizePromptShopFilename(name, fallback = "card") {
    const source = String(name ?? "").trim();
    const sanitized = source
        .replace(/[\\/:*?"<>|]+/g, "_")
        .replace(/\s+/g, " ")
        .trim();
    return sanitized || fallback;
}

async function uploadPromptShopImageFile(file) {
    const formData = new FormData();
    formData.append("file", file);

    const res = await fetch("/promptshop/upload-image", {
        method: "POST",
        body: formData
    });

    const data = await res.json();
    if (!data.ok) {
        throw new Error(data.error || "画像アップロード失敗");
    }

    return data.path;
}

async function exportPromptCardPng(id) {
    const item = allPrompts.find(p => String(p.id) === String(id));
    if (!item) {
        alert("カードが見つかりません");
        return;
    }

    try {
        const res = await fetch("/promptshop/export-card-png", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                title: item.title || "",
                prompt: item.prompt || "",
                image: item.image || "assets/no-image.png"
            })
        });

        if (!res.ok) {
            const message = await res.text();
            throw new Error(message || `HTTP ${res.status}`);
        }

        const blob = await res.blob();
        const downloadName = `${sanitizePromptShopFilename(item.title || "card")}.png`;
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = downloadName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
        console.error("PNG書き出し失敗:", err);
        alert(`PNG書き出し失敗: ${err.message || err}`);
    }
}

async function readPromptCardMetadataFromFile(file) {
    const formData = new FormData();
    formData.append("file", file);

    const res = await fetch("/promptshop/read-card-png-metadata", {
        method: "POST",
        body: formData
    });

    const data = await res.json();
    if (!data.ok) {
        throw new Error(data.error || "PNGメタデータの読み込み失敗");
    }

    return {
        title: String(data.title || "").trim(),
        prompt: String(data.prompt || "").trim()
    };
}

function getDefaultPromptShopImportCategory() {
    const activeItem = document.querySelector(".nav-item.active, .nav-sub-item.active");
    let category = activeItem ? activeItem.getAttribute("data-category") : "";

    if (!category || category === "all" || category === "uncategorized") {
        const firstCat = siteSettings.categories?.[0];
        category = firstCat?.subCategories?.[0]?.id || firstCat?.id || "";
    }

    return isValidPromptShopCategoryId(category) ? category : "";
}

async function importPromptCardsFromPng() {
    const modal = document.createElement("div");
    modal.className = "promptshop-modal";

    modal.innerHTML = `
        <div class="promptshop-modal-box">
            <h3>カードインポート</h3>
            <p style="color: var(--text-secondary); font-size: 0.85rem; margin-bottom: 0.8rem;">
                PNG画像を選択またはドロップしてください。<br>
                取り込んだカードは <strong>未分類</strong> に追加されます。
            </p>

            <div id="promptPngImportDropArea" style="
                border:2px dashed rgba(255,255,255,0.2);
                border-radius:8px;
                padding:16px;
                text-align:center;
                color:#888;
                cursor:pointer;
                margin-bottom:12px;
            ">
                ここにPNG画像をドロップ<br>
                またはクリックして選択
            </div>

            <input id="promptPngImportInput" type="file" accept=".png,image/png" multiple style="display:none;">

            <div id="promptPngImportSummary" style="
                margin-bottom:10px;
                font-size:0.85rem;
                color: var(--text-secondary);
            ">PNGファイルが選択されていません</div>

            <div id="promptPngImportList" style="
                min-height:120px;
                max-height:38vh;
                overflow-y:auto;
                border:1px solid rgba(255,255,255,0.08);
                border-radius:0.7rem;
                padding:0.6rem;
                background:rgba(255,255,255,0.03);
                margin-bottom:0.8rem;
            ">
                <div style="color: var(--text-secondary); font-size:0.82rem; text-align:center; padding:1rem 0;">
                    ここに選択したPNGの一覧が表示されます
                </div>
            </div>

            <div class="promptshop-modal-actions">
                <button id="cancelPromptPngImport">キャンセル</button>
                <button id="confirmPromptPngImport">取り込み</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);
    document.body.classList.add("promptshop-modal-open");

    const dropArea = document.getElementById("promptPngImportDropArea");
    const input = document.getElementById("promptPngImportInput");
    const list = document.getElementById("promptPngImportList");
    const summary = document.getElementById("promptPngImportSummary");
    const confirmBtn = document.getElementById("confirmPromptPngImport");

    let selectedFiles = [];
    let importClosing = false;
    let importing = false;

    const renderSelectedFiles = async () => {
        if (selectedFiles.length === 0) {
            summary.textContent = "PNGファイルが選択されていません";
            list.innerHTML = `
                <div style="color: var(--text-secondary); font-size:0.82rem; text-align:center; padding:1rem 0;">
                    ここに選択したPNGの一覧が表示されます
                </div>
            `;
            return;
        }

        summary.textContent = `${selectedFiles.length}件のPNGを取り込み待ちです（取り込み先: 未分類）`;
        list.innerHTML = `<div style="color: var(--text-secondary); font-size:0.82rem; text-align:center; padding:1rem 0;">メタデータを読み込み中...</div>`;

        const rows = await Promise.all(selectedFiles.map(async (file, index) => {
            let title = "-";
            let promptText = "-";
            let metaError = "";
            try {
                const metadata = await readPromptCardMetadataFromFile(file);
                title = metadata.title || file.name.replace(/\.png$/i, "") || "インポートカード";
                promptText = metadata.prompt || "（プロンプトなし）";
            } catch (err) {
                metaError = err.message || String(err);
                title = file.name;
                promptText = "メタデータ読み込み失敗";
            }

            const safeTitle = escapeHtml(title);
            const safePrompt = escapeHtml(promptText);
            const safeError = escapeHtml(metaError);

            return `
                <div style="padding:0.55rem 0.6rem; border:1px solid rgba(255,255,255,0.08); border-radius:0.55rem; margin-bottom:0.45rem; background:rgba(255,255,255,0.03);">
                    <div style="font-size:0.78rem; color:var(--text-secondary); margin-bottom:0.2rem;">${index + 1}. ${escapeHtml(file.name)}</div>
                    <div style="font-size:0.9rem; font-weight:700; margin-bottom:0.18rem;">${safeTitle}</div>
                    <div style="font-size:0.74rem; color:var(--text-secondary); word-break:break-word;">${safePrompt}</div>
                    ${safeError ? `<div style="font-size:0.72rem; color:#fca5a5; margin-top:0.3rem;">${safeError}</div>` : ""}
                </div>
            `;
        }));

        list.innerHTML = rows.join("") || `<div style="color: var(--text-secondary); font-size:0.82rem; text-align:center; padding:1rem 0;">読み込めるPNGがありません</div>`;
    };

    const setSelectedFiles = async (files) => {
        selectedFiles = [...files].filter(file => file && (file.type === "image/png" || /\.png$/i.test(file.name || "")));
        await renderSelectedFiles();
    };

    dropArea.onclick = () => input.click();

    dropArea.ondragover = (e) => {
        e.preventDefault();
        dropArea.style.borderColor = "#4f46e5";
        dropArea.style.color = "#c7d2fe";
    };

    dropArea.ondragleave = () => {
        dropArea.style.borderColor = "rgba(255,255,255,0.2)";
        dropArea.style.color = "#888";
    };

    dropArea.ondrop = async (e) => {
        e.preventDefault();
        dropArea.style.borderColor = "rgba(255,255,255,0.2)";
        dropArea.style.color = "#888";
        await setSelectedFiles(e.dataTransfer.files || []);
    };

    input.onchange = async () => {
        await setSelectedFiles(input.files || []);
    };

    const cancelImport = () => {
        if (importClosing || importing) return;
        importClosing = true;
        removePromptShopModal(modal);
    };

    bindPromptShopModalBackdropCancel(modal, cancelImport);
    document.getElementById("cancelPromptPngImport").onclick = cancelImport;

    confirmBtn.onclick = async () => {
        if (importing) return;
        if (selectedFiles.length === 0) {
            alert("PNGファイルを選択してください");
            return;
        }

        importing = true;
        confirmBtn.disabled = true;
        confirmBtn.textContent = "取り込み中...";

        const category = ""; // 未分類
        let successCount = 0;
        const errors = [];

        for (const file of selectedFiles) {
            try {
                const metadata = await readPromptCardMetadataFromFile(file);
                const imagePath = await uploadPromptShopImageFile(file);
                const title = metadata.title || file.name.replace(/\.png$/i, "") || "インポートカード";
                const promptText = metadata.prompt || "";

                allPrompts.push({
                    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
                    title,
                    prompt: normalizePromptList(promptText).join(","),
                    image: imagePath || "assets/no-image.png",
                    category
                });

                successCount += 1;
            } catch (err) {
                console.error("PNG取り込み失敗:", file.name, err);
                errors.push(`${file.name}: ${err.message || err}`);
            }
        }

        if (successCount > 0) {
            saveJsonAuto();
            renderSidebar();
            renderPrompts(getCurrentCategory(), getCurrentSearchValue());
        }

        importing = false;
        confirmBtn.disabled = false;
        confirmBtn.textContent = "取り込み";

        if (errors.length > 0) {
            alert(`PNG取込: ${successCount}件成功 / ${errors.length}件失敗\n\n${errors.slice(0, 5).join("\n")}`);
            return;
        }

        removePromptShopModal(modal);
        alert(`${successCount}件のPNGカードを未分類に取り込みました`);
    };
}

async function applyCardMetadataFromImageFile(file, titleInputId, promptInputId) {
    if (!file || !file.type.startsWith("image/")) return;
    if (!/\.png$/i.test(file.name || "") && file.type !== "image/png") return;

    try {
        const metadata = await readPromptCardMetadataFromFile(file);
        const titleInput = document.getElementById(titleInputId);
        const promptInput = document.getElementById(promptInputId);

        if (titleInput && metadata.title) titleInput.value = metadata.title;
        if (promptInput && metadata.prompt) promptInput.value = metadata.prompt;
    } catch (err) {
        console.warn("PNGメタデータ読み込み失敗:", err);
    }
}

function exportPromptsJSON() {
    const data = {
        settings: siteSettings,
        prompts: allPrompts
    };

    const json = JSON.stringify(data, null, 2);

    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = "prompts.json";
    a.click();

    URL.revokeObjectURL(url);
}

async function pickJsonFile() {
    fileHandle = await window.showSaveFilePicker({
        suggestedName: "prompts.json",
        types: [{
            description: "JSON",
            accept: { "application/json": [".json"] }
        }]
    });

    console.log("保存先選択OK");
}

async function saveJsonAuto() {
    const data = {
        settings: siteSettings,
        prompts: allPrompts
    };

    try {
        const res = await fetch(`${window.location.origin}/promptshop/save`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data)
        });

        const text = await res.text();

        if (!res.ok) {
            console.error("自動保存失敗:", res.status, text);
            alert(`自動保存失敗: HTTP ${res.status}\n${text}`);
            return;
        }

        console.log("自動保存完了:", text);

    } catch (err) {
        console.error("自動保存失敗:", err);
        alert("自動保存失敗: " + err.message);
    }
}
let saveTimer;

function autoSaveDebounced() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        saveJsonAuto();
    }, 500);
}

function openCategoryManager() {
    const existingModal = document.getElementById("categoryManagerModal");
    if (existingModal) {
        existingModal.classList.remove("promptshop-modal-attention");
        void existingModal.offsetWidth;
        existingModal.classList.add("promptshop-modal-attention");
        existingModal.querySelector("input, button, select, textarea")?.focus?.();
        return;
    }

    // 他のモーダル表示中は新規に開かない。
    const anyModal = document.querySelector(".promptshop-modal");
    if (anyModal) {
        anyModal.classList.remove("promptshop-modal-attention");
        void anyModal.offsetWidth;
        anyModal.classList.add("promptshop-modal-attention");
        return;
    }

    const categoryButton = document.getElementById("categoryManagerBtn");
    if (categoryButton) categoryButton.disabled = true;

    const modal = document.createElement("div");
    modal.id = "categoryManagerModal";
    modal.className = "promptshop-modal promptshop-category-modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");

    modal.innerHTML = `
        <div class="promptshop-modal-box promptshop-category-manager-box">
            <h3 style="margin-bottom:16px;">カテゴリ管理</h3>

            <div class="promptshop-category-add-row">
                <input id="newCatName" placeholder="親カテゴリ名">
                <input id="newCatId" placeholder="親カテゴリID">
                <select id="newCatIcon">
                    ${createIconOptions("package")}
                </select>
                <button id="addCatBtn">親カテゴリ追加</button>
            </div>

            <div id="categoryList"></div>

            <div class="promptshop-modal-actions">
                <button id="closeModal">閉じる</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);
    document.body.classList.add("promptshop-modal-open");

    // 開いた直後の連打が、即座に外側クリック扱いで閉じるのを防ぐ。
    const ignoreBackdropCancelUntil = Date.now() + 350;

    const box = modal.querySelector(".promptshop-category-manager-box");

    const hasUnsavedCategoryDraft = () => {
        const newName = document.getElementById("newCatName")?.value?.trim() || "";
        const newId = document.getElementById("newCatId")?.value?.trim() || "";
        const newIcon = document.getElementById("newCatIcon")?.value || "package";

        if (newName || newId || newIcon !== "package") return true;

        return (siteSettings.categories || []).some(cat => {
            const subName = document.getElementById(`subName-${cat.id}`)?.value?.trim() || "";
            const subId = document.getElementById(`subId-${cat.id}`)?.value?.trim() || "";
            return Boolean(subName || subId);
        });
    };

    const closeCategoryManager = () => {
        document.removeEventListener("keydown", onCategoryManagerKeyDown, true);
        document.body.classList.remove("promptshop-modal-open");
        if (categoryButton) categoryButton.disabled = false;
        modal.remove();
    };

    const requestCloseCategoryManager = () => {
        if (hasUnsavedCategoryDraft()) {
            const ok = confirm("入力中のカテゴリ情報があります。閉じますか？\n未追加の入力内容は破棄されます。");
            if (!ok) return;
        }
        closeCategoryManager();
    };

    const onCategoryManagerKeyDown = (e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        requestCloseCategoryManager();
    };

    // 背後の固定ツールバーやカードへクリックを通さない。
    modal.addEventListener("pointerdown", (e) => {
        if (e.target === modal) {
            e.preventDefault();
            e.stopPropagation();
            if (Date.now() < ignoreBackdropCancelUntil) return;
            requestCloseCategoryManager();
        }
    }, true);

    modal.addEventListener("click", (e) => {
        if (e.target === modal) {
            e.preventDefault();
            e.stopPropagation();
        }
    }, true);

    box.addEventListener("pointerdown", (e) => e.stopPropagation());
    box.addEventListener("click", (e) => e.stopPropagation());
    document.addEventListener("keydown", onCategoryManagerKeyDown, true);

    renderCategoryList();

    document.getElementById("closeModal").onclick = requestCloseCategoryManager;

    document.getElementById("addCatBtn").onclick = () => {
        const nameInput = document.getElementById("newCatName");
        const idInput = document.getElementById("newCatId");
        const iconSelect = document.getElementById("newCatIcon");

        const name = nameInput.value.trim();
        const id = idInput.value.trim();

        if (!name || !id) return alert("親カテゴリ名とIDを入力してください");

        if (siteSettings.categories.some(c => c.id === id)) {
            return alert("同じIDのカテゴリがあります");
        }

        const icon = iconSelect.value;

        siteSettings.categories.push({
            id,
            name,
            icon: icon || "package",
            subCategories: []
        });

        nameInput.value = "";
        idInput.value = "";
        iconSelect.value = "package";

        saveAll();
        renderSidebar();
        renderCategoryList();

        setTimeout(() => lucide.createIcons(), 0);
    };
}

function renderCategoryList() {
    const list = document.getElementById("categoryList");
    if (!list) return;

    list.innerHTML = "";

    (siteSettings.categories || []).forEach(cat => {
        const div = document.createElement("div");
        div.className = "category-manager-item";
        div.draggable = true;
        div.dataset.catId = cat.id;

        div.style = `
            border:1px solid rgba(255,255,255,0.12);
            border-radius:10px;
            padding:12px;
            margin-bottom:12px;
            background:rgba(255,255,255,0.04);
            cursor:grab;
        `;

        div.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
                <div>
                    <b>☰ ${cat.name}</b>
                    <span style="color:#94a3b8;">(${cat.id})</span>

                    <div style="margin-top:8px; display:flex; gap:8px; align-items:center;">
                        <select id="icon-${cat.id}">
                            ${createIconOptions(cat.icon || "package")}
                        </select>
                        <button onclick="updateCategoryIcon('${cat.id}')">アイコン更新</button>
                    </div>
                </div>
                <button onclick="deleteCategory('${cat.id}')">親削除</button>
            </div>

            <div style="margin-top:10px; padding-left:12px;">
                <div style="font-size:0.85rem; color:#94a3b8; margin-bottom:6px;">小カテゴリ</div>
                <div id="subList-${cat.id}" class="sub-category-manager-list"></div>

                <div style="display:flex; gap:8px; margin-top:8px;">
                    <input id="subName-${cat.id}" placeholder="小カテゴリ名">
                    <input id="subId-${cat.id}" placeholder="小カテゴリID">
                    <button onclick="addSubCategory('${cat.id}')">小カテゴリ追加</button>
                </div>
            </div>
        `;

        list.appendChild(div);

        const subList = div.querySelector(`#subList-${cat.id}`);

        (cat.subCategories || []).forEach(sub => {
            const row = document.createElement("div");
            row.className = "sub-category-manager-item";
            row.draggable = true;
            row.dataset.parentId = cat.id;
            row.dataset.subId = sub.id;

            row.style = `
                display:flex;
                justify-content:space-between;
                align-items:center;
                padding:6px 0;
                border-bottom:1px solid rgba(255,255,255,0.06);
                cursor:grab;
            `;

            row.innerHTML = `
                <span>☰ ${sub.name} <span style="color:#94a3b8;">(${sub.id})</span></span>
                <button onclick="deleteSubCategory('${cat.id}', '${sub.id}')">削除</button>
            `;

            subList.appendChild(row);
        });
    });

    attachCategoryDragAndDrop();
    attachSubCategoryDragAndDrop();
}
function deleteCategory(id) {
    if (!confirm("削除する？")) return;

    siteSettings.categories = siteSettings.categories.filter(c => c.id !== id);

    saveAll();
    renderSidebar();
    renderCategoryList();
}

function saveAll() {
    savePrompts();
    autoSaveDebounced();
}

function openCategorySelector(id) {
    const modal = document.createElement("div");
    modal.style = `
        position:fixed;
        top:0;left:0;
        width:100%;height:100%;
        background:rgba(0,0,0,0.6);
        display:flex;
        align-items:center;
        justify-content:center;
        z-index:9999;
    `;

    let html = `<div style="background:#111;padding:20px;border-radius:10px;">`;
    html += `<h3>カテゴリ変更</h3>`;

    siteSettings.categories.forEach(cat => {
        html += `<div style="margin-top:10px;">
            <b>${cat.name}</b><br>
        `;

        if (cat.subCategories) {
            cat.subCategories.forEach(sub => {
                html += `
                    <button onclick="changeCategory('${id}','${sub.id}')">
                        ${sub.name}
                    </button>
                `;
            });
        }

        html += `</div>`;
    });

    html += `<br><button onclick="this.closest('div').parentElement.remove()">閉じる</button>`;
    html += `</div>`;

    modal.innerHTML = html;
    document.body.appendChild(modal);
}

function changeCategory(id, newCat) {
    const item = allPrompts.find(p => String(p.id) === String(id));
    if (!item) return;

    item.category = newCat;

    saveJsonAuto();

    renderSidebar();
    renderPrompts(getCurrentCategory(), searchInput?.value || "");

    document.querySelectorAll("div[style*='position:fixed']").forEach(el => el.remove());
}
function addSubCategory(parentId) {
    const parent = siteSettings.categories.find(c => c.id === parentId);
    if (!parent) return;

    const name = document.getElementById(`subName-${parentId}`).value.trim();
    const id = document.getElementById(`subId-${parentId}`).value.trim();

    if (!name || !id) return alert("小カテゴリ名とIDを入力してください");

    parent.subCategories = parent.subCategories || [];

    const exists = siteSettings.categories.some(c =>
        c.id === id || (c.subCategories || []).some(s => s.id === id)
    );

    if (exists) return alert("同じIDのカテゴリがあります");

    parent.subCategories.push({ id, name });

    saveAll();
    renderSidebar();
    renderCategoryList();
}

function deleteSubCategory(parentId, subId) {
    if (!confirm("この小カテゴリを削除しますか？")) return;

    const parent = siteSettings.categories.find(c => c.id === parentId);
    if (!parent) return;

    parent.subCategories = (parent.subCategories || []).filter(s => s.id !== subId);

    saveAll();
    renderSidebar();
    renderCategoryList();
}

document.getElementById("sidebarToggle").onclick = () => {
    sidebar.classList.toggle("collapsed");
};

const saved = localStorage.getItem("sidebar");
if (saved === "closed") sidebar.classList.add("collapsed");

document.getElementById("sidebarToggle").onclick = () => {
    const closed = sidebar.classList.toggle("collapsed");
    localStorage.setItem("sidebar", closed ? "closed" : "open");
};

function openEditPromptDialog(id) {
    const item = allPrompts.find(p => String(p.id) === String(id));
    if (!item) return alert("カードが見つかりません");

    const modal = document.createElement("div");
    modal.className = "promptshop-modal";

    const categoryOptions = [];

    (siteSettings.categories || []).forEach(cat => {
        categoryOptions.push(`
            <option value="${cat.id}" ${item.category === cat.id ? "selected" : ""}>
                【親】${cat.name}
            </option>
        `);

        (cat.subCategories || []).forEach(sub => {
            categoryOptions.push(`
                <option value="${sub.id}" ${item.category === sub.id ? "selected" : ""}>
                    　└ ${sub.name}
                </option>
            `);
        });
    });

    modal.innerHTML = `
        <div class="promptshop-modal-box">
            <h3>カード編集</h3>

            <label>タイトル</label>
            <input id="editPromptTitle" type="text" value="${item.title || ""}">

            <label>プロンプト</label>
            <textarea id="editPromptText" rows="10">${item.prompt || ""}</textarea>

            <input id="editPromptImage" type="hidden" value="${item.image || "assets/no-image.png"}">

            <div id="editImageDropArea" style="
                border:2px dashed rgba(255,255,255,0.2);
                border-radius:8px;
                padding:12px;
                text-align:center;
                margin-top:8px;
                color:#888;
                cursor:pointer;
            ">
                ここに画像をドロップ
            </div>

            <button id="useCurrentImageBtn">現在の生成画像を使用</button>

            <label>カテゴリ</label>
            <select id="editPromptCategory">
                ${categoryOptions.join("")}
            </select>

            <div class="promptshop-modal-actions">
                <button id="cancelEditCard">キャンセル</button>
                <button id="confirmEditCard">保存</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);
    document.body.classList.add("promptshop-modal-open");

    const originalImage = item.image || "assets/no-image.png";
    let editCardClosing = false;
    const useBtn = document.getElementById("useCurrentImageBtn");

    if (useBtn) {
        useBtn.onclick = async () => {
            const parentApp = window.parent?.gradioApp?.();
            if (!parentApp) {
                alert("WebUI取得失敗");
                return;
            }

            const imgs = [...parentApp.querySelectorAll("#txt2img_gallery img")]
                .filter(img => img.naturalWidth > 0);

            if (imgs.length === 0) {
                alert("生成画像が見つかりません");
                return;
            }

            const img = imgs.sort((a, b) =>
                (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight)
            )[0];

            const oldImage = imageInput.value;

            try {
                const res = await fetch("/promptshop/import-image-from-src", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ src: img.src })
                });

                const data = await res.json();

                if (!data.ok) {
                    alert("画像取り込み失敗");
                    return;
                }

                imageInput.value = data.path;

                if (
                    oldImage &&
                    oldImage !== data.path &&
                    oldImage !== originalImage &&
                    oldImage !== "assets/no-image.png" &&
                    oldImage.startsWith("assets/")
                ) {
                    await deletePromptShopTempImage(oldImage, "編集画面の旧一時画像削除");
                }

            } catch (err) {
                console.error(err);
                alert("失敗");
            }
        };
    }

    const box = modal.querySelector(".promptshop-modal-box");
    box.style.height = "80vh";
    box.style.maxHeight = "80vh";
    box.style.overflowY = "auto";

    const dropArea = document.getElementById("editImageDropArea");
    const imageInput = document.getElementById("editPromptImage");
    const editPromptCategory = document.getElementById("editPromptCategory");

    const initialEditCardState = {
        title: getPromptShopModalFormValue("editPromptTitle"),
        prompt: normalizePromptShopModalPrompt(getPromptShopModalFormValue("editPromptText")),
        image: getPromptShopModalImageValue("editPromptImage"),
        category: editPromptCategory?.value || ""
    };

    const hasEditCardChanges = () => {
        return getPromptShopModalFormValue("editPromptTitle") !== initialEditCardState.title ||
            normalizePromptShopModalPrompt(getPromptShopModalFormValue("editPromptText")) !== initialEditCardState.prompt ||
            getPromptShopModalImageValue("editPromptImage") !== initialEditCardState.image ||
            (editPromptCategory?.value || "") !== initialEditCardState.category;
    };

    dropArea.ondragover = (e) => {
        e.preventDefault();
        dropArea.style.borderColor = "#4f46e5";
        dropArea.textContent = "ここに離してアップロード";
    };

    dropArea.ondragleave = () => {
        dropArea.style.borderColor = "rgba(255,255,255,0.2)";
        dropArea.textContent = "ここに画像をドロップ";
    };

dropArea.ondrop = async (e) => {
    e.preventDefault();
    dropArea.style.borderColor = "rgba(255,255,255,0.2)";

    const file = e.dataTransfer.files[0];

    if (!file || !file.type.startsWith("image/")) {
        alert("画像ファイルのみ対応");
        dropArea.textContent = "ここに画像をドロップ";
        return;
    }

    const oldImage = imageInput.value;

    dropArea.textContent = "アップロード中...";

    try {
        const dataPath = await uploadPromptShopImageFile(file);

        imageInput.value = dataPath;
        await applyCardMetadataFromImageFile(file, "editPromptTitle", "editPromptText");

        // 編集画面内で差し替えた一時画像だけ削除する。元画像は保存確定まで残す。
        if (
            oldImage &&
            oldImage !== dataPath &&
            oldImage !== originalImage &&
            oldImage !== "assets/no-image.png" &&
            oldImage.startsWith("assets/")
        ) {
            await deletePromptShopTempImage(oldImage, "編集画面の旧一時画像削除");
        }

        dropArea.textContent = "✅ アップロード完了";

    } catch (err) {
        console.error(err);
        alert("アップロード失敗");
        dropArea.textContent = "ここに画像をドロップ";
    }
};

    const cancelEditCard = async () => {
        if (editCardClosing) return;
        if (!confirmPromptShopDiscardChangesIfNeeded(
            hasEditCardChanges,
            "変更内容があります。保存せずに破棄して閉じますか？"
        )) return;

        editCardClosing = true;

        const currentInputImage = imageInput.value;
        if (
            currentInputImage &&
            currentInputImage !== originalImage &&
            currentInputImage !== "assets/no-image.png" &&
            currentInputImage.startsWith("assets/")
        ) {
            await deletePromptShopTempImage(currentInputImage, "編集キャンセル時の一時画像削除");
        }

        removePromptShopModal(modal);
    };

    bindPromptShopModalBackdropCancel(modal, cancelEditCard);
    document.getElementById("cancelEditCard").onclick = cancelEditCard;

    document.getElementById("confirmEditCard").onclick = async () => {
        if (editCardClosing) return;
        editCardClosing = true;

        item.title = document.getElementById("editPromptTitle").value.trim();
        item.prompt = normalizePromptList(document.getElementById("editPromptText").value.trim()).join(",");
        item.image = document.getElementById("editPromptImage").value.trim() || "assets/no-image.png";
        item.category = document.getElementById("editPromptCategory").value;

        if (
            originalImage &&
            originalImage !== item.image &&
            originalImage !== "assets/no-image.png" &&
            originalImage.startsWith("assets/")
        ) {
            await deletePromptShopTempImage(originalImage, "編集保存後の旧画像削除");
        }

        saveJsonAuto();
        renderSidebar();
        renderPrompts(getCurrentCategory(), getCurrentSearchValue());

        removePromptShopModal(modal);
    };
}
function movePromptBefore(draggedId, targetId, options = {}) {
    const fromIndex = allPrompts.findIndex(p => String(p.id) === String(draggedId));
    const targetItem = allPrompts.find(p => String(p.id) === String(targetId));

    if (fromIndex === -1 || !targetItem) return false;

    const [moved] = allPrompts.splice(fromIndex, 1);

    if (Object.prototype.hasOwnProperty.call(options, "category")) {
        moved.category = String(options.category ?? "");
    }

    const toIndex = allPrompts.findIndex(p => String(p.id) === String(targetId));
    if (toIndex === -1) {
        allPrompts.push(moved);
    } else {
        allPrompts.splice(toIndex, 0, moved);
    }

    promptShopDraggingCardId = null;
    savePrompts();
    autoSaveDebounced();

    rerenderPromptShopAfterCardMove(options.keepCategory ?? getCurrentCategory(), options.search ?? getCurrentSearchValue());
    return true;
}

async function handleImageDrop(file, id) {
    if (!file.type.startsWith("image/")) {
        alert("画像ファイルのみ");
        return;
    }

    const item = allPrompts.find(p => String(p.id) === String(id));
    if (!item) {
        alert("対象カードが見つかりません");
        return;
    }

    const oldImage = item.image;

    try {
        const dataPath = await uploadPromptShopImageFile(file);
        item.image = dataPath;

        if (/\.png$/i.test(file.name || "") || file.type === "image/png") {
            try {
                const metadata = await readPromptCardMetadataFromFile(file);
                if (metadata.title) item.title = metadata.title;
                if (metadata.prompt) item.prompt = normalizePromptList(metadata.prompt).join(",");
            } catch (metaErr) {
                console.warn("PNGメタデータ読み込み失敗:", metaErr);
            }
        }

        if (
            oldImage &&
            oldImage !== dataPath &&
            oldImage !== "assets/no-image.png" &&
            oldImage.startsWith("assets/")
        ) {
            const delRes = await fetch("/promptshop/delete-image", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path: oldImage })
            });

            const delData = await delRes.json();
            console.log("古い画像削除結果:", delData);
        }

        saveJsonAuto();
        renderSidebar();
        renderPrompts(getCurrentCategory(), getCurrentSearchValue());

    } catch (err) {
        console.error("画像アップロード失敗:", err);
        alert("アップロード失敗");
    }
}
let tooltip;

function hidePromptShopTooltip() {
    if (tooltip) {
        tooltip.remove();
        tooltip = null;
    }

    document.querySelectorAll(".custom-tooltip").forEach(el => el.remove());
}

document.addEventListener("mousemove", (e) => {
    if (!tooltip) return;

    const offset = 12;
    let x = e.clientX + offset;
    let y = e.clientY + offset;

    const rect = tooltip.getBoundingClientRect();

    // 右端はみ出し防止
    if (x + rect.width > window.innerWidth) {
        x = e.clientX - rect.width - offset;
    }

    // 下はみ出し防止
    if (y + rect.height > window.innerHeight) {
        y = e.clientY - rect.height - offset;
    }

    tooltip.style.left = x + "px";
    tooltip.style.top = y + "px";
});

function updateCategoryIcon(id) {
    const cat = siteSettings.categories.find(c => c.id === id);
    if (!cat) return;

    const select = document.getElementById(`icon-${id}`);
    if (!select) return;

    cat.icon = select.value || "package";

    saveAll();
    renderSidebar();
    renderCategoryList();

    lucide.createIcons();
}
function attachCategoryDragAndDrop() {
    const items = document.querySelectorAll(".category-manager-item");

    items.forEach(item => {
        item.ondragstart = (e) => {
            e.stopPropagation();
            e.dataTransfer.setData("text/category-id", item.dataset.catId);
            item.style.opacity = "0.4";
        };

        item.ondragend = () => {
            item.style.opacity = "1";
        };

        item.ondragover = (e) => {
            e.preventDefault();
            item.style.outline = "2px dashed #6366f1";
        };

        item.ondragleave = () => {
            item.style.outline = "none";
        };

        item.ondrop = (e) => {
            e.preventDefault();
            e.stopPropagation();

            item.style.outline = "none";

            const draggedId = e.dataTransfer.getData("text/category-id");
            const targetId = item.dataset.catId;

            if (!draggedId || draggedId === targetId) return;

            moveCategoryBefore(draggedId, targetId);
        };
    });
}

function moveCategoryBefore(draggedId, targetId) {
    const fromIndex = siteSettings.categories.findIndex(c => c.id === draggedId);
    const toIndex = siteSettings.categories.findIndex(c => c.id === targetId);

    if (fromIndex === -1 || toIndex === -1) return;

    const [moved] = siteSettings.categories.splice(fromIndex, 1);
    siteSettings.categories.splice(toIndex, 0, moved);

    saveAll();
    renderSidebar();
    renderCategoryList();
    renderPrompts(getCurrentCategory(), getCurrentSearchValue());
}

function attachSubCategoryDragAndDrop() {
    const items = document.querySelectorAll(".sub-category-manager-item");

    items.forEach(item => {
        item.ondragstart = (e) => {
            e.stopPropagation();
            e.dataTransfer.setData("text/sub-parent-id", item.dataset.parentId);
            e.dataTransfer.setData("text/sub-id", item.dataset.subId);
            item.style.opacity = "0.4";
        };

        item.ondragend = () => {
            item.style.opacity = "1";
        };

        item.ondragover = (e) => {
            e.preventDefault();
            e.stopPropagation();
            item.style.outline = "2px dashed #6366f1";
        };

        item.ondragleave = () => {
            item.style.outline = "none";
        };

        item.ondrop = (e) => {
            e.preventDefault();
            e.stopPropagation();

            item.style.outline = "none";

            const parentId = e.dataTransfer.getData("text/sub-parent-id");
            const draggedSubId = e.dataTransfer.getData("text/sub-id");
            const targetSubId = item.dataset.subId;

            if (!parentId || !draggedSubId || draggedSubId === targetSubId) return;

            moveSubCategoryBefore(parentId, draggedSubId, targetSubId);
        };
    });
}

function moveSubCategoryBefore(parentId, draggedSubId, targetSubId) {
    const parent = siteSettings.categories.find(c => c.id === parentId);
    if (!parent || !parent.subCategories) return;

    const fromIndex = parent.subCategories.findIndex(s => s.id === draggedSubId);
    const toIndex = parent.subCategories.findIndex(s => s.id === targetSubId);

    if (fromIndex === -1 || toIndex === -1) return;

    const [moved] = parent.subCategories.splice(fromIndex, 1);
    parent.subCategories.splice(toIndex, 0, moved);

    saveAll();
    renderSidebar();
    renderCategoryList();
    renderPrompts(getCurrentCategory(), getCurrentSearchValue());
}
async function deleteCardImageOnly(id) {
    const item = allPrompts.find(p => String(p.id) === String(id));
    if (!item) return;

    if (!item.image || item.image === "assets/no-image.png") {
        alert("削除する画像がありません");
        return;
    }

    if (!confirm("このカードの画像だけ削除しますか？")) return;

    const oldImage = item.image;

    if (
        oldImage.startsWith("assets/") &&
        oldImage !== "assets/no-image.png"
    ) {
        try {
            await fetch("/promptshop/delete-image", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path: oldImage })
            });
        } catch (err) {
            console.error("画像のみ削除失敗:", err);
        }
    }

    item.image = "assets/no-image.png";

    saveJsonAuto();
    renderSidebar();
    renderPrompts(getCurrentCategory(), getCurrentSearchValue());
}

async function addCurrentImageCard() {
    const parentApp = window.parent?.gradioApp?.();
    if (!parentApp) {
        alert("WebUI画面が見つかりません");
        return;
    }

    const textarea = parentApp.querySelector("#txt2img_prompt textarea");
    const promptText = textarea?.value?.trim() || "";

    if (!promptText) {
        alert("txt2imgプロンプトが空です");
        return;
    }

    const imgs = [...parentApp.querySelectorAll("#txt2img_gallery img")]
        .filter(img => img.naturalWidth > 0 && img.naturalHeight > 0);

    if (imgs.length === 0) {
        alert("生成画像が見つかりません");
        return;
    }

    const img = imgs.sort((a, b) => {
        return (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight);
    })[0];

    try {
        const res = await fetch("/promptshop/import-image-from-src", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ src: img.src })
        });

        const data = await res.json();

        if (!data.ok) {
            console.error(data);
            alert("生成画像の取り込みに失敗しました");
            return;
        }

        const category = getDefaultPromptShopImportCategory();

        allPrompts.push({
            id: String(Date.now()),
            title: promptText.slice(0, 30) || "生成画像カード",
            prompt: normalizePromptList(promptText).join(","),
            image: data.path,
            category
        });

        saveJsonAuto();
        renderSidebar();
        renderPrompts(getCurrentCategory(), getCurrentSearchValue());

        alert("生成画像をカードに追加しました");

    } catch (err) {
        console.error(err);
        alert("生成画像カード化に失敗しました");
    }
}
async function getCurrentGeneratedImage() {
    const parentApp = window.parent?.gradioApp?.();
    if (!parentApp) return null;

    const imgs = [...parentApp.querySelectorAll("#txt2img_gallery img")]
        .filter(img => img.naturalWidth > 0);

    if (imgs.length === 0) return null;

    return imgs.sort((a, b) =>
        (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight)
    )[0];
}
// Initial Load
document.addEventListener('DOMContentLoaded', init);
