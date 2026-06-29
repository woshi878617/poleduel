// ── State ────────────────────────────────────────────────
let topics = [];
let userTopics = [];
let currentIndex = 0;
let isAnimating = false;
let authToken = null;
let currentUser = null;
let favoriteIds = new Set(); // Set of "preset:ID" or "user:ID" strings

// ── Country flag mapping ─────────────────────────────────
const COUNTRY_FLAGS = {
    'China': '🇨🇳', 'United States': '🇺🇸', 'Japan': '🇯🇵', 'South Korea': '🇰🇷',
    'United Kingdom': '🇬🇧', 'France': '🇫🇷', 'Germany': '🇩🇪', 'Canada': '🇨🇦',
    'Australia': '🇦🇺', 'India': '🇮🇳', 'Brazil': '🇧🇷', 'Russia': '🇷🇺',
    'Italy': '🇮🇹', 'Spain': '🇪🇸', 'Mexico': '🇲🇽', 'Netherlands': '🇳🇱',
    'Sweden': '🇸🇪', 'Switzerland': '🇨🇭', 'Singapore': '🇸🇬', 'Hong Kong': '🇭🇰',
    'Taiwan': '🇹🇼', 'Thailand': '🇹🇭', 'Vietnam': '🇻🇳', 'Indonesia': '🇮🇩',
    'Malaysia': '🇲🇾', 'Philippines': '🇵🇭', 'Turkey': '🇹🇷', 'Poland': '🇵🇱',
    'Ukraine': '🇺🇦', 'Argentina': '🇦🇷', 'Chile': '🇨🇱', 'Colombia': '🇨🇴',
    'South Africa': '🇿🇦', 'Egypt': '🇪🇬', 'Nigeria': '🇳🇬', 'Saudi Arabia': '🇸🇦',
    'United Arab Emirates': '🇦🇪', 'Israel': '🇮🇱', 'Portugal': '🇵🇹',
    'Belgium': '🇧🇪', 'Austria': '🇦🇹', 'Denmark': '🇩🇰', 'Norway': '🇳🇴',
    'Finland': '🇫🇮', 'Ireland': '🇮🇪', 'New Zealand': '🇳🇿', 'Czechia': '🇨🇿',
    'Greece': '🇬🇷', 'Romania': '🇷🇴', 'Hungary': '🇭🇺', 'Pakistan': '🇵🇰',
    'Bangladesh': '🇧🇩', 'Iran': '🇮🇷', 'Iraq': '🇮🇶', 'Kazakhstan': '🇰🇿',
    'Peru': '🇵🇪', 'Venezuela': '🇻🇪', 'Morocco': '🇲🇦', 'Kenya': '🇰🇪'
};

function getCountryFlag(country) {
    return COUNTRY_FLAGS[country] || '';
}

// ── DOM refs ────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const cardStack = $('#cardStack');
const progressLabel = $('#progressLabel');
const userArea = $('#userArea');
const loginBtn = $('#loginBtn');
const loginModal = $('#loginModal');
const guestLoginBtn = $('#guestLoginBtn');
const googleBtnContainer = $('#googleBtnContainer');
const closeLoginBtn = $('#closeLoginBtn');
const createPollTab = $('#createPollTab');
const myPollsBtn = $('#myPollsBtn');
const historyBtn = $('#historyBtn');
const favoritesBtn = $('#favoritesBtn');

// Tabs
const tabBtns = $$('.tab-btn');
const tabContents = $$('.tab-content');

// ── Lang change callback ─────────────────────────────────
window._onLangChange = function(newLang) {
    const btn = document.getElementById('langSwitchBtn');
    if (btn) {
        btn.textContent = newLang === 'en' ? '中文' : 'EN';
    }
    // Re-apply category select options
    updateCategorySelect();
    // Re-render all dynamic content
    renderCards();
    if ($('#myPollsPanel').classList.contains('open')) loadMyPolls();
    if ($('#historyPanel').classList.contains('open')) loadHistory();
    if ($('#favoritesPanel').classList.contains('open')) loadFavorites();
    if ($('#tab-create').classList.contains('active')) fetchDailyRemaining();
    updateUIForAuth();
};

function updateCategorySelect() {
    const sel = $('#pollCategory');
    if (!sel) return;
    const cats = ['General','Sports','World','Technology','Economy','Environment','Science','Society'];
    const currentVal = sel.value;
    sel.innerHTML = cats.map(c => {
        const t = I18N.getCategoryKey(c);
        return `<option value="${c}">${t}</option>`;
    }).join('');
    sel.value = currentVal;
}

