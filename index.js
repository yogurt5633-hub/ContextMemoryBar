/*
 * Context Memory Bar for SillyTavern
 *
 * Four segments:
 *  1) everything except character/persona fields and ChatHistory
 *  2) Character Description + Character Personality + Persona Description
 *  3) ChatHistory
 *  4) unused part of the configured full context window
 *
 * No user-facing settings, no network calls of its own, no prompt modification.
 */

const MODULE_NAME = 'context-memory-bar';
const STORAGE_PREFIX = 'st-context-memory-bar:v1:';
const WARNING_STORAGE_PREFIX = 'st-context-memory-bar:warning:v2:';
const TRUNCATION_STORAGE_PREFIX = 'st-context-memory-bar:truncation:v1:';
const MOBILE_LAYOUT_QUERY = '(max-width: 1000px)';

let core = null;
let itemizedModule = null;
let openaiModule = null;
let tokenizersModule = null;
let context = null;
let liveSnapshot = null;
let refreshSerial = 0;
let started = false;
let activeGenerationType = null;
let activeGenerationDryRun = false;
let currentHistoryTruncated = false;
let currentHistoryBoundary = 0;
let mobileLayoutMedia = null;

const COLORS = Object.freeze({
    main: '#8B5CF6',
    character: '#F59E0B',
    history: '#3B82F6',
    free: '#16A34A',
});

function finiteNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function tokenInt(value) {
    return Math.max(0, Math.round(finiteNumber(value, 0)));
}

