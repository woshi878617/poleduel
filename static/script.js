// ── State ────────────────────────────────────────────────
let topics = [];
let userTopics = [];
let currentIndex = 0;
let isAnimating = false;
let authToken = null;
let currentUser = null;
let favoriteIds = new Set(); // Set of "preset:ID" or "user:ID" strings

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

// ── Init ─────────────────────────────────────────────────
async function init() {
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
                <button class="btn-login" onclick="logout()" style="margin-left:8px;font-size:12px;">Sign Out</button>
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
        userArea.innerHTML = '<button id="loginBtn" class="btn-login">Sign In</button>';
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
        alert('Login failed. Please try again.');
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
            alert('Google login failed: ' + (data.error || 'Unknown error'));
        }
    } catch(e) {
        alert('Google login failed. Please try again.');
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
    // Hide create tab if active
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
        googleBtnContainer.innerHTML = '<p style="color:var(--text-dim);font-size:12px;">Google Sign-In not configured</p>';
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
            alert('Binding failed: ' + (data.error || 'Unknown error'));
        }
    } catch(e) {
        alert('Binding failed. Please try again.');
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
        cardStack.innerHTML = '<p class="empty-msg">No topics available</p>';
        return;
    }

    topics.forEach((t, i) => {
        const card = document.createElement('div');
        card.className = 'vote-card';
        if (i === currentIndex) card.classList.add('active');
        else if (i === currentIndex - 1) card.classList.add('prev');
        else if (i === currentIndex + 1) card.classList.add('next');

        const isFav = favoriteIds.has(`preset:${t.id}`);

        card.innerHTML = `
            <div class="card-category">
                ${escapeHtml(t.category)}
                <button class="btn-fav ${isFav ? 'faved' : ''}" onclick="toggleFavorite('preset', ${t.id})" title="${isFav ? 'Unfavorite' : 'Favorite'}">${isFav ? '★' : '☆'}</button>
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
            <div class="card-actions">
                <button class="btn-push" data-topic="${t.id}" data-action="push">🔥 Push</button>
                <span class="card-heat" id="heat-${t.id}">${t.heat || 100}</span>
                <button class="btn-skip" data-topic="${t.id}" data-action="skip">Skip →</button>
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
                // Fetch stats
                const sr = await fetch(`/api/stats/${topicId}`);
                const statsData = await sr.json();
                topic._stats = statsData.votes;
                topic.total = statsData.total;
            }
            renderCards();

            // Auto advance after vote
            setTimeout(() => {
                if (currentIndex < topics.length - 1) {
                    navigate(1);
                }
            }, 1500);
        } else {
            alert(data.error || 'Vote failed');
        }
    } catch(e) {
        alert('Network error. Please try again.');
    }
}

async function handlePush(topicId, buttonEl) {
    if (!authToken) {
        alert('Please sign in to Push topics.');
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
            buttonEl.textContent = 'Pushed ✓';
            buttonEl.disabled = true;
            buttonEl.classList.add('pushed');
            const heatEl = document.getElementById(`heat-${topicId}`);
            if (heatEl) heatEl.textContent = data.heat;
        } else if (res.status === 429) {
            buttonEl.textContent = 'Pushed ✓';
            buttonEl.disabled = true;
            buttonEl.classList.add('pushed');
        } else {
            alert(data.error || 'Push failed');
        }
    } catch(e) {
        alert('Network error. Please try again.');
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
            // Jump to next card
            if (currentIndex < topics.length - 1) {
                navigate(1);
            }
        }
    } catch(e) {
        // Silently fail for skip - just navigate
        if (currentIndex < topics.length - 1) {
            navigate(1);
        }
    }
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
            <input type="text" class="option-input" placeholder="Option 1" maxlength="100">
            <button class="btn-remove-option hidden" title="Remove">&times;</button>
        </div>
        <div class="option-row">
            <input type="text" class="option-input" placeholder="Option 2" maxlength="100">
            <button class="btn-remove-option hidden" title="Remove">&times;</button>
        </div>`;
    $('#pollCategory').value = 'General';
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
                el.textContent = `${data.remaining}/${data.limit} polls remaining today`;
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
        <input type="text" class="option-input" placeholder="Option ${rows.length + 1}" maxlength="100">
        <button class="btn-remove-option" title="Remove">&times;</button>`;
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
        if (!inp.placeholder || inp.placeholder.startsWith('Option ')) {
            inp.placeholder = `Option ${i + 1}`;
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
        showCreateMsg('Please enter a question', 'error');
        return;
    }
    if (options.length < 2) {
        showCreateMsg('At least 2 non-empty options required', 'error');
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
            showCreateMsg('Poll published successfully!', 'success');
            resetCreateForm();
            // Update daily remaining
            fetchDailyRemaining();
            // Switch to Hot Topics tab
            setTimeout(() => switchTab('preset'), 1200);
        } else if (res.status === 429) {
            showCreateMsg(data.error || 'Daily limit reached (3 polls per day)', 'error');
        } else if (res.status === 401) {
            showCreateMsg('Please sign in first', 'error');
            loginModal.classList.remove('hidden');
        } else {
            showCreateMsg(data.error || 'Failed to publish', 'error');
        }
    } catch(e) {
        showCreateMsg('Network error', 'error');
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

    // Close history if open
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
    list.innerHTML = '<p class="empty-msg">Loading...</p>';

    try {
        const res = await fetch('/api/user-topics/mine', { headers: authHeaders() });
        if (res.status === 401) {
            list.innerHTML = '<p class="empty-msg">Please sign in to see your polls</p>';
            return;
        }
        const polls = await res.json();
        if (polls.length === 0) {
            list.innerHTML = '<p class="empty-msg">You have not created any polls yet</p>';
            return;
        }

        list.innerHTML = polls.map(p => {
            const maxCount = Math.max(...p.votes.map(v => v.count), 1);
            return `
            <div class="poll-item" id="my-poll-${p.id}">
                <button class="pi-delete" onclick="deletePoll(${p.id})">Delete</button>
                <div class="pi-topic">${escapeHtml(p.question)}</div>
                <div class="pi-meta">${p.category} &middot; ${p.total_votes} vote${p.total_votes !== 1 ? 's' : ''} &middot; ${new Date(p.created_at).toLocaleDateString()}</div>
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
        list.innerHTML = '<p class="empty-msg">Failed to load polls</p>';
    }
}