// ── Init ─────────────────────────────────────────────────
async function init() {
    // Init i18n first
    await I18N.init();

    // Set lang switch button initial text
    const langBtn = document.getElementById('langSwitchBtn');
    if (langBtn) {
        langBtn.textContent = I18N.getLang() === 'en' ? '中文' : 'EN';
    }

    // Update category select with i18n labels
    updateCategorySelect();

    // Restore auth from localStorage
    const saved = localStorage.getItem('vote_site_auth');
    if (saved) {
        try {
            const parsed = JSON.parse(saved);
            authToken = parsed.token;
            currentUser = parsed.user;
            updateUIForAuth();
        } catch(e) { /* ignore */ }
    }

    // Load topics
    const res = await fetch('/api/topics');
    topics = await res.json();
    currentIndex = 0;
    renderCards();
    loadAllTopicStats();

    // Tab switching
    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    // Login modal
    loginBtn.addEventListener('click', () => loginModal.classList.remove('hidden'));
    closeLoginBtn.addEventListener('click', () => loginModal.classList.add('hidden'));
    guestLoginBtn.addEventListener('click', guestLogin);

    // Nav
    $('#prevBtn').addEventListener('click', () => navigate(-1));
    $('#nextBtn').addEventListener('click', () => navigate(1));

    // Panels
    historyBtn.addEventListener('click', toggleHistoryPanel);
    myPollsBtn.addEventListener('click', toggleMyPollsPanel);
    favoritesBtn.addEventListener('click', toggleFavoritesPanel);
    $('#closeHistoryBtn').addEventListener('click', closeHistoryPanel);
    $('#closeMyPollsBtn').addEventListener('click', closeMyPollsPanel);
    $('#closeFavoritesBtn').addEventListener('click', closeFavoritesPanel);
    $('#historyOverlay').addEventListener('click', closeHistoryPanel);
    $('#myPollsOverlay').addEventListener('click', closeMyPollsPanel);
    $('#favoritesOverlay').addEventListener('click', closeFavoritesPanel);

    // Country stats modal
    $('#closeCountryStatsBtn').addEventListener('click', closeCountryStats);
    $('#countryStatsOverlay').addEventListener('click', (e) => {
        if (e.target === $('#countryStatsOverlay')) closeCountryStats();
    });

    // Create poll form
    $('#addOptionBtn').addEventListener('click', addOptionRow);
    $('#submitPollBtn').addEventListener('click', submitPoll);
    updateOptionRemoveButtons();
}

function updateUIForAuth() {
    if (currentUser) {
        let guestBindHtml = '';
        if (currentUser.auth_type === 'guest') {
            guestBindHtml = `<div id="googleBindContainer" style="margin-left:8px;display:inline-block;"></div>`;
        }
        userArea.innerHTML = `
            <div class="user-info">
                ${currentUser.avatar_url ? `<img src="${currentUser.avatar_url}" alt="">` : ''}
                <span>${escapeHtml(currentUser.display_name)}</span>
                ${guestBindHtml}
                <button class="btn-login" onclick="logout()" style="margin-left:8px;font-size:12px;">${I18N.t('sign_out')}</button>
            </div>`;
        createPollTab.classList.remove('hidden');
        myPollsBtn.classList.remove('hidden');
        favoritesBtn.classList.remove('hidden');
        // Load favorites and init Google bind for guest
        loadFavoriteStates();
        if (currentUser.auth_type === 'guest') {
            setTimeout(initGoogleBindBtn, 200);
        }
    } else {
        userArea.innerHTML = `<button id="loginBtn" class="btn-login">${I18N.t('sign_in')}</button>`;
        document.getElementById('loginBtn').addEventListener('click', () => loginModal.classList.remove('hidden'));
        createPollTab.classList.add('hidden');
        myPollsBtn.classList.add('hidden');
        favoritesBtn.classList.add('hidden');
        favoriteIds.clear();
    }
}

// ── Auth ────────────────────────────────────────────────
async function guestLogin() {
    try {
        const res = await fetch('/api/auth/guest', { method: 'POST' });
        const data = await res.json();
        if (data.token) {
            setAuth(data.token, data.user);
            loginModal.classList.add('hidden');
        }
    } catch(e) {
        alert(I18N.t('login_failed'));
    }
}

async function googleLogin(credential) {
    try {
        const res = await fetch('/api/auth/google', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ credential })
        });
        const data = await res.json();
        if (data.token) {
            setAuth(data.token, data.user);
            loginModal.classList.add('hidden');
        } else {
            alert(I18N.t('google_login_failed', { error: data.error || 'Unknown error' }));
        }
    } catch(e) {
        alert(I18N.t('login_failed'));
    }
}