function formatTokens(value) {
    const n = tokenInt(value);
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function getLiveContext() {
    try {
        return globalThis.SillyTavern?.getContext?.() ?? context;
    } catch {
        return context;
    }
}

function getChatId() {
    try {
        const live = getLiveContext();
        return String(live?.chatId ?? core?.getCurrentChatId?.() ?? '');
    } catch {
        return '';
    }
}

function storageKey(chatId) {
    return STORAGE_PREFIX + encodeURIComponent(chatId);
}

function saveSnapshot(snapshot) {
    const chatId = snapshot?.chatId || getChatId();
    if (!chatId) return;

    try {
        localStorage.setItem(storageKey(chatId), JSON.stringify({
            ...snapshot,
            chatId,
            savedAt: Date.now(),
        }));
    } catch (error) {
        console.debug(`[${MODULE_NAME}] Could not save snapshot`, error);
    }
}

function loadSnapshot(chatId) {
    if (!chatId) return null;

    try {
        const raw = localStorage.getItem(storageKey(chatId));
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

function truncationStorageKey(chatId) {
    return TRUNCATION_STORAGE_PREFIX + encodeURIComponent(chatId);
}

function saveTruncationState(boundary) {
    const chatId = getChatId();
    if (!chatId) return;

    try {
        localStorage.setItem(truncationStorageKey(chatId), JSON.stringify({
            boundary: tokenInt(boundary),
            savedAt: Date.now(),
        }));
    } catch (error) {
        console.debug(`[${MODULE_NAME}] Could not save truncation indicator state`, error);
    }
}

function loadTruncationBoundary(chatId = getChatId()) {
    if (!chatId) return 0;

    try {
        const raw = localStorage.getItem(truncationStorageKey(chatId));
        if (!raw) return 0;
        const parsed = JSON.parse(raw);
        return tokenInt(parsed?.boundary ?? 0);
    } catch {
        return 0;
    }
}

function isMobileLayout() {
    try {
        return mobileLayoutMedia?.matches ?? globalThis.matchMedia?.(MOBILE_LAYOUT_QUERY)?.matches ?? globalThis.innerWidth <= 1000;
    } catch {
        return globalThis.innerWidth <= 1000;
    }
}

function placeBarForCurrentLayout(bar) {
    if (!bar) return;

    const sheld = document.getElementById('sheld');
    const mobileHosted = isMobileLayout() && Boolean(sheld);

    // Desktop reserves space with #sheld padding because the bar is fixed to
    // the viewport. Mobile SillyTavern changes the page positioning model, so
    // put the bar into #sheld as a real final flex row instead.
    sheld?.classList.toggle('cmb-mobile-bar-host', mobileHosted);
    bar.classList.toggle('cmb-mobile-layout', mobileHosted);

    const target = mobileHosted ? sheld : document.body;
    if (target && bar.parentElement !== target) {
        target.appendChild(bar);
    }
}

function syncBarPlacement() {
    placeBarForCurrentLayout(document.getElementById('context-memory-bar'));
}

function bindResponsiveBarPlacement() {
    try {
        mobileLayoutMedia = globalThis.matchMedia?.(MOBILE_LAYOUT_QUERY) ?? null;
        const onLayoutChange = () => syncBarPlacement();

        if (mobileLayoutMedia?.addEventListener) {
            mobileLayoutMedia.addEventListener('change', onLayoutChange);
        } else if (mobileLayoutMedia?.addListener) {
            // Older mobile WebKit / embedded browsers.
            mobileLayoutMedia.addListener(onLayoutChange);
        }

        globalThis.addEventListener?.('orientationchange', onLayoutChange, { passive: true });
    } catch (error) {
        console.debug(`[${MODULE_NAME}] Could not bind responsive bar placement`, error);
    }

    syncBarPlacement();
}

function ensureBar() {
    let bar = document.getElementById('context-memory-bar');
    if (bar) {
        placeBarForCurrentLayout(bar);
        return bar;
    }

    bar = document.createElement('div');
    bar.id = 'context-memory-bar';
    bar.setAttribute('aria-hidden', 'true');
    bar.innerHTML = `
        <div class="cmb-segment cmb-segment-main" data-part="main"><span class="cmb-number">0</span></div>
        <div class="cmb-segment cmb-segment-character" data-part="character"><span class="cmb-number">0</span></div>
        <div class="cmb-segment cmb-segment-history" data-part="history"><span class="cmb-number">0</span></div>
        <div class="cmb-segment cmb-segment-free" data-part="free"><span class="cmb-number">0</span></div>
        <div class="cmb-total">0 / 0</div>
    `;
    document.body.appendChild(bar);
    placeBarForCurrentLayout(bar);
    return bar;
}

function normalizeBuckets({ used, maxContext, character, history }) {
    used = tokenInt(used);
    maxContext = tokenInt(maxContext);
    character = tokenInt(character);
    history = tokenInt(history);

    // Character and history are sub-buckets of used tokens. Clamp only as a
    // defensive measure against old/incomplete Prompt Itemization records.
    character = Math.min(character, used);
    history = Math.min(history, Math.max(0, used - character));

    const main = Math.max(0, used - character - history);
    const free = Math.max(0, maxContext - used);

    return { main, character, history, free, used, maxContext };
}

function render(snapshot) {
    const bar = ensureBar();
    const data = normalizeBuckets(snapshot);

    // Normally the denominator is the configured context window. If a provider
    // reports an over-limit prompt, use the larger value only for drawing so the
    // bar does not overflow its viewport; the displayed denominator stays the
    // configured context size.
    const scale = Math.max(1, data.maxContext, data.used);

    for (const part of ['main', 'character', 'history', 'free']) {
        const element = bar.querySelector(`[data-part="${part}"]`);
        if (!element) continue;
        const tokens = data[part];
        element.style.width = `${(tokens / scale) * 100}%`;
        const label = element.querySelector('.cmb-number');
        if (label) label.textContent = formatTokens(tokens);
    }

    const total = bar.querySelector('.cmb-total');
    if (total) {
        const warning = currentHistoryTruncated ? '⚠ ' : '';
        total.textContent = `${warning}${formatTokens(data.used)} / ${formatTokens(data.maxContext)}`;
        total.classList.toggle('cmb-total-truncated', currentHistoryTruncated);
    }
}

function getCurrentMaxContext(item = null) {
    try {
        const n = finiteNumber(core?.getMaxContextTokens?.(), 0);
        if (n > 0) return n;
    } catch {
        // fall through
    }

    const fromItem = finiteNumber(item?.this_max_context, 0);
    if (fromItem > 0) return fromItem;

    const selectors = ['#openai_max_context', '#max_context'];
    for (const selector of selectors) {
        const el = document.querySelector(selector);
        const n = finiteNumber(el?.value, 0);
        if (n > 0) return n;
    }

    return 0;
}

function latestItemizedPrompt() {
    const prompts = itemizedModule?.itemizedPrompts;
    if (!Array.isArray(prompts) || prompts.length === 0) return null;

    const valid = prompts.filter(x => x && x.rawPrompt != null);
    if (!valid.length) return null;

    return valid.reduce((best, item) => {
        if (!best) return item;
        const a = finiteNumber(best.mesId, -1);
        const b = finiteNumber(item.mesId, -1);
        return b >= a ? item : best;
    }, null);
}

async function countPlainText(text) {
    if (typeof text !== 'string' || !text.length) return 0;
    try {
        return tokenInt(await tokenizersModule.getTokenCountAsync(text, 0));
    } catch {
        return 0;
    }
}

function exactLiveOpenAISnapshot() {
    const pm = openaiModule?.promptManager;
    if (!pm?.tokenHandler || !pm?.messages) return null;

    const counts = pm.tokenHandler.getCounts?.();
    const used = finiteNumber(pm.tokenUsage, 0);
    if (!counts || used <= 0) return null;

    const character =
        finiteNumber(counts.charDescription, 0) +
        finiteNumber(counts.charPersonality, 0) +
        finiteNumber(counts.personaDescription, 0);

    // Prompt Manager may split the ordinary chat history between the
    // `conversation` and `chatHistory` collections. Count both.
    const history =
        finiteNumber(counts.conversation, 0) +
        finiteNumber(counts.chatHistory, 0);
    const maxContext = getCurrentMaxContext();

    if (maxContext <= 0) return null;

    return normalizeBuckets({
        used,
        maxContext,
        character,
        history,
    });
}

async function snapshotFromItemized(item) {
    if (!item) return null;

    const prompts = itemizedModule.itemizedPrompts;
    const index = prompts.indexOf(item);
    let params = null;

    if (index >= 0) {
        try {
            params = await itemizedModule.itemizedParams(prompts, index, Number(item.mesId));
        } catch (error) {
            console.debug(`[${MODULE_NAME}] Prompt Itemization fallback failed`, error);
        }
    }

    const isOpenAI = item.main_api === 'openai';
    let used = 0;
    let history = 0;

    if (isOpenAI) {
        used = finiteNumber(item.oaiTotalTokens, 0);
        history = finiteNumber(item.oaiConversationTokens, 0);
    } else {
        used = finiteNumber(params?.finalPromptTokens, 0);
        history = finiteNumber(params?.ActualChatHistoryTokens, 0);
    }

    // Fallback for older/incomplete records.
    if (used <= 0) {
        if (isOpenAI && Array.isArray(item.rawPrompt)) {
            try {
                used = tokenInt(await tokenizersModule.countTokensOpenAIAsync(item.rawPrompt, true));
            } catch {
                used = 0;
            }
        } else if (typeof item.finalPrompt === 'string') {
            used = await countPlainText(item.finalPrompt);
        }
    }

    const charDescription = finiteNumber(params?.charDescriptionTokens, await countPlainText(item.charDescription || ''));
    const charPersonality = finiteNumber(params?.charPersonalityTokens, await countPlainText(item.charPersonality || ''));
    const personaDescription = finiteNumber(params?.userPersonaStringTokens, await countPlainText(item.userPersona || ''));
    const character = charDescription + charPersonality + personaDescription;

    const maxContext = getCurrentMaxContext(item);
    if (maxContext <= 0) return null;

    return normalizeBuckets({ used, maxContext, character, history });
}

function snapshotMatchesItem(saved, item) {
    if (!saved || !item) return false;
    if (String(saved.mesId) !== String(item.mesId)) return false;

    const itemUsed = finiteNumber(item.oaiTotalTokens, 0);
    if (itemUsed > 0 && Math.abs(finiteNumber(saved.used, -999999) - itemUsed) > 2) {
        return false;
    }

    return true;
}

async function refresh() {
    const serial = ++refreshSerial;
    const chatId = getChatId();
    const item = latestItemizedPrompt();

    let snapshot = null;

    // While a Chat Completion request is being prepared, this is the most exact
    // source: Prompt Manager retains per-collection token counts.
    if (liveSnapshot?.chatId === chatId) {
        snapshot = liveSnapshot;
    }

    // For the last completed generation, prefer the exact snapshot captured from
    // Prompt Manager, but only when it matches the latest persisted prompt item.
    if (!snapshot && chatId && item) {
        const saved = loadSnapshot(chatId);
        if (snapshotMatchesItem(saved, item)) {
            snapshot = saved;
        }
    }

    // Generic/persisted fallback. Works for Text Completion and for old chats
    // created before this extension was installed.
    if (!snapshot && item) {
        snapshot = await snapshotFromItemized(item);
    }

    if (serial !== refreshSerial) return;

    if (!snapshot) {
        const maxContext = getCurrentMaxContext();
        snapshot = normalizeBuckets({
            used: 0,
            maxContext,
            character: 0,
            history: 0,
        });
    }

    render(snapshot);
}

async function onChatCompletionPromptReady(eventData) {
    if (eventData?.dryRun) return;

    const exact = exactLiveOpenAISnapshot();
    if (!exact) return;

    liveSnapshot = {
        ...exact,
        chatId: getChatId(),
        mesId: null,
        source: 'prompt-manager',
    };

    render(liveSnapshot);
}

async function onItemizedSaved() {
    const item = latestItemizedPrompt();
    const chatId = getChatId();

    if (liveSnapshot && item && liveSnapshot.chatId === chatId) {
        const itemUsed = finiteNumber(item.oaiTotalTokens, 0);
        const samePrompt = itemUsed <= 0 || Math.abs(itemUsed - liveSnapshot.used) <= 2;

        if (samePrompt) {
            liveSnapshot = {
                ...liveSnapshot,
                mesId: item.mesId,
            };
            saveSnapshot(liveSnapshot);
        }
    }

    await refresh();
}


function getChatMetadata() {
    // SillyTavern explicitly warns extensions not to retain chatMetadata across
    // chat switches. Always ask getContext() for the current object.
    const live = getLiveContext();
    return live?.chatMetadata ?? live?.chat_metadata ?? core?.chat_metadata ?? {};
}

function getChatIdentity() {
    // The concrete chat/session id is the safest branch key: every Branch is
    // stored as a separate chat file/session, while some SillyTavern versions
    // historically copied `integrity` from the parent into the child branch.
    const chatId = getChatId();
    if (chatId) return `chat:${chatId}`;

    // Fallback only for unusual frontends where the current chat id is not
    // exposed yet. Editing/deleting messages does not normally change this.
    const integrity = String(getChatMetadata()?.integrity ?? '').trim();
    if (integrity) return `integrity:${integrity}`;
    return '';
}

function getSharedExtensionState(create = false) {
    try {
        const allSettings = getLiveContext()?.extensionSettings;
        if (!allSettings || typeof allSettings !== 'object') return null;

        if (!allSettings[MODULE_NAME] && create) {
            allSettings[MODULE_NAME] = {};
        }

        const moduleSettings = allSettings[MODULE_NAME];
        if (!moduleSettings || typeof moduleSettings !== 'object') return null;

        if (!moduleSettings.warningStateV2 && create) {
            moduleSettings.warningStateV2 = { warnings: {} };
        }

        return moduleSettings.warningStateV2 ?? null;
    } catch {
        return null;
    }
}

function persistSharedExtensionState() {
    try {
        getLiveContext()?.saveSettingsDebounced?.();
    } catch (error) {
        console.debug(`[${MODULE_NAME}] Could not persist shared extension state`, error);
    }
}

/**
 * One warning cycle per concrete chat file / branch.
 *
 * Every Branch is a separate chat/session, so `chatId` is used as the primary
 * warning key. This remains correct even on SillyTavern builds where a child
 * branch inherits the parent's `integrity` metadata. Editing or deleting
 * messages inside the branch keeps the same chatId; creating a new Branch gets
 * a different chatId and therefore a fresh warning state.
 */
function getCurrentWarningScopeId() {
    return getChatIdentity();
}

function warningStorageKey(scopeId) {
    return WARNING_STORAGE_PREFIX + encodeURIComponent(scopeId);
}

function loadWarningState(scopeId) {
    if (!scopeId) return null;

    const shared = getSharedExtensionState(false);
    const serverState = shared?.warnings?.[scopeId];
    if (serverState && typeof serverState === 'object') return serverState;

    try {
        const raw = localStorage.getItem(warningStorageKey(scopeId));
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

function saveWarningState(scopeId, state) {
    if (!scopeId) return;

    const value = {
        ...state,
        scopeId,
        savedAt: Date.now(),
    };

    const shared = getSharedExtensionState(true);
    if (shared) {
        shared.warnings ||= {};
        shared.warnings[scopeId] = value;
        persistSharedExtensionState();
        return;
    }

    try {
        localStorage.setItem(warningStorageKey(scopeId), JSON.stringify(value));
    } catch (error) {
        console.debug(`[${MODULE_NAME}] Could not save warning state`, error);
    }
}

function readHistoryBoundary() {
    const boundary = tokenInt(getChatMetadata()?.lastInContextMessageId ?? 0);
    return boundary;
}

function showHistoryTruncatedWarning() {
    const message = 'Начало истории больше не помещается в контекст. Первые сообщения больше не передаются модели как часть обычной истории.';
    const title = 'Context Memory Bar';

    try {
        if (globalThis.toastr?.warning) {
            globalThis.toastr.warning(message, title, {
                timeOut: 9000,
                extendedTimeOut: 3000,
                preventDuplicates: true,
                closeButton: true,
            });
            return;
        }
    } catch (error) {
        console.debug(`[${MODULE_NAME}] Could not show toastr warning`, error);
    }

    console.warn(`[${MODULE_NAME}] ${message}`);
}

function updateTruncationIndicator(boundary) {
    currentHistoryBoundary = tokenInt(boundary);
    currentHistoryTruncated = currentHistoryBoundary > 0;

    // Re-render the current bar without changing token data. This adds/removes
    // the persistent ⚠ marker next to "used / max" for the latest built prompt.
    const bar = document.getElementById('context-memory-bar');
    const total = bar?.querySelector('.cmb-total');
    if (total) {
        const text = total.textContent?.replace(/^⚠\s*/, '') ?? '';
        total.textContent = currentHistoryTruncated ? `⚠ ${text}` : text;
        total.classList.toggle('cmb-total-truncated', currentHistoryTruncated);
    }
}

function onGenerationStarted(type, _options, dryRun) {
    activeGenerationType = String(type ?? '');
    activeGenerationDryRun = Boolean(dryRun);
}

async function onGenerateAfterData(_generateData, dryRun) {
    const isDryRun = Boolean(dryRun) || activeGenerationDryRun;
    const isQuiet = activeGenerationType === 'quiet';
    if (isDryRun || isQuiet) return;

    // `setInContextMessages()` runs before GENERATE_AFTER_DATA in SillyTavern,
    // so this value describes the user-facing prompt that is about to be sent.
    const boundary = readHistoryBoundary();
    saveTruncationState(boundary);
    updateTruncationIndicator(boundary);
    if (boundary <= 0) return;

    const scopeId = getCurrentWarningScopeId();
    if (!scopeId) return;

    const state = loadWarningState(scopeId) || { warned: false };
    if (state.warned) return;

    // Persist before showing the toast, so repeated/re-entrant generation events
    // cannot display the one-time warning twice.
    const nextState = {
        ...state,
        warned: true,
        firstBoundary: boundary,
        firstChatId: getChatId(),
        firstDropAt: Date.now(),
    };
    saveWarningState(scopeId, nextState);
    showHistoryTruncatedWarning();

    console.info(`[${MODULE_NAME}] first chat-history truncation detected`, {
        chatId: getChatId(),
        scopeId,
        boundary,
    });
}

function bindEvent(name, handler) {
    const type = context?.eventTypes?.[name];
    if (!type) return;
    context.eventSource.on(type, handler);
}

async function boot() {
    if (started) return;
    started = true;

    try {
        context = SillyTavern.getContext();
        [core, itemizedModule, openaiModule, tokenizersModule] = await Promise.all([
            import('/script.js'),
            import('/scripts/itemized-prompts.js'),
            import('/scripts/openai.js'),
            import('/scripts/tokenizers.js'),
        ]);

        ensureBar();
        bindResponsiveBarPlacement();

        bindEvent('GENERATION_STARTED', onGenerationStarted);
        bindEvent('GENERATE_AFTER_DATA', onGenerateAfterData);
        bindEvent('CHAT_COMPLETION_PROMPT_READY', onChatCompletionPromptReady);
        bindEvent('ITEMIZED_PROMPTS_SAVED', onItemizedSaved);
        bindEvent('ITEMIZED_PROMPTS_LOADED', async () => {
            liveSnapshot = null;
            await refresh();
        });
        bindEvent('ITEMIZED_PROMPTS_DELETED', async () => {
            liveSnapshot = null;
            await refresh();
        });
        bindEvent('CHAT_CHANGED', async () => {
            liveSnapshot = null;
            activeGenerationType = null;
            activeGenerationDryRun = false;
            updateTruncationIndicator(loadTruncationBoundary());
            await refresh();
        });
        bindEvent('MESSAGE_RECEIVED', refresh);
        bindEvent('MESSAGE_EDITED', refresh);
        bindEvent('MESSAGE_UPDATED', refresh);
        bindEvent('MESSAGE_SWIPED', refresh);
        bindEvent('MESSAGE_DELETED', refresh);
        bindEvent('OAI_PRESET_CHANGED_AFTER', refresh);
        bindEvent('PRESET_CHANGED', refresh);
        bindEvent('MAIN_API_CHANGED', refresh);
        bindEvent('SETTINGS_UPDATED', refresh);

        updateTruncationIndicator(loadTruncationBoundary());
        await refresh();
        console.info(`[${MODULE_NAME}] loaded v1.1.2`, COLORS);
    } catch (error) {
        started = false;
        console.error(`[${MODULE_NAME}] failed to initialize`, error);
    }
}

function startWhenReady() {
    try {
        const ctx = globalThis.SillyTavern?.getContext?.();
        const appReady = ctx?.eventTypes?.APP_READY;
        if (ctx?.eventSource && appReady) {
            ctx.eventSource.on(appReady, () => setTimeout(() => void boot(), 0));
            // Also schedule once now. boot() is idempotent, so this covers an
            // extension enabled after APP_READY without blocking ST startup.
            setTimeout(() => void boot(), 0);
            return;
        }
    } catch {
        // fall back to DOM ready
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => void boot(), { once: true });
    } else {
        void boot();
    }
}

startWhenReady();