async function deletePoll(id) {
    if (!confirm('Delete this poll?')) return;
    try {
        const res = await fetch(`/api/user-topics/${id}`, {
            method: 'DELETE',
            headers: authHeaders()
        });
        if (res.ok) {
            document.getElementById(`my-poll-${id}`)?.remove();
            // If no polls left
            const remaining = $$('#myPollsList .poll-item');
            if (remaining.length === 0) {
                $('#myPollsList').innerHTML = '<p class="empty-msg">You have not created any polls yet</p>';
            }
        }
    } catch(e) {
        alert('Failed to delete poll');
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

    // Close my polls if open
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
    list.innerHTML = '<p class="empty-msg">Loading...</p>';

    try {
        const res = await fetch('/api/my-votes');
        const votes = await res.json();
        if (votes.length === 0) {
            list.innerHTML = '<p class="empty-msg">No votes yet. Start voting!</p>';
            return;
        }

        list.innerHTML = votes.map(v => {
            const maxCount = Math.max(...v.stats.map(s => s.count), 1);
            return `
            <div class="history-item">
                <div class="hi-topic">${escapeHtml(v.question)}</div>
                <div class="hi-choice">You voted: ${escapeHtml(v.your_answer)}</div>
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
        list.innerHTML = '<p class="empty-msg">Failed to load votes</p>';
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
    list.innerHTML = '<p class="empty-msg">Loading...</p>';

    try {
        const res = await fetch('/api/favorites', { headers: authHeaders() });
        if (res.status === 401) {
            list.innerHTML = '<p class="empty-msg">Please sign in to see your favorites</p>';
            return;
        }
        const favs = await res.json();
        if (favs.length === 0) {
            list.innerHTML = '<p class="empty-msg">No favorites yet. Star a topic to save it!</p>';
            return;
        }

        list.innerHTML = favs.map(f => `
            <div class="poll-item">
                <button class="pi-fav-remove" onclick="removeFavorite('${f.topic_type}', ${f.topic_id})" title="Unfavorite">Remove</button>
                <div class="pi-topic">${escapeHtml(f.question)}</div>
                <div class="pi-meta">${escapeHtml(f.category)} &middot; ${f.topic_type === 'preset' ? 'Hot Topic' : 'Community Poll'}</div>
            </div>
        `).join('');
    } catch(e) {
        list.innerHTML = '<p class="empty-msg">Failed to load favorites</p>';
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
                // Already favorited - add to set anyway
                favoriteIds.add(key);
            }
        }
        // Re-render current views
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

// ── Utility ─────────────────────────────────────────────
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ── Start ───────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