function setAuth(token, user) {
    authToken = token;
    currentUser = user;
    localStorage.setItem('vote_site_auth', JSON.stringify({ token, user }));
    updateUIForAuth();
}

async function loadFavoriteStates() {
    if (!authToken) return;
    try {
        const res = await fetch('/api/favorites', { headers: authHeaders() });
        if (res.ok) {
            const favs = await res.json();
            favoriteIds = new Set(favs.map(f => `${f.topic_type}:${f.topic_id}`));
            renderCards();
        }
    } catch(e) { /* ignore */ }
}

function logout() {
    authToken = null;
    currentUser = null;
    localStorage.removeItem('vote_site_auth');
    updateUIForAuth();
    if ($('#tab-create').classList.contains('active')) {
        switchTab('preset');
    }
}

function authHeaders() {
    return authToken ? { 'Authorization': `Bearer ${authToken}` } : {};
}

// ── Google Identity Services ────────────────────────────
function initGoogleBtn() {
    if (!window.GOOGLE_CLIENT_ID) {
        googleBtnContainer.innerHTML = `<p style="color:var(--text-dim);font-size:12px;">${I18N.t('google_not_configured')}</p>`;
        return;
    }
    google.accounts.id.initialize({
        client_id: window.GOOGLE_CLIENT_ID,
        callback: (response) => googleLogin(response.credential),
        auto_select: false,
    });
    google.accounts.id.renderButton(googleBtnContainer, {
        theme: 'filled_black',
        size: 'large',
        width: '100%',
        text: 'signin_with',
        shape: 'rectangular',
    });
}

function initGoogleBindBtn() {
    if (!window.GOOGLE_CLIENT_ID) return;
    const container = document.getElementById('googleBindContainer');
    if (!container) return;
    container.innerHTML = '';
    google.accounts.id.initialize({
        client_id: window.GOOGLE_CLIENT_ID,
        callback: (response) => bindGoogle(response.credential),
        auto_select: false,
    });
    google.accounts.id.renderButton(container, {
        theme: 'filled_black',
        size: 'small',
        text: 'signin_with',
        shape: 'rectangular',
    });
}

async function bindGoogle(credential) {
    try {
        const res = await fetch('/api/auth/bind-google', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ credential })
        });
        const data = await res.json();
        if (data.token) {
            setAuth(data.token, data.user);
        } else {
            alert(I18N.t('bind_failed', { error: data.error || 'Unknown error' }));
        }
    } catch(e) {
        alert(I18N.t('bind_failed_try_again'));
    }
}

// ── Tab switching ───────────────────────────────────────
function switchTab(tab) {
    if (tab === 'create' && !currentUser) {
        loginModal.classList.remove('hidden');
        return;
    }

    tabBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    tabContents.forEach(c => c.classList.toggle('active', c.id === `tab-${tab}`));

    if (tab === 'create') resetCreateForm();
}

