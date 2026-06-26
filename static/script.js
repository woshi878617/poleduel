// ── State ────────────────────────────────────────────────
let topics = [];
let userTopics = [];
let currentIndex = 0;
let isAnimating = false;
let authToken = null;
let currentUser = null;

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
    $('#closeHistoryBtn').addEventListener('click', closeHistoryPanel);
    $('#closeMyPollsBtn').addEventListener('click', closeMyPollsPanel);
    $('#historyOverlay').addEventListener('click', closeHistoryPanel);
    $('#myPollsOverlay').addEventListener('click', closeMyPollsPanel);

    // Create poll form
    $('#addOptionBtn').addEventListener('click', addOptionRow);
    $('#submitPollBtn').addEventListener('click', submitPoll);
    updateOptionRemoveButtons();
}

function updateUIForAuth() {
    if (currentUser) {
        userArea.innerHTML = `
            <div class="user-info">
                ${currentUser.avatar_url ? `<img src="${currentUser.avatar_url}" alt="">` : ''}
                <span>${escapeHtml(currentUser.display_name)}</span>
                <button class="btn-login" onclick="logout()" style="margin-left:8px;font-size:12px;">Sign Out</button>
            </div>`;
        createPollTab.classList.remove('hidden');
        myPollsBtn.classList.remove('hidden');
    } else {
        userArea.innerHTML = '<button id="loginBtn" class="btn-login">Sign In</button>';
        document.getElementById('loginBtn').addEventListener('click', () => loginModal.classList.remove('hidden'));
        createPollTab.classList.add('hidden');
        myPollsBtn.classList.add('hidden');
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

// ── Tab switching ───────────────────────────────────────
function switchTab(tab) {
    if (tab === 'create' && !currentUser) {
        loginModal.classList.remove('hidden');
        return;
    }

    tabBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    tabContents.forEach(c => c.classList.toggle('active', c.id === `tab-${tab}`));

    if (tab === 'community') loadCommunity();
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

        card.innerHTML = `
            <div class="card-category">${escapeHtml(t.category)}</div>
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

// ── Community Polls ─────────────────────────────────────
async function loadCommunity() {
    const list = $('#communityList');
    list.innerHTML = '<p class="empty-msg">Loading community polls...</p>';

    try {
        const res = await fetch('/api/user-topics/all');
        userTopics = await res.json();
        renderCommunity();
    } catch(e) {
        list.innerHTML = '<p class="empty-msg">Failed to load community polls</p>';
    }
}

function renderCommunity() {
    const list = $('#communityList');
    if (userTopics.length === 0) {
        list.innerHTML = '<p class="empty-msg">No community polls yet.<br>Be the first to create one!</p>';
        return;
    }

    list.innerHTML = userTopics.map(ut => {
        const maxVotes = Math.max(...ut.votes.map(v => v.count), 1);
        return `
        <div class="community-card" id="community-${ut.id}">
            <div class="cc-header">
                <div class="cc-author">
                    ${ut.author_avatar ? `<img src="${ut.author_avatar}" alt="">` : ''}
                    <span>${escapeHtml(ut.author_name)}</span>
                </div>
                <span class="cc-category">${escapeHtml(ut.category)}</span>
            </div>
            <div class="cc-question">${escapeHtml(ut.question)}</div>
            <div class="cc-options">
                ${ut.options.map((opt, oi) => `
                    <div class="cc-option ${ut.voted ? 'voted' : ''} ${ut._chosen === oi ? 'chosen' : ''}"
                         data-topic="${ut.id}" data-option="${oi}"
                         style="${ut.voted ? '' : 'cursor:pointer'}">
                        ${ut.voted ? `<div class="cc-option-bar" style="width:${maxVotes ? (ut.votes[oi].count/maxVotes*100) : 0}%"></div>` : ''}
                        <span class="cc-option-text">${escapeHtml(opt)}</span>
                        ${ut.voted ? `<span class="cc-option-count">${ut.votes[oi].count}</span>` : ''}
                    </div>
                `).join('')}
            </div>
            ${ut.voted ? `
            <div class="cc-stats">
                ${ut.votes.map((v, vi) => `
                    <div class="cc-stat-row">
                        <span class="cc-stat-label">${escapeHtml(v.option)}</span>
                        <div class="cc-stat-track"><div class="cc-stat-fill" style="width:${ut.total_votes ? (v.count/ut.total_votes*100) : 0}%"></div></div>
                        <span class="cc-stat-count">${v.count}</span>
                    </div>
                `).join('')}
            </div>` : ''}
            <div style="font-size:11px;color:var(--text-dim);margin-top:8px;">${ut.total_votes} vote${ut.total_votes !== 1 ? 's' : ''} &middot; ${new Date(ut.created_at).toLocaleDateString()}</div>
        </div>`;
    }).join('');

    // Attach vote listeners
    list.querySelectorAll('.cc-option').forEach(opt => {
        if (opt.classList.contains('voted')) return;
        opt.addEventListener('click', async () => {
            const tid = parseInt(opt.dataset.topic);
            const oi = parseInt(opt.dataset.option);
            await handleCommunityVote(tid, oi);
        });
    });
}

async function handleCommunityVote(topicId, optionIndex) {
    try {
        const res = await fetch(`/api/user-topics/${topicId}/vote`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ option_index: optionIndex })
        });
        const data = await res.json();
        if (data.success) {
            // Refresh community list
            await loadCommunity();
        } else {
            alert(data.error || 'Vote failed');
        }
    } catch(e) {
        alert('Network error');
    }
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
            // Switch to community tab
            setTimeout(() => switchTab('community'), 1200);
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

// ── Utility ─────────────────────────────────────────────
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ── Start ───────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