// ── Card Stack ──────────────────────────────────────────
function renderCards() {
    cardStack.innerHTML = '';
    if (topics.length === 0) {
        cardStack.innerHTML = `<p class="empty-msg">${I18N.t('no_topics')}</p>`;
        return;
    }

    topics.forEach((t, i) => {
        const card = document.createElement('div');
        card.className = 'vote-card';
        if (i === currentIndex) card.classList.add('active');
        else if (i === currentIndex - 1) card.classList.add('prev');
        else if (i === currentIndex + 1) card.classList.add('next');

        const isFav = favoriteIds.has(`preset:${t.id}`);
        const catTranslated = I18N.getCategoryKey(t.category);
        const favTitle = I18N.t(isFav ? 'unfavorite' : 'favorite');

        card.innerHTML = `
            <div class="card-category">
                ${escapeHtml(catTranslated)}
                <button class="btn-fav ${isFav ? 'faved' : ''}" onclick="toggleFavorite('preset', ${t.id})" title="${favTitle}">${isFav ? '★' : '☆'}</button>
            </div>
            <div class="card-question">${escapeHtml(t.question)}</div>
            <div class="card-options">
                ${t.options.map((opt, oi) => `
                    <button class="card-option ${t.voted ? 'voted' : ''} ${t._chosen === oi ? 'chosen' : ''}"
                            data-topic="${t.id}" data-option="${oi}"
                            ${t.voted ? 'disabled' : ''}>
                        ${escapeHtml(opt)}
                    </button>
                `).join('')}
            </div>
            <div class="card-stats" style="display:${t.voted || t._chosen !== undefined ? 'block' : 'none'}">
                ${(t._stats || []).map(s => `
                    <div class="stat-bar-row">
                        <span class="stat-label">${escapeHtml(s.option || '')}</span>
                        <div class="stat-bar-track"><div class="stat-bar-fill" style="width:${t.total ? (s.count/t.total*100) : 0}%"></div></div>
                        <span class="stat-count">${s.count || 0}</span>
                    </div>
                `).join('')}
            </div>
            <div class="card-country-stats" style="display:${(t._country_stats && t._country_stats.length > 0) ? 'block' : 'none'}">
                ${renderCountryStats(t._country_stats || [])}
            </div>
            <div class="card-comments" id="comments-${t.id}">
                <div class="comments-loading">${I18N.t('loading_comments')}</div>
            </div>
            <div class="card-actions">
                <button class="btn-push" data-topic="${t.id}" data-action="push">${I18N.t('push')}</button>
                <span class="card-heat" id="heat-${t.id}">${t.heat || 100}</span>
                <button class="btn-skip" data-topic="${t.id}" data-action="skip">${I18N.t('skip')}</button>
            </div>`;

        cardStack.appendChild(card);

        // Vote click
        card.querySelectorAll('.card-option').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (isAnimating) return;
                const tid = parseInt(btn.dataset.topic);
                const oi = parseInt(btn.dataset.option);
                await handleVote(tid, oi);
            });
        });

        // Push click
        const pushBtn = card.querySelector('.btn-push');
        if (pushBtn) {
            pushBtn.addEventListener('click', async () => {
                if (isAnimating) return;
                const tid = parseInt(pushBtn.dataset.topic);
                await handlePush(tid, pushBtn);
            });
        }

        // Skip click
        const skipBtn = card.querySelector('.btn-skip');
        if (skipBtn) {
            skipBtn.addEventListener('click', async () => {
                if (isAnimating) return;
                const tid = parseInt(skipBtn.dataset.topic);
                await handleSkip(tid);
            });
        }
    });

    progressLabel.textContent = `${currentIndex + 1} / ${topics.length}`;

    // Load comments for each topic
    topics.forEach(t => fetchComments(t.id));
}

async function handleVote(topicId, optionIndex) {
    try {
        const res = await fetch('/api/vote', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ topic_id: topicId, option_index: optionIndex })
        });
        const data = await res.json();

        if (data.success) {
            const topic = topics.find(t => t.id === topicId);
            if (topic) {
                topic.voted = true;
                topic._chosen = optionIndex;
                topic.heat = (topic.heat || 100) + 2;
                const sr = await fetch(`/api/topics/${topicId}/stats`);
                const statsData = await sr.json();
                topic._stats = statsData.option_stats.map(s => ({ option: s.option_text, count: s.count }));
                topic._country_stats = statsData.country_stats || [];
                topic.total = statsData.total;
            }
            renderCards();

            setTimeout(() => {
                if (currentIndex < topics.length - 1) {
                    navigate(1);
                }
            }, 1500);
        } else {
            alert(data.error || I18N.t('vote_failed'));
        }
    } catch(e) {
        alert(I18N.t('network_error'));
    }
}

async function handlePush(topicId, buttonEl) {
    if (!authToken) {
        alert(I18N.t('please_sign_in_push'));
        loginModal.classList.remove('hidden');
        return;
    }
    try {
        const res = await fetch(`/api/topics/${topicId}/push`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        const data = await res.json();
        if (data.success) {
            const topic = topics.find(t => t.id === topicId);
            if (topic) topic.heat = data.heat;
            buttonEl.textContent = I18N.t('pushed');
            buttonEl.disabled = true;
            buttonEl.classList.add('pushed');
            const heatEl = document.getElementById(`heat-${topicId}`);
            if (heatEl) heatEl.textContent = data.heat;
        } else if (res.status === 429) {
            buttonEl.textContent = I18N.t('pushed');
            buttonEl.disabled = true;
            buttonEl.classList.add('pushed');
        } else {
            alert(data.error || I18N.t('push_failed'));
        }
    } catch(e) {
        alert(I18N.t('network_error'));
    }
}

async function handleSkip(topicId) {
    try {
        const res = await fetch(`/api/topics/${topicId}/skip`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        const data = await res.json();
        if (data.success) {
            const topic = topics.find(t => t.id === topicId);
            if (topic) topic.heat = data.heat;
            if (currentIndex < topics.length - 1) {
                navigate(1);
            }
        }
    } catch(e) {
        if (currentIndex < topics.length - 1) {
            navigate(1);
        }
    }
}

// ── Comments ────────────────────────────────────────────
let commentsCache = {}; // topicId -> { comments, expanded }

async function fetchComments(topicId) {
    const container = document.getElementById(`comments-${topicId}`);
    if (!container) return;
    try {
        const res = await fetch(`/api/topics/${topicId}/comments`);
        const comments = await res.json();
        commentsCache[topicId] = { comments, expanded: false };
        renderComments(topicId, container);
    } catch(e) {
        container.innerHTML = '';
    }
}

function renderComments(topicId, container) {
    const cached = commentsCache[topicId];
    if (!cached) return;
    const { comments, expanded } = cached;
    if (comments.length === 0) {
        container.innerHTML = `<div class="comments-empty">${I18N.t('no_replies')}</div>`;
    } else {
        const maxShow = expanded ? comments.length : Math.min(3, comments.length);
        const visible = comments.slice(0, maxShow);
        const html = visible.map(c => `
            <div class="comment-item">
                <div class="comment-avatar">${getAvatarInitials(c.display_name)}</div>
                <div class="comment-body">
                    <span class="comment-author">${escapeHtml(c.display_name)}</span>
                    <span class="comment-time">${formatCommentTime(c.created_at)}</span>
                    <div class="comment-content">${escapeHtml(c.content)}</div>
                </div>
            </div>
        `).join('');
        const moreHtml = (!expanded && comments.length > 3) ?
            `<div class="comments-more" onclick="expandComments(${topicId})">${I18N.t('view_all_replies', { n: comments.length })}</div>` : '';
        container.innerHTML = html + moreHtml;
    }

    // Append reply input area
    const inputHtml = currentUser
        ? `<div class="comment-reply">
            <input type="text" class="comment-input" id="comment-input-${topicId}" placeholder="${I18N.t('write_reply')}" maxlength="200">
            <button class="btn-comment-send" onclick="sendComment(${topicId})">${I18N.t('send')}</button>
           </div>`
        : `<div class="comments-login-hint">${I18N.t('login_to_reply')}</div>`;
    container.insertAdjacentHTML('beforeend', inputHtml);
}

function expandComments(topicId) {
    commentsCache[topicId].expanded = true;
    const container = document.getElementById(`comments-${topicId}`);
    if (container) renderComments(topicId, container);
}

async function sendComment(topicId) {
    const input = document.getElementById(`comment-input-${topicId}`);
    if (!input) return;
    const content = input.value.trim();
    if (!content) return;

    const hasChinese = /[\u4e00-\u9fff]/.test(content);
    const limit = hasChinese ? 100 : 200;
    if (content.length > limit) {
        alert(I18N.t('reply_too_long', { current: content.length, limit: limit }));
        return;
    }

    try {
        const res = await fetch(`/api/topics/${topicId}/comments`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ content })
        });
        const data = await res.json();
        if (res.ok) {
            input.value = '';
            await fetchComments(topicId);
        } else {
            alert(data.error || I18N.t('failed_to_send_reply'));
        }
    } catch(e) {
        alert(I18N.t('network_error'));
    }
}

function getAvatarInitials(name) {
    if (!name) return '?';
    return name.charAt(0).toUpperCase();
}

function formatCommentTime(ts) {
    const d = new Date(ts + 'Z');
    const now = new Date();
    const diff = now - d;
    if (diff < 60000) return I18N.t('time_just_now');
    if (diff < 3600000) return I18N.t('time_minutes_ago', { n: Math.floor(diff / 60000) });
    if (diff < 86400000) return I18N.t('time_hours_ago', { n: Math.floor(diff / 3600000) });
    return d.toLocaleDateString();
}

function navigate(direction) {
    if (isAnimating || topics.length === 0) return;
    const newIndex = currentIndex + direction;
    if (newIndex < 0 || newIndex >= topics.length) return;
    isAnimating = true;

    const oldCard = cardStack.children[currentIndex];
    const newCard = cardStack.children[newIndex];

    if (direction > 0) {
        oldCard.classList.add('exit-left');
        newCard.classList.add('active');
    } else {
        oldCard.classList.add('exit-right');
        newCard.classList.add('active');
    }

    setTimeout(() => {
        currentIndex = newIndex;
        isAnimating = false;
        renderCards();
    }, 400);
}

// ── Create Poll ─────────────────────────────────────────
function resetCreateForm() {
    $('#pollQuestion').value = '';
    $('#optionsContainer').innerHTML = `
        <div class="option-row">
            <input type="text" class="option-input" placeholder="${I18N.t('option_placeholder', { n: 1 })}" maxlength="100">
            <button class="btn-remove-option hidden" title="${I18N.t('remove')}">&times;</button>
        </div>
        <div class="option-row">
            <input type="text" class="option-input" placeholder="${I18N.t('option_placeholder', { n: 2 })}" maxlength="100">
            <button class="btn-remove-option hidden" title="${I18N.t('remove')}">&times;</button>
        </div>`;
    $('#pollCategory').value = 'General';
    updateCategorySelect();
    $('#createMsg').classList.add('hidden');
    updateOptionRemoveButtons();
    fetchDailyRemaining();
}

async function fetchDailyRemaining() {
    if (!authToken) return;
    try {
        const res = await fetch('/api/user-topics/daily-remaining', { headers: authHeaders() });
        if (res.ok) {
            const data = await res.json();
            const el = document.getElementById('dailyRemaining');
            if (el) {
                el.textContent = I18N.t('polls_remaining', { remaining: data.remaining, limit: data.limit });
                el.style.color = data.remaining === 0 ? 'var(--accent)' : 'var(--text-dim)';
            }
        }
    } catch(e) { /* ignore */ }
}

function addOptionRow() {
    const container = $('#optionsContainer');
    const rows = container.querySelectorAll('.option-row');
    if (rows.length >= 10) return;

    const row = document.createElement('div');
    row.className = 'option-row';
    row.innerHTML = `
        <input type="text" class="option-input" placeholder="${I18N.t('option_placeholder', { n: rows.length + 1 })}" maxlength="100">
        <button class="btn-remove-option" title="${I18N.t('remove')}">&times;</button>`;
    container.appendChild(row);
    updateOptionRemoveButtons();
}

function updateOptionRemoveButtons() {
    const container = $('#optionsContainer');
    const rows = container.querySelectorAll('.option-row');
    rows.forEach(r => {
        const btn = r.querySelector('.btn-remove-option');
        btn.classList.toggle('hidden', rows.length <= 2);
        btn.onclick = () => {
            if (rows.length <= 2) return;
            r.remove();
            updateOptionRemoveButtons();
        };
    });
    // Update placeholders
    container.querySelectorAll('.option-input').forEach((inp, i) => {
        const ph = inp.placeholder;
        if (!ph || ph.startsWith(I18N.t('option_placeholder', { n: '' }).replace(/\d+/, '')) || /^Option\s/.test(ph)) {
            inp.placeholder = I18N.t('option_placeholder', { n: i + 1 });
        }
    });
}

$('#optionsContainer').addEventListener('input', updateOptionRemoveButtons);

async function submitPoll() {
    const question = $('#pollQuestion').value.trim();
    const options = [...$$('#optionsContainer .option-input')]
        .map(inp => inp.value.trim())
        .filter(o => o);

    if (!question) {
        showCreateMsg(I18N.t('please_enter_question'), 'error');
        return;
    }
    if (options.length < 2) {
        showCreateMsg(I18N.t('at_least_2_options'), 'error');
        return;
    }

    $('#submitPollBtn').disabled = true;

    try {
        const res = await fetch('/api/user-topics', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({
                question,
                options,
                category: $('#pollCategory').value
            })
        });
        const data = await res.json();

        if (res.ok && data.success) {
            showCreateMsg(I18N.t('poll_published'), 'success');
            resetCreateForm();
            fetchDailyRemaining();
            setTimeout(() => switchTab('preset'), 1200);
        } else if (res.status === 429) {
            showCreateMsg(data.error || I18N.t('daily_limit'), 'error');
        } else if (res.status === 401) {
            showCreateMsg(I18N.t('please_sign_in_first'), 'error');
            loginModal.classList.remove('hidden');
        } else {
            showCreateMsg(data.error || I18N.t('failed_to_publish'), 'error');
        }
    } catch(e) {
        showCreateMsg(I18N.t('network_error_short'), 'error');
    } finally {
        $('#submitPollBtn').disabled = false;
    }
}

function showCreateMsg(msg, type) {
    const el = $('#createMsg');
    el.textContent = msg;
    el.className = `form-msg ${type}`;
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 4000);
}

// ── My Polls Panel ──────────────────────────────────────
async function toggleMyPollsPanel() {
    const panel = $('#myPollsPanel');
    const overlay = $('#myPollsOverlay');

    if (panel.classList.contains('open')) {
        closeMyPollsPanel();
        return;
    }

    closeHistoryPanel();

    overlay.classList.remove('hidden');
    panel.classList.add('open');
    await loadMyPolls();
}

function closeMyPollsPanel() {
    $('#myPollsPanel').classList.remove('open');
    $('#myPollsOverlay').classList.add('hidden');
}

async function loadMyPolls() {
    const list = $('#myPollsList');
    list.innerHTML = `<p class="empty-msg">${I18N.t('loading')}</p>`;

    try {
        const res = await fetch('/api/user-topics/mine', { headers: authHeaders() });
        if (res.status === 401) {
            list.innerHTML = `<p class="empty-msg">${I18N.t('sign_in_to_see_polls')}</p>`;
            return;
        }
        const polls = await res.json();
        if (polls.length === 0) {
            list.innerHTML = `<p class="empty-msg">${I18N.t('no_polls_yet')}</p>`;
            return;
        }

        list.innerHTML = polls.map(p => {
            const maxCount = Math.max(...p.votes.map(v => v.count), 1);
            const voteText = p.total_votes === 1 ? I18N.t('vote_label') : I18N.t('votes_label');
            return `
            <div class="poll-item" id="my-poll-${p.id}">
                <button class="pi-delete" onclick="deletePoll(${p.id})">${I18N.t('delete')}</button>
                <div class="pi-topic">${escapeHtml(p.question)}</div>
                <div class="pi-meta">${I18N.getCategoryKey(p.category)} &middot; ${p.total_votes} ${voteText} &middot; ${new Date(p.created_at).toLocaleDateString()}</div>
                <div class="mini-bars">
                    ${p.votes.map(v => `
                        <div class="mini-bar-row">
                            <span class="mini-bar-label">${escapeHtml(v.option)}</span>
                            <div class="mini-bar-track"><div class="mini-bar-fill" style="width:${maxCount ? (v.count/maxCount*100) : 0}%"></div></div>
                            <span class="mini-bar-count">${v.count}</span>
                        </div>
                    `).join('')}
                </div>
            </div>`;
        }).join('');
    } catch(e) {
        list.innerHTML = `<p class="empty-msg">${I18N.t('failed_to_load_polls')}</p>`;
    }
}

async function deletePoll(id) {
    if (!confirm(I18N.t('delete_poll_confirm'))) return;
    try {
        const res = await fetch(`/api/user-topics/${id}`, {
            method: 'DELETE',
            headers: authHeaders()
        });
        if (res.ok) {
            document.getElementById(`my-poll-${id}`)?.remove();
            const remaining = $$('#myPollsList .poll-item');
            if (remaining.length === 0) {
                $('#myPollsList').innerHTML = `<p class="empty-msg">${I18N.t('no_polls_yet')}</p>`;
            }
        }
    } catch(e) {
        alert(I18N.t('failed_to_delete_poll'));
    }
}

// ── My Votes Panel ─────────────────────────────────────
async function toggleHistoryPanel() {
    const panel = $('#historyPanel');
    const overlay = $('#historyOverlay');

    if (panel.classList.contains('open')) {
        closeHistoryPanel();
        return;
    }

    closeMyPollsPanel();

    overlay.classList.remove('hidden');
    panel.classList.add('open');
    await loadHistory();
}

function closeHistoryPanel() {
    $('#historyPanel').classList.remove('open');
    $('#historyOverlay').classList.add('hidden');
}

async function loadHistory() {
    const list = $('#historyList');
    list.innerHTML = `<p class="empty-msg">${I18N.t('loading')}</p>`;

    try {
        const res = await fetch('/api/my-votes');
        const votes = await res.json();
        if (votes.length === 0) {
            list.innerHTML = `<p class="empty-msg">${I18N.t('no_votes_yet')}</p>`;
            return;
        }

        list.innerHTML = votes.map(v => {
            const maxCount = Math.max(...v.stats.map(s => s.count), 1);
            return `
            <div class="history-item">
                <div class="hi-topic">${escapeHtml(v.question)}</div>
                <div class="hi-choice">${I18N.t('you_voted', { answer: escapeHtml(v.your_answer) })}</div>
                <div class="hi-time">${new Date(v.voted_at).toLocaleString()}</div>
                <div class="mini-bars">
                    ${v.stats.map(s => `
                        <div class="mini-bar-row">
                            <span class="mini-bar-label">${escapeHtml(s.option)}</span>
                            <div class="mini-bar-track"><div class="mini-bar-fill" style="width:${maxCount ? (s.count/maxCount*100) : 0}%"></div></div>
                            <span class="mini-bar-count">${s.count}</span>
                        </div>
                    `).join('')}
                </div>
            </div>`;
        }).join('');
    } catch(e) {
        list.innerHTML = `<p class="empty-msg">${I18N.t('failed_to_load_votes')}</p>`;
    }
}

// ── Favorites Panel ─────────────────────────────────────
async function toggleFavoritesPanel() {
    const panel = $('#favoritesPanel');
    const overlay = $('#favoritesOverlay');

    if (panel.classList.contains('open')) {
        closeFavoritesPanel();
        return;
    }

    closeHistoryPanel();
    closeMyPollsPanel();

    overlay.classList.remove('hidden');
    panel.classList.add('open');
    await loadFavorites();
}

function closeFavoritesPanel() {
    $('#favoritesPanel').classList.remove('open');
    $('#favoritesOverlay').classList.add('hidden');
}

async function loadFavorites() {
    const list = $('#favoritesList');
    list.innerHTML = `<p class="empty-msg">${I18N.t('loading')}</p>`;

    try {
        const res = await fetch('/api/favorites', { headers: authHeaders() });
        if (res.status === 401) {
            list.innerHTML = `<p class="empty-msg">${I18N.t('sign_in_to_see_favorites')}</p>`;
            return;
        }
        const favs = await res.json();
        if (favs.length === 0) {
            list.innerHTML = `<p class="empty-msg">${I18N.t('no_favorites_yet')}</p>`;
            return;
        }

        list.innerHTML = favs.map(f => `
            <div class="poll-item">
                <button class="pi-fav-remove" onclick="removeFavorite('${f.topic_type}', ${f.topic_id})" title="${I18N.t('unfavorite')}">${I18N.t('remove_fav')}</button>
                <div class="pi-topic">${escapeHtml(f.question)}</div>
                <div class="pi-meta">${I18N.getCategoryKey(f.category)} &middot; ${f.topic_type === 'preset' ? I18N.t('hot_topic') : I18N.t('community_poll')}</div>
            </div>
        `).join('');
    } catch(e) {
        list.innerHTML = `<p class="empty-msg">${I18N.t('failed_to_load_favorites')}</p>`;
    }
}

async function toggleFavorite(topicType, topicId) {
    if (!authToken) {
        loginModal.classList.remove('hidden');
        return;
    }
    const key = `${topicType}:${topicId}`;
    const isFav = favoriteIds.has(key);

    try {
        if (isFav) {
            const res = await fetch('/api/favorites', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json', ...authHeaders() },
                body: JSON.stringify({ topic_type: topicType, topic_id: topicId })
            });
            if (res.ok) {
                favoriteIds.delete(key);
            }
        } else {
            const res = await fetch('/api/favorites', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders() },
                body: JSON.stringify({ topic_type: topicType, topic_id: topicId })
            });
            if (res.ok) {
                favoriteIds.add(key);
            } else if (res.status === 409) {
                favoriteIds.add(key);
            }
        }
        renderCards();
    } catch(e) {
        // ignore
    }
}

async function removeFavorite(topicType, topicId) {
    const key = `${topicType}:${topicId}`;
    try {
        await fetch('/api/favorites', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ topic_type: topicType, topic_id: topicId })
        });
        favoriteIds.delete(key);
        loadFavorites();
        renderCards();
    } catch(e) { /* ignore */ }
}

// ── Country Stats ────────────────────────────────────────
let currentCountryStats = []; // for modal

function renderCountryStats(countryStats) {
    if (!countryStats || countryStats.length === 0) return '';
    const top3 = countryStats.slice(0, 3);
    const badges = top3.map(c => {
        const flag = getCountryFlag(c.country);
        return `<span class="country-badge">${flag} ${escapeHtml(c.country)} <span class="country-count">${c.count}${I18N.t('votes_label')}</span></span>`;
    }).join(' ');
    const viewAll = countryStats.length > 3
        ? ` <button class="btn-country-viewall" onclick="openCountryStats(event)">${I18N.t('view_all_countries')}</button>`
        : '';
    return `<div class="country-stats-header">${badges}${viewAll}</div>`;
}

function openCountryStats(event) {
    event.stopPropagation();
    const topic = topics[currentIndex];
    if (!topic || !topic._country_stats) return;
    currentCountryStats = topic._country_stats;
    const list = $('#countryStatsList');
    list.innerHTML = currentCountryStats.map(c => {
        const flag = getCountryFlag(c.country);
        return `<div class="country-stat-row">
            <span class="csr-flag">${flag}</span>
            <span class="csr-name">${escapeHtml(c.country)}</span>
            <span class="csr-count">${c.count} ${I18N.t('votes_label')}</span>
        </div>`;
    }).join('');
    $('#countryStatsOverlay').classList.remove('hidden');
}

function closeCountryStats() {
    $('#countryStatsOverlay').classList.add('hidden');
}

async function loadAllTopicStats() {
    // Fetch stats for all topics that are already voted
    const votedTopics = topics.filter(t => t.voted);
    let updated = false;
    for (const t of votedTopics) {
        if (t._stats) continue; // already loaded
        try {
            const sr = await fetch(`/api/topics/${t.id}/stats`);
            const statsData = await sr.json();
            t._stats = statsData.option_stats.map(s => ({ option: s.option_text, count: s.count }));
            t._country_stats = statsData.country_stats || [];
            t.total = statsData.total;
            updated = true;
        } catch(e) { /* ignore */ }
    }
    if (updated) renderCards();
}

// ── Utility ─────────────────────────────────────────────
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ── Start ───────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
