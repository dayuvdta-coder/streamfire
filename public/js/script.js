console.log('StreamFire V7 Loaded');

const socket = io();

socket.on('connect', () => console.log('Socket Connected'));
socket.on('connect_error', (err) => console.log('Socket Err:', err.message));

const logContainer = document.getElementById('activity-log');
const logClearBtn = document.getElementById('activity-log-clear');
const streamStateMap = new Map();
const LOG_RENDER_LIMIT = 300;

function refreshActiveCount() {
    const countEl = document.getElementById('active-count');
    if (!countEl) return;
    const activeCount = Array.from(streamStateMap.values()).filter((x) => x.running || x.restarting).length;
    countEl.innerText = activeCount;
}

function renderLogPlaceholder() {
    if (!logContainer) return;
    logContainer.innerHTML = '<div class="text-center text-gray-500 text-xs py-8">Belum ada log.</div>';
}

function resolveLogClass(logType) {
    const t = String(logType || '').toLowerCase();
    if (t === 'error') return 'border-red-500 text-red-600';
    if (t === 'warning' || t === 'warn') return 'border-amber-500 text-amber-700';
    if (t === 'success') return 'border-green-500 text-green-600';
    return 'border-blue-500 text-blue-700';
}

function addLogEntry(log, options = {}) {
    if (!logContainer) return;
    const prepend = options.prepend !== false;
    const items = log && typeof log === 'object' ? log : {};
    const time = String(items.time || '--:--:--');
    const message = String(items.message || '').trim() || '(empty log)';
    const style = resolveLogClass(items.type);

    if (logContainer.children.length === 1 && logContainer.children[0].classList.contains('text-center')) {
        logContainer.innerHTML = '';
    }

    const div = document.createElement('div');
    div.className = `border-l-2 pl-2 py-1 ${style}`;

    const timeEl = document.createElement('span');
    timeEl.className = 'text-gray-500';
    timeEl.textContent = `[${time}] `;
    div.appendChild(timeEl);

    const msgEl = document.createElement('span');
    msgEl.className = 'break-words';
    msgEl.textContent = message;
    div.appendChild(msgEl);

    if (prepend) {
        logContainer.insertBefore(div, logContainer.firstChild);
    } else {
        logContainer.appendChild(div);
    }

    while (logContainer.children.length > LOG_RENDER_LIMIT) {
        logContainer.removeChild(logContainer.lastChild);
    }
}

socket.on('logsInit', (items) => {
    if (!logContainer) return;
    const list = Array.isArray(items) ? items : [];
    if (!list.length) {
        renderLogPlaceholder();
        return;
    }
    logContainer.innerHTML = '';
    list.forEach((item) => addLogEntry(item, { prepend: false }));
});

socket.on('newLog', (log) => addLogEntry(log));

if (logClearBtn) {
    logClearBtn.addEventListener('click', () => {
        renderLogPlaceholder();
    });
}

async function updateStats(force = false) {
    if (!force && typeof document !== 'undefined' && document.hidden) return;
    try {
        const res = await fetch('/api/system/stats');
        const data = await res.json();

        const ramText = document.getElementById('ram-text');
        const ramBar = document.getElementById('ram-bar');
        const cpuText = document.getElementById('cpu-text');
        const cpuBar = document.getElementById('cpu-bar');
        const diskText = document.getElementById('disk-text');
        const diskBar = document.getElementById('disk-bar');

        if (ramText) ramText.innerText = `${data.ram.percent}% (${data.ram.usedMB} MB)`;
        if (ramBar) {
            ramBar.style.width = `${data.ram.percent}%`;
            ramBar.className = `h-4 border-2 border-black transition-all duration-500 ${data.ram.percent > 85 ? 'bg-red-500' : 'bg-yellow-400'}`;
        }

        if (cpuText) cpuText.innerText = `${data.cpu.percent}%`;
        if (cpuBar) {
            cpuBar.style.width = `${data.cpu.percent}%`;
            cpuBar.className = `h-4 border-2 border-black transition-all duration-500 ${data.cpu.percent > 85 ? 'bg-red-500' : 'bg-cyan-400'}`;
        }

        if (data.disk && diskText && diskBar) {
            diskText.innerText = `${data.disk.percent}% (${data.disk.used})`;
            diskBar.style.width = `${data.disk.percent}%`;
            diskBar.className = `h-4 border-2 border-black transition-all duration-500 ${data.disk.percent > 90 ? 'bg-red-500' : 'bg-green-400'}`;
        }

    } catch (e) {

    }
}
setInterval(() => updateStats(false), 5000);
updateStats(true);



const modal = document.getElementById('uploadModal');
const btnUpload = document.getElementById('add-video-btn');
const btnClose = document.getElementById('closeModal');
if (btnUpload) btnUpload.onclick = () => modal.classList.remove('hidden');
if (btnClose) btnClose.onclick = () => modal.classList.add('hidden');

const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('videoInput');
const fileName = document.getElementById('fileName');
const uploadUrlInput = document.getElementById('videoUrlInput');

if (dropZone) {
    dropZone.onclick = () => fileInput.click();
    fileInput.onchange = () => {
        if (fileInput.files.length > 0) {
            fileName.innerText = fileInput.files[0].name;
            fileName.classList.add('text-orange-400');
        }
    };
}

const form = document.getElementById('uploadForm');
if (form) {
    form.onsubmit = async (e) => {
        e.preventDefault();
        const titleInput = form.querySelector('input[name="title"]');
        const title = String(titleInput ? titleInput.value : '').trim();
        const sourceUrl = String(uploadUrlInput ? uploadUrlInput.value : '').trim();
        const hasFile = Boolean(fileInput && fileInput.files && fileInput.files.length > 0);
        const useUrlDownload = Boolean(sourceUrl);

        if (!title) {
            Swal.fire({ icon: 'warning', title: 'Judul wajib diisi', text: 'Isi judul stream dulu sebelum upload/download.', background: '#1f2937', color: '#fff' });
            return;
        }

        if (!useUrlDownload && !hasFile) {
            Swal.fire({ icon: 'warning', title: 'Sumber video kosong', text: 'Pilih file lokal atau isi link video dulu.', background: '#1f2937', color: '#fff' });
            return;
        }

        modal.classList.add('hidden');
        Swal.fire({
            title: useUrlDownload ? 'Downloading...' : 'Uploading...',
            text: useUrlDownload ? 'Mengunduh video dari link via yt-dlp...' : 'Processing video...',
            allowOutsideClick: false,
            background: '#1f2937',
            color: '#fff',
            didOpen: () => Swal.showLoading()
        });
        try {
            let res;
            if (useUrlDownload) {
                res = await fetch('/api/upload/url', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ title, url: sourceUrl })
                });
            } else {
                res = await fetch('/api/upload/local', { method: 'POST', body: new FormData(form) });
            }

            const payload = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(payload.message || payload.error || (useUrlDownload ? 'Download Failed' : 'Upload Failed'));
            }

            window.location.reload();
        } catch (err) {
            modal.classList.remove('hidden');
            Swal.fire({ icon: 'error', title: 'Error', text: err.message, background: '#1f2937', color: '#fff' });
        }
    };
}

const RTMP_PRESETS = {
    custom: { prefix: '', placeholder: 'RTMP URL (e.g. rtmp://site.com/live/key)' },
    youtube: { prefix: 'rtmp://a.rtmp.youtube.com/live2/', placeholder: 'Paste Stream Key' },
    facebook: { prefix: 'rtmps://live-api-s.facebook.com:443/rtmp/', placeholder: 'Paste Stream Key' },
    twitch: { prefix: 'rtmp://live.twitch.tv/app/', placeholder: 'Paste Stream Key' },
    instagram: { prefix: 'rtmps://live-upload.instagram.com:443/rtmp/', placeholder: 'Paste Stream Key' }
};

window.updatePlaceholder = (select) => {
    const key = select.value;
    const row = select.closest('.destination-row');
    const input = row.querySelector('input');
    const prefixEl = row.querySelector('.prefix-display');

    if (input && RTMP_PRESETS[key]) {
        input.placeholder = RTMP_PRESETS[key].placeholder;
        if (prefixEl) {
            prefixEl.innerText = key === 'custom' ? '' : `Server: ${RTMP_PRESETS[key].prefix}`;
            prefixEl.style.display = key === 'custom' ? 'none' : 'block';
        }
    }
};
window.addDestination = (id) => {
    const container = document.getElementById(`destinations-container-${id}`);
    const div = document.createElement('div');
    div.className = 'flex flex-col gap-1 destination-row mb-2 border-b-2 border-black/10 pb-2';
    div.innerHTML = `
      <div class="flex items-stretch gap-1">
        <select class="bg-gray-50 border-2 border-black px-2 py-2 text-[10px] font-bold outline-none focus:bg-yellow-100 uppercase platform-select font-mono w-24" onchange="updatePlaceholder(this)">
            <option value="custom">Custom</option>
            <option value="youtube">YouTube</option>
            <option value="facebook">Facebook</option>
            <option value="twitch">Twitch</option>
            <option value="instagram">Instagram</option>
        </select>
        <div class="relative group/input flex-1">
            <div class="absolute left-3 top-2.5 text-black z-20"><i class="fas fa-key text-xs"></i></div>
            <input type="password" value=""
            class="w-full h-full bg-gray-50 border-2 border-black px-3 pl-9 py-2 text-xs text-black focus:bg-yellow-100 outline-none transition-all placeholder-gray-500 font-mono destination-input relative z-10"
            placeholder="RTMP URL (e.g. rtmp://site.com/live/key)">
            <button type="button" onclick="const i = this.previousElementSibling; i.type = i.type === 'password' ? 'text' : 'password'; this.innerHTML = i.type === 'password' ? '<i class=\'fas fa-eye\'></i>' : '<i class=\'fas fa-eye-slash\'></i>';" class="absolute right-2 top-2 z-30 text-gray-500 hover:text-black">
                <i class="fas fa-eye"></i>
            </button>
        </div>
        <button type="button" onclick="this.closest('.destination-row').remove()" class="bg-red-500 text-white border-2 border-black w-8 flex items-center justify-center hover:bg-red-600 transition-colors shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] active:shadow-none active:translate-x-[1px] active:translate-y-[1px]">
            <i class="fas fa-times text-xs"></i>
        </button>
      </div>
      <div class="prefix-display text-[10px] font-mono text-gray-500 pl-1 hidden"></div>
    `;
    container.appendChild(div);
};

document.querySelectorAll('.start-btn').forEach(btn => {
    btn.onclick = async function () {
        const id = this.getAttribute('data-id');
        const isRunning = this.getAttribute('data-running') === 'true';

        if (isRunning) {
            await fetch('/api/stream/stop', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ videoId: id })
            });
        } else {
            const container = document.getElementById(`destinations-container-${id}`);
            const rows = container.querySelectorAll('.destination-row');
            const destinations = [];

            rows.forEach(row => {
                const select = row.querySelector('.platform-select');
                const input = row.querySelector('.destination-input');

                if (input && input.value.trim()) {
                    let val = input.value.trim();
                    const type = select ? select.value : 'custom';

                    if (type !== 'custom' && RTMP_PRESETS[type]) {
                        if (!val.startsWith('rtmp')) {
                            val = RTMP_PRESETS[type].prefix + val;
                        }
                    }
                    destinations.push(val);
                }
            });

            const res = document.getElementById(`res-${id}`).value;
            const fps = document.getElementById(`fps-${id}`).value;
            const bit = document.getElementById(`bit-${id}`).value;
            const loop = document.getElementById(`loop-${id}`).checked;

            if (destinations.length === 0) return Swal.fire({ icon: 'warning', title: 'Missing Destination', text: 'Please add at least one RTMP URL', background: '#1f2937', color: '#fff' });

            this.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Starting...';
            this.disabled = true;

            try {
                const resp = await fetch('/api/stream/start', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        videoId: id,
                        settings: { resolution: res, bitrate: bit, fps: fps },
                        loop: loop,
                        customRtmp: destinations,
                        keepAlive: true
                    })
                });
                const data = await resp.json().catch(() => ({}));
                if (!resp.ok) throw new Error(data.error || data.message || 'Failed to start');
            } catch (e) {
                Swal.fire({ icon: 'error', title: 'Stream Error', text: e.message, background: '#1f2937', color: '#fff' });
                this.innerHTML = '<i class="fas fa-play text-xs"></i> Start Stream';
                this.disabled = false;
            }
        }
    };
});

document.querySelectorAll('.delete-btn').forEach(btn => {
    btn.onclick = async function () {
        const result = await Swal.fire({
            title: 'Delete Video?',
            icon: 'warning',
            showCancelButton: true,
            confirmButtonColor: '#ef4444',
            cancelButtonColor: '#374151',
            confirmButtonText: 'Delete',
            background: '#1f2937', color: '#fff'
        });
        if (result.isConfirmed) {
            await fetch('/api/video/' + this.getAttribute('data-id'), { method: 'DELETE' });
            window.location.reload();
        }
    }
});

const timers = {};
function startTimer(id, startTimeStr) {
    if (timers[id]) clearInterval(timers[id]);

    const el = document.getElementById(`timer-${id}`);
    if (!el) return;
    el.classList.remove('hidden');

    const update = () => {
        if (!startTimeStr) {
            el.innerText = "00:00:00";
            return;
        }
        const start = new Date(startTimeStr).getTime();
        const now = new Date().getTime();
        const diff = Math.max(0, Math.floor((now - start) / 1000));

        const h = Math.floor(diff / 3600).toString().padStart(2, '0');
        const m = Math.floor((diff % 3600) / 60).toString().padStart(2, '0');
        const s = (diff % 60).toString().padStart(2, '0');
        el.innerText = `${h}:${m}:${s}`;
    };

    update(); 
    timers[id] = setInterval(update, 1000);
}

function stopTimer(id) {
    if (timers[id]) { clearInterval(timers[id]); delete timers[id]; }
    const el = document.getElementById(`timer-${id}`);
    if (el) { el.classList.add('hidden'); el.innerText = '00:00:00'; }
}

socket.on('streamStatuses', (list) => {
    streamStateMap.clear();
    list.forEach((x) => {
        const state = { running: Boolean(x.running), restarting: Boolean(x.restarting) };
        streamStateMap.set(String(x.videoId), state);
        updateCard(x.videoId, state.running, x.startTime, state.restarting, x.restartCount, x.restartInMs);
    });
    refreshActiveCount();
});
socket.on('streamStatus', (item) => {
    const state = { running: Boolean(item.running), restarting: Boolean(item.restarting) };
    streamStateMap.set(String(item.videoId), state);
    refreshActiveCount();
    updateCard(item.videoId, state.running, item.startTime, state.restarting, item.restartCount, item.restartInMs);
});

document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.platform-select').forEach((select) => updatePlaceholder(select));
    document.querySelectorAll('.start-btn').forEach(btn => {
        const id = btn.getAttribute('data-id');
        const isRunning = btn.getAttribute('data-running') === 'true';
        const startTime = btn.getAttribute('data-start-time');
        streamStateMap.set(String(id), { running: isRunning, restarting: false });

        if (isRunning && startTime) {
            updateCard(id, true, startTime);
        }
    });
    refreshActiveCount();

    initUrlStreamPanel();
    initInstagramPanel();
    initMultiChatPanel();
});

function updateCard(id, isRunning, startTime = null, restarting = false, restartCount = 0, restartInMs = null) {
    const btn = document.querySelector(`.start-btn[data-id="${id}"]`);
    const badge = document.getElementById(`badge-${id}`);
    const dot = document.getElementById(`dot-${id}`);
    const text = document.getElementById(`status-${id}`);
    const card = document.getElementById(`card-${id}`);
    const videoEl = card ? card.querySelector('video') : null;

    if (!btn) return;

    // Keep button in "stop mode" while reconnecting so user can still stop stream.
    btn.setAttribute('data-running', (isRunning || restarting) ? 'true' : 'false');
    if (startTime) btn.setAttribute('data-start-time', startTime);
    btn.disabled = false;

    if (restarting) {
        const seconds = restartInMs ? Math.max(1, Math.ceil(Number(restartInMs) / 1000)) : null;
        btn.innerHTML = `<i class="fas fa-arrows-rotate fa-spin text-xs"></i> Stop / Reconnecting`;
        btn.className = 'w-full bg-amber-500 hover:bg-amber-400 text-black font-bold py-2.5 rounded-lg transition-all start-btn shadow-lg flex items-center justify-center gap-2';
        badge.className = 'bg-amber-400 text-[10px] font-bold px-2 py-1 rounded-md text-black border border-amber-700 flex items-center gap-1.5 shadow-lg animate-pulse';
        dot.className = 'w-1.5 h-1.5 rounded-full bg-black';
        text.innerText = seconds ? `RETRY ${seconds}s` : `RETRYING${restartCount ? ` #${restartCount}` : ''}`;
        stopTimer(id);

        if (videoEl) {
            videoEl.pause();
            videoEl.currentTime = 0;
            videoEl.classList.add('opacity-80');
            videoEl.classList.remove('opacity-100');
        }
    } else if (isRunning) {
        btn.innerHTML = '<i class="fas fa-stop text-xs"></i> Stop Stream';
        btn.className = 'w-full bg-red-600 hover:bg-red-500 text-white font-bold py-2.5 rounded-lg transition-all start-btn shadow-lg flex items-center justify-center gap-2';
        badge.className = 'bg-red-500/90 backdrop-blur-sm text-[10px] font-bold px-2 py-1 rounded-md text-white border border-red-400 flex items-center gap-1.5 shadow-lg animate-pulse';
        dot.className = 'w-1.5 h-1.5 rounded-full bg-white';
        text.innerText = 'LIVE';
        if (startTime) startTimer(id, startTime);

        if (videoEl) {
            videoEl.muted = true;
            videoEl.loop = true;
            videoEl.play().catch(e => console.log("Auto-play blocked:", e));
            videoEl.classList.remove('opacity-80');
            videoEl.classList.add('opacity-100');
        }

    } else {
        btn.innerHTML = '<i class="fas fa-play text-xs"></i> Start Stream';
        btn.className = 'w-full bg-gradient-to-r from-gray-700 to-gray-600 hover:from-gray-600 hover:to-gray-500 text-white font-bold py-2.5 rounded-lg transition-all start-btn shadow-lg text-sm flex items-center justify-center gap-2';
        badge.className = 'bg-black/80 text-[10px] font-bold px-2 py-1 rounded-md text-gray-400 border border-white/10 flex items-center gap-1.5 backdrop-blur-sm';
        dot.className = 'w-1.5 h-1.5 rounded-full bg-gray-500';
        text.innerText = 'OFFLINE';
        stopTimer(id);

        if (videoEl) {
            videoEl.pause();
            videoEl.currentTime = 0;
            videoEl.classList.add('opacity-80');
            videoEl.classList.remove('opacity-100');
        }
    }
}

window.saveConfig = async (id) => {
    const container = document.getElementById(`destinations-container-${id}`);
    const rows = container.querySelectorAll('.destination-row');
    const destinations = [];

    rows.forEach(row => {
        const select = row.querySelector('.platform-select');
        const input = row.querySelector('.destination-input');

        if (input && input.value.trim()) {
            let val = input.value.trim();
            const type = select ? select.value : 'custom';

            if (type !== 'custom' && RTMP_PRESETS[type]) {
                if (!val.startsWith('rtmp')) {
                    val = RTMP_PRESETS[type].prefix + val;
                }
            }
            destinations.push(val);
        }
    });

    const res = document.getElementById(`res-${id}`).value;
    const fps = document.getElementById(`fps-${id}`).value;
    const bit = document.getElementById(`bit-${id}`).value;
    const loop = document.getElementById(`loop-${id}`).checked;

    const btn = document.querySelector(`button[onclick="saveConfig('${id}')"]`);
    const originalContent = btn.innerHTML;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> SAVING...';
    btn.disabled = true;

    try {
        const resp = await fetch('/api/stream/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ videoId: id, settings: { resolution: res, bitrate: bit, fps: fps }, loop: loop, customRtmp: destinations })
        });

        if (!resp.ok) throw new Error('Failed to save');
        const data = await resp.json();

        Swal.fire({
            icon: 'success',
            title: 'Saved!',
            text: 'Configuration saved successfully.',
            toast: true,
            position: 'top-end',
            showConfirmButton: false,
            timer: 3000,
            background: '#1f2937', color: '#fff'
        });

    } catch (e) {
        Swal.fire({ icon: 'error', title: 'Error', text: e.message, background: '#1f2937', color: '#fff' });
    } finally {
        btn.innerHTML = originalContent;
        btn.disabled = false;
    }
};

const IG_REFRESH_INTERVAL = 10000;
const IG_COMMENTS_REFRESH_INTERVAL = 8000;
const MP_COMMENTS_REFRESH_INTERVAL = 8000;
const URL_STREAM_REFRESH_INTERVAL = 10000;
let igStatusTimer = null;
let igCommentsTimer = null;
let mpCommentsTimer = null;
let urlStreamTimer = null;
let igAutoReplyLoaded = false;
const urlStreamElements = {
    source: document.getElementById('url-stream-source'),
    destinations: document.getElementById('url-stream-destinations'),
    res: document.getElementById('url-stream-res'),
    fps: document.getElementById('url-stream-fps'),
    bitrate: document.getElementById('url-stream-bitrate'),
    startBtn: document.getElementById('url-stream-start-btn'),
    stopBtn: document.getElementById('url-stream-stop-btn'),
    status: document.getElementById('url-stream-status'),
    pill: document.getElementById('url-stream-pill'),
};
const igElements = {
    cookie: document.getElementById('ig-cookie'),
    cookieName: document.getElementById('ig-cookie-name'),
    cookieSavedSelect: document.getElementById('ig-cookie-saved-select'),
    cookieSaveBtn: document.getElementById('ig-cookie-save-btn'),
    cookieApplyBtn: document.getElementById('ig-cookie-apply-btn'),
    cookieDeleteBtn: document.getElementById('ig-cookie-delete-btn'),
    loginUsername: document.getElementById('ig-login-username'),
    loginPassword: document.getElementById('ig-login-password'),
    loginAccountBtn: document.getElementById('ig-login-account-btn'),
    challengeCode: document.getElementById('ig-challenge-code'),
    challengeVerifyBtn: document.getElementById('ig-challenge-verify-btn'),
    title: document.getElementById('ig-title'),
    audience: document.getElementById('ig-audience'),
    streamUrl: document.getElementById('ig-stream-url'),
    streamKey: document.getElementById('ig-stream-key'),
    video: document.getElementById('ig-video'),
    res: document.getElementById('ig-res'),
    fps: document.getElementById('ig-fps'),
    bit: document.getElementById('ig-bit'),
    loop: document.getElementById('ig-loop'),
    multiRtmp: document.getElementById('ig-multi-rtmp'),
    loginBtn: document.getElementById('ig-login-btn'),
    setupBtn: document.getElementById('ig-setup-btn'),
    startBtn: document.getElementById('ig-start-btn'),
    goBtn: document.getElementById('ig-go-btn'),
    endBtn: document.getElementById('ig-end-btn'),
    pill: document.getElementById('ig-pill'),
    ffmpegPill: document.getElementById('ig-ffmpeg-pill'),
    status: document.getElementById('ig-status'),
    commentsRefreshBtn: document.getElementById('ig-comments-refresh'),
    commentsList: document.getElementById('ig-comments-list'),
    commentInput: document.getElementById('ig-comment-input'),
    commentSendBtn: document.getElementById('ig-comment-send'),
    autoReplyEnabled: document.getElementById('ig-autoreply-enabled'),
    autoReplyMode: document.getElementById('ig-autoreply-mode'),
    autoReplyCooldown: document.getElementById('ig-autoreply-cooldown'),
    autoReplyMaxUser: document.getElementById('ig-autoreply-max-user'),
    autoReplyRepliesPerComment: document.getElementById('ig-autoreply-replies-per-comment'),
    autoReplyFollowUpEnabled: document.getElementById('ig-autoreply-followup-enabled'),
    autoReplyFollowUpDelay: document.getElementById('ig-autoreply-followup-delay'),
    autoReplyPrice: document.getElementById('ig-autoreply-price'),
    autoReplyTemplates: document.getElementById('ig-autoreply-templates'),
    autoReplyFollowUpTemplates: document.getElementById('ig-autoreply-followup-templates'),
    autoReplySystem: document.getElementById('ig-autoreply-system'),
    autoReplySaveBtn: document.getElementById('ig-autoreply-save'),
    autoReplyRunOnceBtn: document.getElementById('ig-autoreply-runonce'),
    autoReplyRefreshBtn: document.getElementById('ig-autoreply-refresh'),
    autoReplyStatus: document.getElementById('ig-autoreply-status'),
    autoReplyPill: document.getElementById('ig-autoreply-pill'),
};
const mpElements = {
    platform: document.getElementById('mp-platform'),
    refreshBtn: document.getElementById('mp-refresh'),
    saveBtn: document.getElementById('mp-settings-save'),
    ytStreamId: document.getElementById('mp-yt-stream-id'),
    ytLiveChatId: document.getElementById('mp-yt-livechat-id'),
    ytApiKey: document.getElementById('mp-yt-api-key'),
    ytAccessToken: document.getElementById('mp-yt-access-token'),
    ytSelfChannelId: document.getElementById('mp-yt-self-channel-id'),
    fbLiveVideoId: document.getElementById('mp-fb-live-video-id'),
    fbPageToken: document.getElementById('mp-fb-page-token'),
    fbPageId: document.getElementById('mp-fb-page-id'),
    commentsList: document.getElementById('mp-comments-list'),
    commentInput: document.getElementById('mp-comment-input'),
    commentSendBtn: document.getElementById('mp-comment-send'),
    status: document.getElementById('mp-chat-status'),
    pill: document.getElementById('mp-chat-pill'),
    autoReplyEnabled: document.getElementById('mp-autoreply-enabled'),
    autoReplyPlatformYoutube: document.getElementById('mp-autoreply-platform-youtube'),
    autoReplyPlatformFacebook: document.getElementById('mp-autoreply-platform-facebook'),
    autoReplyMode: document.getElementById('mp-autoreply-mode'),
    autoReplyCooldown: document.getElementById('mp-autoreply-cooldown'),
    autoReplyMaxUser: document.getElementById('mp-autoreply-max-user'),
    autoReplyRepliesPerComment: document.getElementById('mp-autoreply-replies-per-comment'),
    autoReplyFollowUpEnabled: document.getElementById('mp-autoreply-followup-enabled'),
    autoReplyFollowUpDelay: document.getElementById('mp-autoreply-followup-delay'),
    autoReplyPollMs: document.getElementById('mp-autoreply-poll-ms'),
    autoReplyPrice: document.getElementById('mp-autoreply-price'),
    autoReplyTemplates: document.getElementById('mp-autoreply-templates'),
    autoReplyFollowUpTemplates: document.getElementById('mp-autoreply-followup-templates'),
    autoReplySystem: document.getElementById('mp-autoreply-system'),
    autoReplySaveBtn: document.getElementById('mp-autoreply-save'),
    autoReplyRunOnceBtn: document.getElementById('mp-autoreply-runonce'),
    autoReplyRefreshBtn: document.getElementById('mp-autoreply-refresh'),
    autoReplyStatus: document.getElementById('mp-autoreply-status'),
    autoReplyPill: document.getElementById('mp-autoreply-pill'),
};
const multiChatState = {
    settings: null,
    autoReply: null,
    lastFetchedAt: {
        youtube: null,
        facebook: null,
    },
    lastError: '',
};

const IG_COOKIE_STORAGE_KEY = 'streamingku:instagram:cookies:v1';
const IG_COOKIE_DRAFT_KEY = 'streamingku:instagram:cookie-draft:v1';
const IG_COOKIE_MAX_ITEMS = 15;

function sanitizeInstagramCookieLabel(label) {
    return String(label || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 40);
}

function defaultInstagramCookieLabel() {
    const now = new Date();
    return `IG ${now.toLocaleDateString('id-ID')} ${now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}`;
}

function formatInstagramCookieTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '-';
    return date.toLocaleString('id-ID');
}

function readSavedInstagramCookies() {
    try {
        const raw = localStorage.getItem(IG_COOKIE_STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed
            .map((item) => ({
                id: String(item?.id || '').trim(),
                label: sanitizeInstagramCookieLabel(item?.label),
                cookie: String(item?.cookie || '').trim(),
                updatedAt: String(item?.updatedAt || ''),
            }))
            .filter((item) => item.id && item.label && item.cookie)
            .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
            .slice(0, IG_COOKIE_MAX_ITEMS);
    } catch (_) {
        return [];
    }
}

function writeSavedInstagramCookies(items) {
    const list = Array.isArray(items) ? items.slice(0, IG_COOKIE_MAX_ITEMS) : [];
    try {
        localStorage.setItem(IG_COOKIE_STORAGE_KEY, JSON.stringify(list));
        return true;
    } catch (_) {
        // ignore storage quota/private mode errors
        return false;
    }
}

function saveInstagramCookieDraft() {
    if (!igElements.cookie) return;
    try {
        localStorage.setItem(IG_COOKIE_DRAFT_KEY, igElements.cookie.value || '');
    } catch (_) {
        // ignore storage quota/private mode errors
    }
}

function restoreInstagramCookieDraft() {
    if (!igElements.cookie || igElements.cookie.value.trim()) return;
    try {
        const draft = String(localStorage.getItem(IG_COOKIE_DRAFT_KEY) || '');
        if (draft.trim()) {
            igElements.cookie.value = draft;
        }
    } catch (_) {
        // ignore storage/private mode errors
    }
}

function getSelectedInstagramCookieItem() {
    const selectedId = String(igElements.cookieSavedSelect?.value || '').trim();
    if (!selectedId) return null;
    const items = readSavedInstagramCookies();
    return items.find((item) => item.id === selectedId) || null;
}

function renderSavedInstagramCookieOptions(selectedId = '') {
    const select = igElements.cookieSavedSelect;
    if (!select) return;

    const items = readSavedInstagramCookies();
    select.innerHTML = '';

    const firstOption = document.createElement('option');
    firstOption.value = '';
    firstOption.textContent = items.length ? 'Pilih cookie tersimpan' : 'Belum ada cookie tersimpan';
    select.appendChild(firstOption);

    items.forEach((item) => {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = `${item.label} (${formatInstagramCookieTime(item.updatedAt)})`;
        select.appendChild(option);
    });

    if (selectedId && items.some((item) => item.id === selectedId)) {
        select.value = selectedId;
    } else {
        select.value = '';
    }
}

function applySelectedInstagramCookieToTextarea(options = {}) {
    const silent = Boolean(options.silent);
    const item = getSelectedInstagramCookieItem();
    if (!item) {
        if (!silent) {
            Swal.fire({ icon: 'warning', title: 'Belum dipilih', text: 'Pilih cookie tersimpan dulu.', background: '#1f2937', color: '#fff' });
        }
        return false;
    }
    if (igElements.cookie) igElements.cookie.value = item.cookie;
    if (igElements.cookieName && !igElements.cookieName.value.trim()) {
        igElements.cookieName.value = item.label;
    }
    saveInstagramCookieDraft();
    if (!silent) {
        Swal.fire({ icon: 'success', title: 'Cookie dipakai', text: `Cookie "${item.label}" dimuat ke form.`, background: '#1f2937', color: '#fff' });
    }
    return true;
}

function onInstagramCookieSelectionChange() {
    applySelectedInstagramCookieToTextarea({ silent: true });
}

function onInstagramCookieSaveClick() {
    if (!igElements.cookie) return;
    const cookie = igElements.cookie.value.trim();
    if (!cookie) {
        Swal.fire({ icon: 'warning', title: 'Cookie kosong', text: 'Isi cookie dulu sebelum disimpan.', background: '#1f2937', color: '#fff' });
        return;
    }

    let label = sanitizeInstagramCookieLabel(igElements.cookieName?.value || '');
    if (!label) label = defaultInstagramCookieLabel();

    const nowIso = new Date().toISOString();
    const items = readSavedInstagramCookies();
    let selectedId = String(igElements.cookieSavedSelect?.value || '').trim();
    let targetIndex = selectedId ? items.findIndex((item) => item.id === selectedId) : -1;

    if (targetIndex < 0) {
        targetIndex = items.findIndex((item) => item.cookie === cookie);
    }

    if (targetIndex >= 0) {
        items[targetIndex] = {
            ...items[targetIndex],
            label,
            cookie,
            updatedAt: nowIso,
        };
        selectedId = items[targetIndex].id;
    } else {
        selectedId = `igc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        items.unshift({
            id: selectedId,
            label,
            cookie,
            updatedAt: nowIso,
        });
    }

    const normalized = items
        .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
        .slice(0, IG_COOKIE_MAX_ITEMS);

    const writeOk = writeSavedInstagramCookies(normalized);
    if (!writeOk) {
        Swal.fire({ icon: 'error', title: 'Gagal simpan', text: 'Browser menolak penyimpanan localStorage.', background: '#1f2937', color: '#fff' });
        return;
    }
    renderSavedInstagramCookieOptions(selectedId);
    if (igElements.cookieName) igElements.cookieName.value = label;
    saveInstagramCookieDraft();

    Swal.fire({ icon: 'success', title: 'Tersimpan', text: `Cookie "${label}" berhasil disimpan.`, background: '#1f2937', color: '#fff' });
}

async function onInstagramCookieDeleteClick() {
    const item = getSelectedInstagramCookieItem();
    if (!item) {
        Swal.fire({ icon: 'warning', title: 'Belum dipilih', text: 'Pilih cookie tersimpan yang mau dihapus.', background: '#1f2937', color: '#fff' });
        return;
    }

    const confirm = await Swal.fire({
        title: 'Hapus cookie tersimpan?',
        text: item.label,
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#ef4444',
        cancelButtonColor: '#374151',
        confirmButtonText: 'Hapus',
        background: '#1f2937',
        color: '#fff'
    });
    if (!confirm.isConfirmed) return;

    const items = readSavedInstagramCookies().filter((row) => row.id !== item.id);
    const writeOk = writeSavedInstagramCookies(items);
    if (!writeOk) {
        Swal.fire({ icon: 'error', title: 'Gagal hapus', text: 'Browser menolak update localStorage.', background: '#1f2937', color: '#fff' });
        return;
    }
    renderSavedInstagramCookieOptions();

    if (igElements.cookieName && igElements.cookieName.value.trim() === item.label) {
        igElements.cookieName.value = '';
    }

    Swal.fire({ icon: 'success', title: 'Dihapus', text: `Cookie "${item.label}" sudah dihapus.`, background: '#1f2937', color: '#fff' });
}

function parseUrlStreamDestinations() {
    const raw = String(urlStreamElements.destinations?.value || '');
    return raw
        .split(/\n|,/g)
        .map((value) => value.trim())
        .filter((value) => value && /^rtmps?:\/\//i.test(value));
}

function renderUrlStreamStatus(status) {
    if (!urlStreamElements.status) return;
    const running = Boolean(status?.running);
    const lines = running
        ? [
            `running: yes`,
            `streamId: ${status.streamId || '-'}`,
            `provider: ${status.sourceProvider || '-'}`,
            `pid: ${status.pid || '-'}`,
            `startTime: ${status.startTime || '-'}`,
            `sourceUrl: ${status.sourceUrl || '-'}`,
        ]
        : ['running: no', 'URL stream offline.'];
    urlStreamElements.status.innerText = lines.join('\n');

    if (urlStreamElements.pill) {
        const dot = running ? 'bg-green-500' : 'bg-gray-500';
        const label = running ? 'ONLINE' : 'OFFLINE';
        urlStreamElements.pill.innerHTML = `<span class="w-2 h-2 rounded-full ${dot}"></span><span>${label}</span>`;
    }
}

async function refreshUrlStreamStatus() {
    if (!urlStreamElements.status) return;
    try {
        const resp = await fetch('/api/stream/url-status');
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) {
            throw new Error(data.error || 'Failed to load URL stream status');
        }
        renderUrlStreamStatus(data.status || {});
    } catch (err) {
        renderUrlStreamStatus({ running: false });
        urlStreamElements.status.innerText = `status error: ${err.message}`;
    }
}

async function onUrlStreamStartClick() {
    const sourceUrl = String(urlStreamElements.source?.value || '').trim();
    const destinations = parseUrlStreamDestinations();

    if (!sourceUrl) {
        Swal.fire({ icon: 'warning', title: 'Source URL kosong', text: 'Isi link YouTube atau direct video URL dulu.', background: '#1f2937', color: '#fff' });
        return;
    }
    if (!/^https?:\/\//i.test(sourceUrl)) {
        Swal.fire({ icon: 'warning', title: 'URL tidak valid', text: 'Gunakan URL http/https yang valid.', background: '#1f2937', color: '#fff' });
        return;
    }
    if (!destinations.length) {
        Swal.fire({ icon: 'warning', title: 'RTMP kosong', text: 'Isi minimal satu destination RTMP.', background: '#1f2937', color: '#fff' });
        return;
    }

    setButtonLoading(urlStreamElements.startBtn, true, 'Starting...', 'Start URL Stream');
    try {
        const resp = await fetch('/api/stream/start-url', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sourceUrl,
                customRtmp: destinations,
                settings: {
                    resolution: urlStreamElements.res?.value || '1280x720',
                    fps: urlStreamElements.fps?.value || '30',
                    bitrate: urlStreamElements.bitrate?.value || '3500k',
                },
            }),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || data.ok === false) {
            throw new Error(data.error || 'Failed to start URL stream');
        }
        await refreshUrlStreamStatus();
        Swal.fire({
            icon: 'success',
            title: 'URL Stream Started',
            text: `Source ${data.sourceProvider || '-'} sudah berjalan ke RTMP tujuan.`,
            background: '#1f2937',
            color: '#fff'
        });
    } catch (err) {
        Swal.fire({ icon: 'error', title: 'Start Failed', text: err.message, background: '#1f2937', color: '#fff' });
    } finally {
        setButtonLoading(urlStreamElements.startBtn, false, '', 'Start URL Stream');
    }
}

async function onUrlStreamStopClick() {
    setButtonLoading(urlStreamElements.stopBtn, true, 'Stopping...', 'Stop');
    try {
        const resp = await fetch('/api/stream/stop-url', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || data.ok === false) {
            throw new Error(data.error || 'Failed to stop URL stream');
        }
        await refreshUrlStreamStatus();
        Swal.fire({ icon: 'success', title: 'Stopped', text: 'URL stream dihentikan.', background: '#1f2937', color: '#fff' });
    } catch (err) {
        Swal.fire({ icon: 'error', title: 'Stop Failed', text: err.message, background: '#1f2937', color: '#fff' });
    } finally {
        setButtonLoading(urlStreamElements.stopBtn, false, '', 'Stop');
    }
}

function initUrlStreamPanel() {
    if (!urlStreamElements.status) return;
    urlStreamElements.startBtn?.addEventListener('click', onUrlStreamStartClick);
    urlStreamElements.stopBtn?.addEventListener('click', onUrlStreamStopClick);
    refreshUrlStreamStatus();
    urlStreamTimer = setInterval(() => {
        if (!document.hidden) refreshUrlStreamStatus();
    }, URL_STREAM_REFRESH_INTERVAL);
}

function initInstagramPanel() {
    if (!igElements.status) return;

    renderSavedInstagramCookieOptions();
    restoreInstagramCookieDraft();

    igElements.cookie?.addEventListener('input', saveInstagramCookieDraft);
    igElements.cookieSavedSelect?.addEventListener('change', onInstagramCookieSelectionChange);
    igElements.cookieSaveBtn?.addEventListener('click', onInstagramCookieSaveClick);
    igElements.cookieApplyBtn?.addEventListener('click', () => applySelectedInstagramCookieToTextarea({ silent: false }));
    igElements.cookieDeleteBtn?.addEventListener('click', onInstagramCookieDeleteClick);
    igElements.loginBtn?.addEventListener('click', onInstagramLoginClick);
    igElements.loginAccountBtn?.addEventListener('click', onInstagramAccountLoginClick);
    igElements.loginPassword?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            onInstagramAccountLoginClick();
        }
    });
    igElements.challengeVerifyBtn?.addEventListener('click', onInstagramChallengeVerifyClick);
    igElements.challengeCode?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            onInstagramChallengeVerifyClick();
        }
    });
    igElements.setupBtn?.addEventListener('click', onInstagramSetupClick);
    igElements.startBtn?.addEventListener('click', onInstagramStartStopClick);
    igElements.goBtn?.addEventListener('click', onInstagramGoLiveClick);
    igElements.endBtn?.addEventListener('click', onInstagramEndLiveClick);
    igElements.commentsRefreshBtn?.addEventListener('click', refreshInstagramComments);
    igElements.commentSendBtn?.addEventListener('click', onInstagramSendCommentClick);
    igElements.autoReplySaveBtn?.addEventListener('click', onInstagramAutoReplySaveClick);
    igElements.autoReplyRunOnceBtn?.addEventListener('click', onInstagramAutoReplyRunOnceClick);
    igElements.autoReplyRefreshBtn?.addEventListener('click', refreshInstagramAutoReplySettings);

    refreshInstagramStatus();
    refreshInstagramComments();
    refreshInstagramAutoReplySettings();
    igStatusTimer = setInterval(() => {
        if (!document.hidden) refreshInstagramStatus();
    }, IG_REFRESH_INTERVAL);
    igCommentsTimer = setInterval(() => {
        if (!document.hidden) refreshInstagramComments();
    }, IG_COMMENTS_REFRESH_INTERVAL);
}

function getMultiChatPlatform() {
    const val = String(mpElements.platform?.value || 'youtube').trim().toLowerCase();
    return val === 'facebook' ? 'facebook' : 'youtube';
}

function collectMultiChatSettings() {
    return {
        youtube: {
            streamId: mpElements.ytStreamId?.value?.trim() || '',
            liveChatId: mpElements.ytLiveChatId?.value?.trim() || '',
            accessToken: mpElements.ytAccessToken?.value?.trim() || '',
            apiKey: mpElements.ytApiKey?.value?.trim() || '',
            selfChannelId: mpElements.ytSelfChannelId?.value?.trim() || '',
        },
        facebook: {
            liveVideoId: mpElements.fbLiveVideoId?.value?.trim() || '',
            pageAccessToken: mpElements.fbPageToken?.value?.trim() || '',
            pageId: mpElements.fbPageId?.value?.trim() || '',
        },
    };
}

function applyMultiChatSettings(settings) {
    const cfg = settings || {};
    const yt = cfg.youtube || {};
    const fb = cfg.facebook || {};
    if (mpElements.ytStreamId) mpElements.ytStreamId.value = yt.streamId || '';
    if (mpElements.ytLiveChatId) mpElements.ytLiveChatId.value = yt.liveChatId || '';
    if (mpElements.ytApiKey) mpElements.ytApiKey.value = yt.apiKey || '';
    if (mpElements.ytAccessToken) mpElements.ytAccessToken.value = yt.accessToken || '';
    if (mpElements.ytSelfChannelId) mpElements.ytSelfChannelId.value = yt.selfChannelId || '';
    if (mpElements.fbLiveVideoId) mpElements.fbLiveVideoId.value = fb.liveVideoId || '';
    if (mpElements.fbPageToken) mpElements.fbPageToken.value = fb.pageAccessToken || '';
    if (mpElements.fbPageId) mpElements.fbPageId.value = fb.pageId || '';
}

function renderMultiChatComments(items, platform) {
    if (!mpElements.commentsList) return;
    const list = Array.isArray(items) ? items : [];
    if (!list.length) {
        mpElements.commentsList.innerHTML = 'Belum ada komentar live.';
        return;
    }
    mpElements.commentsList.innerHTML = list
        .slice(-80)
        .map((item) => {
            const user = String(item.username || 'unknown').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const text = String(item.text || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            return `<div class="border-b border-gray-200 py-1"><span class="font-black">[${platform}] @${user}</span>: <span>${text}</span></div>`;
        })
        .join('');
    mpElements.commentsList.scrollTop = mpElements.commentsList.scrollHeight;
}

function renderMultiChatStatus() {
    if (!mpElements.status) return;
    const platform = getMultiChatPlatform();
    const settings = multiChatState.settings || {};
    const auto = multiChatState.autoReply || {};
    const yt = settings.youtube || {};
    const fb = settings.facebook || {};
    const ytReady = Boolean((yt.streamId || yt.liveChatId) && (yt.apiKey || yt.accessToken));
    const fbReady = Boolean(fb.liveVideoId && fb.pageAccessToken);
    const lastAt = multiChatState.lastFetchedAt[platform] || '-';
    const lines = [
        `activePlatform: ${platform}`,
        `youtubeConfigured: ${ytReady ? 'yes' : 'no'} | facebookConfigured: ${fbReady ? 'yes' : 'no'}`,
        `autoReply: ${auto.enabled ? `ON (${auto.mode || '-'})` : 'OFF'} | mistral: ${auto.mistralConfigured ? 'ready' : 'not-set'}`,
        `lastFetchedAt(${platform}): ${lastAt}`,
        `${multiChatState.lastError ? `lastError: ${multiChatState.lastError}` : ''}`.trim(),
    ];
    mpElements.status.innerText = lines.filter(Boolean).join('\n');

    if (mpElements.pill) {
        const ok = !multiChatState.lastError;
        mpElements.pill.innerHTML = `<span class="w-2 h-2 rounded-full ${ok ? 'bg-green-500' : 'bg-amber-500'}"></span><span>${ok ? `${platform.toUpperCase()} READY` : `${platform.toUpperCase()} WARN`}</span>`;
    }
}

function collectMultiChatAutoReplyPayload() {
    return {
        enabled: Boolean(mpElements.autoReplyEnabled?.checked),
        mode: mpElements.autoReplyMode?.value || 'template_first',
        cooldownSec: Number(mpElements.autoReplyCooldown?.value || 20),
        maxRepliesPerUser: Number(mpElements.autoReplyMaxUser?.value || 2),
        repliesPerComment: Number(mpElements.autoReplyRepliesPerComment?.value || 1),
        followUpEnabled: Boolean(mpElements.autoReplyFollowUpEnabled?.checked),
        followUpDelaySec: Number(mpElements.autoReplyFollowUpDelay?.value || 18),
        pollMs: Number(mpElements.autoReplyPollMs?.value || 7000),
        priceText: mpElements.autoReplyPrice?.value?.trim() || '',
        systemPrompt: mpElements.autoReplySystem?.value?.trim() || '',
        platforms: {
            youtube: Boolean(mpElements.autoReplyPlatformYoutube?.checked),
            facebook: Boolean(mpElements.autoReplyPlatformFacebook?.checked),
        },
        templates: parseAutoReplyTemplatesText(mpElements.autoReplyTemplates?.value || ''),
        followUpTemplates: parseFollowUpTemplatesText(mpElements.autoReplyFollowUpTemplates?.value || ''),
    };
}

function applyMultiChatAutoReplySettings(settings) {
    const cfg = settings || {};
    const platforms = cfg.platforms || {};
    if (mpElements.autoReplyEnabled) mpElements.autoReplyEnabled.checked = Boolean(cfg.enabled);
    if (mpElements.autoReplyMode) mpElements.autoReplyMode.value = cfg.mode || 'template_first';
    if (mpElements.autoReplyCooldown) mpElements.autoReplyCooldown.value = Number(cfg.cooldownSec || 20);
    if (mpElements.autoReplyMaxUser) mpElements.autoReplyMaxUser.value = Number(cfg.maxRepliesPerUser || 2);
    if (mpElements.autoReplyRepliesPerComment) mpElements.autoReplyRepliesPerComment.value = Number(cfg.repliesPerComment || 1);
    if (mpElements.autoReplyFollowUpEnabled) mpElements.autoReplyFollowUpEnabled.checked = Boolean(cfg.followUpEnabled);
    if (mpElements.autoReplyFollowUpDelay) mpElements.autoReplyFollowUpDelay.value = Number(cfg.followUpDelaySec || 18);
    if (mpElements.autoReplyPollMs) mpElements.autoReplyPollMs.value = Number(cfg.pollMs || 7000);
    if (mpElements.autoReplyPrice) mpElements.autoReplyPrice.value = cfg.priceText || '';
    if (mpElements.autoReplySystem) mpElements.autoReplySystem.value = cfg.systemPrompt || '';
    if (mpElements.autoReplyPlatformYoutube) mpElements.autoReplyPlatformYoutube.checked = Boolean(platforms.youtube ?? true);
    if (mpElements.autoReplyPlatformFacebook) mpElements.autoReplyPlatformFacebook.checked = Boolean(platforms.facebook ?? true);
    if (mpElements.autoReplyTemplates) mpElements.autoReplyTemplates.value = stringifyAutoReplyTemplates(cfg.templates || []);
    if (mpElements.autoReplyFollowUpTemplates) mpElements.autoReplyFollowUpTemplates.value = stringifyFollowUpTemplates(cfg.followUpTemplates || []);
}

function renderMultiChatAutoReplyStatus(settings) {
    const cfg = settings || {};
    if (mpElements.autoReplyStatus) {
        const lines = [
            `enabled: ${cfg.enabled ? 'yes' : 'no'} | mode: ${cfg.mode || '-'}`,
            `platforms: yt=${cfg.platforms?.youtube ? 'on' : 'off'} fb=${cfg.platforms?.facebook ? 'on' : 'off'}`,
            `cooldown: ${cfg.cooldownSec || 0}s | maxRepliesPerUser: ${cfg.maxRepliesPerUser || 0} | pollMs: ${cfg.pollMs || 0}`,
            `repliesPerComment: ${cfg.repliesPerComment || 1} | followUp: ${cfg.followUpEnabled ? `ON (${cfg.followUpDelaySec || 0}s)` : 'OFF'}`,
            `templates: ${(cfg.templates || []).length} | followUpTemplates: ${(cfg.followUpTemplates || []).length} | mistralConfigured: ${cfg.mistralConfigured ? 'yes' : 'no'}`,
            `pendingFollowUps: ${cfg.pendingFollowUps || 0}`,
            `lastRunAt: ${cfg.lastRunAt || '-'}`,
            `lastReplyAt: ${cfg.lastReplyAt || '-'}`,
            `${cfg.lastError ? `lastError: ${cfg.lastError}` : ''}`.trim(),
        ];
        mpElements.autoReplyStatus.innerText = lines.filter(Boolean).join('\n');
    }
    if (mpElements.autoReplyPill) {
        const on = Boolean(cfg.enabled);
        mpElements.autoReplyPill.innerHTML = `<span class="w-2 h-2 rounded-full ${on ? 'bg-green-500' : 'bg-gray-500'}"></span><span>${on ? 'AUTO ON' : 'AUTO OFF'}</span>`;
    }
}

async function callMultiChatApi(url, method = 'GET', body = null) {
    const options = { method, headers: {} };
    if (method !== 'GET') {
        options.headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(body || {});
    }
    const resp = await fetch(url, options);
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.ok === false) {
        throw new Error(data.error || 'Multi chat API request failed.');
    }
    return data;
}

async function refreshMultiChatSettings() {
    if (!mpElements.status) return;
    try {
        const data = await callMultiChatApi('/api/multichat/settings');
        multiChatState.settings = data.result || {};
        multiChatState.lastError = '';
        applyMultiChatSettings(multiChatState.settings);
    } catch (err) {
        multiChatState.lastError = err.message;
    } finally {
        renderMultiChatStatus();
    }
}

async function refreshMultiChatAutoReplySettings() {
    if (!mpElements.autoReplyStatus) return;
    try {
        const data = await callMultiChatApi('/api/multichat/auto-reply/settings');
        multiChatState.autoReply = data.result || {};
        multiChatState.lastError = '';
        renderMultiChatAutoReplyStatus(multiChatState.autoReply);
        applyMultiChatAutoReplySettings(multiChatState.autoReply);
    } catch (err) {
        multiChatState.lastError = err.message;
        mpElements.autoReplyStatus.innerText = `auto-reply error: ${err.message}`;
    } finally {
        renderMultiChatStatus();
    }
}

async function refreshMultiChatComments() {
    if (!mpElements.commentsList) return;
    const platform = getMultiChatPlatform();
    try {
        const data = await callMultiChatApi(`/api/multichat/${platform}/comments?limit=80`);
        const result = data.result || {};
        multiChatState.lastFetchedAt[platform] = result.fetchedAt || new Date().toISOString();
        multiChatState.lastError = '';
        renderMultiChatComments(result.items || [], platform);
    } catch (err) {
        multiChatState.lastError = err.message;
        mpElements.commentsList.innerHTML = `comments error: ${err.message}`;
    } finally {
        renderMultiChatStatus();
    }
}

async function onMultiChatSaveSettingsClick() {
    setButtonLoading(mpElements.saveBtn, true, 'Saving...', 'Save Chat API Setting');
    try {
        const payload = collectMultiChatSettings();
        const data = await callMultiChatApi('/api/multichat/settings', 'POST', payload);
        multiChatState.settings = data.result || {};
        multiChatState.lastError = '';
        applyMultiChatSettings(multiChatState.settings);
        renderMultiChatStatus();
        Swal.fire({ icon: 'success', title: 'Saved', text: 'Setting YouTube/Facebook chat tersimpan.', background: '#1f2937', color: '#fff' });
    } catch (err) {
        multiChatState.lastError = err.message;
        renderMultiChatStatus();
        Swal.fire({ icon: 'error', title: 'Save Failed', text: err.message, background: '#1f2937', color: '#fff' });
    } finally {
        setButtonLoading(mpElements.saveBtn, false, '', 'Save Chat API Setting');
    }
}

async function onMultiChatSendCommentClick() {
    const platform = getMultiChatPlatform();
    const message = mpElements.commentInput?.value?.trim() || '';
    if (!message) {
        Swal.fire({ icon: 'warning', title: 'Komentar kosong', text: 'Isi komentar dulu.', background: '#1f2937', color: '#fff' });
        return;
    }
    setButtonLoading(mpElements.commentSendBtn, true, 'Sending...', 'Send Comment');
    try {
        const data = await callMultiChatApi(`/api/multichat/${platform}/comment`, 'POST', { message });
        const result = data.result || {};
        if (mpElements.commentInput) mpElements.commentInput.value = '';
        multiChatState.lastError = '';
        renderMultiChatComments(result.items || [], platform);
        Swal.fire({ icon: 'success', title: 'Comment Sent', text: `Komentar terkirim ke ${platform}.`, background: '#1f2937', color: '#fff' });
    } catch (err) {
        multiChatState.lastError = err.message;
        Swal.fire({ icon: 'error', title: 'Send Failed', text: err.message, background: '#1f2937', color: '#fff' });
    } finally {
        setButtonLoading(mpElements.commentSendBtn, false, '', 'Send Comment');
        renderMultiChatStatus();
    }
}

async function onMultiChatAutoReplySaveClick() {
    const payload = collectMultiChatAutoReplyPayload();
    setButtonLoading(mpElements.autoReplySaveBtn, true, 'Saving...', 'Save Auto Reply');
    try {
        const data = await callMultiChatApi('/api/multichat/auto-reply/settings', 'POST', payload);
        multiChatState.autoReply = data.result || {};
        multiChatState.lastError = '';
        renderMultiChatAutoReplyStatus(multiChatState.autoReply);
        Swal.fire({ icon: 'success', title: 'Saved', text: 'Setting auto-reply YouTube/Facebook tersimpan.', background: '#1f2937', color: '#fff' });
    } catch (err) {
        multiChatState.lastError = err.message;
        renderMultiChatStatus();
        Swal.fire({ icon: 'error', title: 'Save Failed', text: err.message, background: '#1f2937', color: '#fff' });
    } finally {
        setButtonLoading(mpElements.autoReplySaveBtn, false, '', 'Save Auto Reply');
        renderMultiChatStatus();
    }
}

async function onMultiChatAutoReplyRunOnceClick() {
    setButtonLoading(mpElements.autoReplyRunOnceBtn, true, 'Running...', 'Run Once');
    try {
        const data = await callMultiChatApi('/api/multichat/auto-reply/run-once', 'POST', {});
        multiChatState.autoReply = data.result || {};
        multiChatState.lastError = '';
        renderMultiChatAutoReplyStatus(multiChatState.autoReply);
        await refreshMultiChatComments();
        Swal.fire({ icon: 'success', title: 'Run Once', text: 'Auto-reply multi-platform sudah dijalankan.', background: '#1f2937', color: '#fff' });
    } catch (err) {
        multiChatState.lastError = err.message;
        Swal.fire({ icon: 'error', title: 'Run Failed', text: err.message, background: '#1f2937', color: '#fff' });
    } finally {
        setButtonLoading(mpElements.autoReplyRunOnceBtn, false, '', 'Run Once');
        renderMultiChatStatus();
    }
}

function initMultiChatPanel() {
    if (!mpElements.status) return;
    mpElements.refreshBtn?.addEventListener('click', refreshMultiChatComments);
    mpElements.saveBtn?.addEventListener('click', onMultiChatSaveSettingsClick);
    mpElements.commentSendBtn?.addEventListener('click', onMultiChatSendCommentClick);
    mpElements.platform?.addEventListener('change', refreshMultiChatComments);
    mpElements.autoReplySaveBtn?.addEventListener('click', onMultiChatAutoReplySaveClick);
    mpElements.autoReplyRunOnceBtn?.addEventListener('click', onMultiChatAutoReplyRunOnceClick);
    mpElements.autoReplyRefreshBtn?.addEventListener('click', refreshMultiChatAutoReplySettings);

    refreshMultiChatSettings();
    refreshMultiChatAutoReplySettings();
    refreshMultiChatComments();
    mpCommentsTimer = setInterval(() => {
        if (!document.hidden) refreshMultiChatComments();
    }, MP_COMMENTS_REFRESH_INTERVAL);
}

async function callInstagramApi(url, body) {
    const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.ok === false) {
        throw new Error(data.error || 'Instagram API request failed.');
    }
    return data;
}

function setButtonLoading(button, loading, loadingText, normalHtml) {
    if (!button) return;
    if (loading) {
        button.disabled = true;
        button.innerHTML = `<i class="fas fa-circle-notch fa-spin"></i> ${loadingText}`;
    } else {
        button.disabled = false;
        button.innerHTML = normalHtml;
    }
}

function updateInstagramStartButton(isRunning) {
    if (!igElements.startBtn) return;
    igElements.startBtn.setAttribute('data-running', String(Boolean(isRunning)));
    igElements.startBtn.disabled = false;
    if (isRunning) {
        igElements.startBtn.className = 'w-full bg-red-500 hover:bg-red-600 border-2 border-black font-black text-xs py-2 uppercase shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] active:shadow-none active:translate-x-[2px] active:translate-y-[2px] transition-all text-white';
        igElements.startBtn.innerHTML = 'Stop IG Stream';
    } else {
        igElements.startBtn.className = 'w-full bg-cyan-400 hover:bg-cyan-300 border-2 border-black font-black text-xs py-2 uppercase shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] active:shadow-none active:translate-x-[2px] active:translate-y-[2px] transition-all';
        igElements.startBtn.innerHTML = 'Start IG Stream';
    }
}

function getInstagramMirrorDestinations() {
    const raw = igElements.multiRtmp?.value || '';
    return String(raw)
        .split(/\n|,/g)
        .map((x) => x.trim())
        .filter((x) => x && /^rtmps?:\/\//i.test(x));
}

function renderInstagramComments(items) {
    if (!igElements.commentsList) return;
    const list = Array.isArray(items) ? items : [];
    if (!list.length) {
        igElements.commentsList.innerHTML = 'Belum ada komentar live.';
        return;
    }

    igElements.commentsList.innerHTML = list
        .slice(-80)
        .map((item) => {
            const user = String(item.username || 'unknown').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const text = String(item.text || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            return `<div class="border-b border-gray-200 py-1"><span class="font-black">@${user}</span>: <span>${text}</span></div>`;
        })
        .join('');
    igElements.commentsList.scrollTop = igElements.commentsList.scrollHeight;
}

function parseAutoReplyTemplatesText(text) {
    const rows = String(text || '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    const out = [];
    rows.forEach((line, idx) => {
        const split = line.split('|');
        if (split.length < 2) return;
        const keys = split[0]
            .split(',')
            .map((x) => x.trim().toLowerCase())
            .filter(Boolean);
        const reply = split.slice(1).join('|').trim();
        if (!keys.length || !reply) return;
        out.push({
            id: `tpl-${idx + 1}`,
            keywords: keys,
            reply
        });
    });
    return out;
}

function stringifyAutoReplyTemplates(templates) {
    const list = Array.isArray(templates) ? templates : [];
    return list
        .map((item) => `${(item.keywords || []).join(',')} | ${item.reply || ''}`)
        .join('\n');
}

function parseFollowUpTemplatesText(text) {
    return String(text || '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 20);
}

function stringifyFollowUpTemplates(templates) {
    const list = Array.isArray(templates) ? templates : [];
    return list
        .map((item) => String(item || '').trim())
        .filter(Boolean)
        .join('\n');
}

function collectAutoReplyPayload() {
    return {
        enabled: Boolean(igElements.autoReplyEnabled?.checked),
        mode: igElements.autoReplyMode?.value || 'template_first',
        cooldownSec: Number(igElements.autoReplyCooldown?.value || 20),
        maxRepliesPerUser: Number(igElements.autoReplyMaxUser?.value || 2),
        repliesPerComment: Number(igElements.autoReplyRepliesPerComment?.value || 1),
        followUpEnabled: Boolean(igElements.autoReplyFollowUpEnabled?.checked),
        followUpDelaySec: Number(igElements.autoReplyFollowUpDelay?.value || 18),
        priceText: igElements.autoReplyPrice?.value?.trim() || '',
        systemPrompt: igElements.autoReplySystem?.value?.trim() || '',
        templates: parseAutoReplyTemplatesText(igElements.autoReplyTemplates?.value || ''),
        followUpTemplates: parseFollowUpTemplatesText(igElements.autoReplyFollowUpTemplates?.value || ''),
    };
}

function applyAutoReplySettingsToForm(settings) {
    const cfg = settings || {};
    if (igElements.autoReplyEnabled) igElements.autoReplyEnabled.checked = Boolean(cfg.enabled);
    if (igElements.autoReplyMode) igElements.autoReplyMode.value = cfg.mode || 'template_first';
    if (igElements.autoReplyCooldown) igElements.autoReplyCooldown.value = Number(cfg.cooldownSec || 20);
    if (igElements.autoReplyMaxUser) igElements.autoReplyMaxUser.value = Number(cfg.maxRepliesPerUser || 2);
    if (igElements.autoReplyRepliesPerComment) igElements.autoReplyRepliesPerComment.value = Number(cfg.repliesPerComment || 1);
    if (igElements.autoReplyFollowUpEnabled) igElements.autoReplyFollowUpEnabled.checked = Boolean(cfg.followUpEnabled);
    if (igElements.autoReplyFollowUpDelay) igElements.autoReplyFollowUpDelay.value = Number(cfg.followUpDelaySec || 18);
    if (igElements.autoReplyPrice) igElements.autoReplyPrice.value = cfg.priceText || '';
    if (igElements.autoReplySystem) igElements.autoReplySystem.value = cfg.systemPrompt || '';
    if (igElements.autoReplyTemplates) igElements.autoReplyTemplates.value = stringifyAutoReplyTemplates(cfg.templates || []);
    if (igElements.autoReplyFollowUpTemplates) igElements.autoReplyFollowUpTemplates.value = stringifyFollowUpTemplates(cfg.followUpTemplates || []);
}

function renderAutoReplyStatus(settings) {
    const cfg = settings || {};
    if (igElements.autoReplyStatus) {
        const lines = [
            `enabled: ${cfg.enabled ? 'yes' : 'no'} | mode: ${cfg.mode || '-'}`,
            `cooldown: ${cfg.cooldownSec || 0}s | maxRepliesPerUser: ${cfg.maxRepliesPerUser || 0}`,
            `repliesPerComment: ${cfg.repliesPerComment || 1} | followUp: ${cfg.followUpEnabled ? `ON (${cfg.followUpDelaySec || 0}s)` : 'OFF'}`,
            `templates: ${(cfg.templates || []).length} | followUpTemplates: ${(cfg.followUpTemplates || []).length} | mistralConfigured: ${cfg.mistralConfigured ? 'yes' : 'no'}`,
            `pendingFollowUps: ${cfg.pendingFollowUps || 0}`,
            `lastRunAt: ${cfg.lastRunAt || '-'}`,
            `lastReplyAt: ${cfg.lastReplyAt || '-'}`,
            `${cfg.lastError ? `lastError: ${cfg.lastError}` : ''}`.trim(),
        ];
        igElements.autoReplyStatus.innerText = lines.filter(Boolean).join('\n');
    }
    if (igElements.autoReplyPill) {
        const on = Boolean(cfg.enabled);
        igElements.autoReplyPill.innerHTML = `<span class="w-2 h-2 rounded-full ${on ? 'bg-green-500' : 'bg-gray-500'}"></span><span>${on ? 'AUTO ON' : 'AUTO OFF'}</span>`;
    }
}

function renderInstagramStatus(status) {
    if (!igElements.status) return;
    const ffmpegOnline = Boolean(status.ffmpeg.online || status.ffmpeg.running || status.ffmpeg.restarting);
    const ffmpegRunning = Boolean(status.ffmpeg.running);
    const ffmpegRestarting = Boolean(status.ffmpeg.restarting);
    const challengePending = Boolean(status.authChallenge?.pending);
    const challengeLabel = challengePending
        ? `${status.authChallenge?.type || 'challenge'}${status.authChallenge?.hasCodeInput ? ' (needs OTP)' : ''}`
        : 'none';
    const lines = [
        `loggedIn: ${status.loggedIn ? 'yes' : 'no'}${status.username ? ` (@${status.username})` : ''}`,
        `authChallenge: ${challengeLabel}`,
        `liveSetup: ${status.live.streamUrlReady && status.live.streamKeyReady ? 'ready' : 'not-ready'}`,
        `goLiveReady: ${status.live.goLiveReady ? 'yes' : 'no'} | isLive: ${status.live.isLive ? 'yes' : 'no'} | onLiveSurface: ${status.live.onLiveSurface ? 'yes' : 'no'}`,
        `ffmpeg: ${ffmpegRunning ? `ONLINE pid=${status.ffmpeg.pid || '-'} videoId=${status.ffmpeg.videoId || '-'}` : (ffmpegRestarting ? `RECONNECTING attempt=${status.ffmpeg.restartCount || 0}` : 'OFFLINE')}`,
        `output: ${status.ffmpeg.resolution || '-'} @ ${status.ffmpeg.fps || '-'}fps (${status.ffmpeg.bitrate || '-'})`,
        `multiOutput: ${status.ffmpeg.destinationsCount || 0} destination(s)`,
        `chatSource: ${status.chat?.source || '-'} | chatCount: ${status.chat?.count || 0}`,
        `${challengePending && status.authChallenge?.message ? `challengeMsg: ${status.authChallenge.message}` : ''}`.trim(),
        `${status.live?.pageUrl ? `pageUrl: ${status.live.pageUrl}` : ''}`.trim(),
        `autoReply: ${status.autoReply?.enabled ? `ON (${status.autoReply.mode})` : 'OFF'} | mistral: ${status.autoReply?.mistralConfigured ? 'ready' : 'not-set'}`,
        `${status.ffmpeg.lastError ? `lastError: ${status.ffmpeg.lastError}` : ''}`.trim(),
    ];
    igElements.status.innerText = lines.filter(Boolean).join('\n');

    if (igElements.pill) {
        const dot = status.loggedIn ? 'bg-green-500' : 'bg-gray-500';
        const label = status.loggedIn ? 'Connected' : 'Disconnected';
        igElements.pill.innerHTML = `<span class="w-2 h-2 rounded-full ${dot}"></span><span>${label}</span>`;
    }
    if (igElements.ffmpegPill) {
        const dot = ffmpegRunning ? 'bg-green-500' : (ffmpegRestarting ? 'bg-amber-500' : 'bg-gray-500');
        const label = ffmpegRunning ? 'FFMPEG ONLINE' : (ffmpegRestarting ? 'FFMPEG RECONNECT' : 'FFMPEG OFFLINE');
        igElements.ffmpegPill.innerHTML = `<span class="w-2 h-2 rounded-full ${dot}"></span><span>${label}</span>`;
    }

    if (igElements.title && !igElements.title.value && status.live.title) {
        igElements.title.value = status.live.title;
    }
    if (igElements.audience && status.live.audience) {
        igElements.audience.value = status.live.audience;
    }
    if (igElements.streamUrl && !igElements.streamUrl.value && status.live.streamUrl) {
        igElements.streamUrl.value = status.live.streamUrl;
    }
    if (igElements.streamKey && !igElements.streamKey.value && status.live.streamKey) {
        igElements.streamKey.value = status.live.streamKey;
    }

    updateInstagramStartButton(ffmpegOnline);

    if (status.autoReply) {
        renderAutoReplyStatus(status.autoReply);
        if (!igAutoReplyLoaded) {
            applyAutoReplySettingsToForm(status.autoReply);
            igAutoReplyLoaded = true;
        }
    }
}

async function refreshInstagramStatus() {
    if (!igElements.status) return;
    try {
        const resp = await fetch('/api/instagram/status');
        const data = await resp.json();
        if (!resp.ok || data.ok === false) {
            throw new Error(data.error || 'Failed to load Instagram status');
        }
        renderInstagramStatus(data.status);
    } catch (err) {
        igElements.status.innerText = `status error: ${err.message}`;
    }
}

async function onInstagramLoginClick() {
    if (!igElements.cookie) return;
    let cookie = igElements.cookie.value.trim();
    if (!cookie) {
        applySelectedInstagramCookieToTextarea({ silent: true });
        cookie = igElements.cookie.value.trim();
    }
    if (!cookie) {
        Swal.fire({ icon: 'warning', title: 'Cookie kosong', text: 'Isi cookie dulu atau pilih dari cookie tersimpan.', background: '#1f2937', color: '#fff' });
        return;
    }

    setButtonLoading(igElements.loginBtn, true, 'Logging in...', 'Login via Cookie');
    try {
        await callInstagramApi('/api/instagram/session/login-cookie', { cookie: cookie || '' });
        saveInstagramCookieDraft();
        await refreshInstagramStatus();
        Swal.fire({ icon: 'success', title: 'Login Success', text: 'Cookie valid, sesi Instagram aktif.', background: '#1f2937', color: '#fff' });
    } catch (err) {
        Swal.fire({ icon: 'error', title: 'Login Failed', text: err.message, background: '#1f2937', color: '#fff' });
    } finally {
        setButtonLoading(igElements.loginBtn, false, '', 'Login via Cookie');
    }
}

async function onInstagramAccountLoginClick() {
    const username = String(igElements.loginUsername?.value || '').trim();
    const password = String(igElements.loginPassword?.value || '');
    if (!username || !password) {
        Swal.fire({
            icon: 'warning',
            title: 'Login belum lengkap',
            text: 'Isi username dan password Instagram dulu.',
            background: '#1f2937',
            color: '#fff'
        });
        return;
    }

    setButtonLoading(igElements.loginAccountBtn, true, 'Logging in...', 'Login via Instagram');
    try {
        const data = await callInstagramApi('/api/instagram/session/login-credentials', { username, password });
        if (data?.result?.requiresChallenge || data?.result?.challenge?.pending) {
            await refreshInstagramStatus();
            Swal.fire({
                icon: 'info',
                title: 'Challenge Terdeteksi',
                text: data?.result?.challenge?.message || 'Masukkan OTP pada kolom Verify OTP lalu klik tombol Verify OTP.',
                background: '#1f2937',
                color: '#fff'
            });
            return;
        }
        const returnedCookie = String(data?.result?.cookie || '').trim();
        if (returnedCookie && igElements.cookie) {
            igElements.cookie.value = returnedCookie;
            saveInstagramCookieDraft();
            if (igElements.cookieName && !igElements.cookieName.value.trim()) {
                igElements.cookieName.value = `IG @${String(data?.result?.username || username).replace(/^@/, '')}`;
            }
        }
        if (igElements.loginPassword) igElements.loginPassword.value = '';
        await refreshInstagramStatus();
        Swal.fire({
            icon: 'success',
            title: 'Login Success',
            text: `Berhasil login sebagai @${String(data?.result?.username || username).replace(/^@/, '')}.`,
            background: '#1f2937',
            color: '#fff'
        });
    } catch (err) {
        Swal.fire({ icon: 'error', title: 'Login Failed', text: err.message, background: '#1f2937', color: '#fff' });
    } finally {
        setButtonLoading(igElements.loginAccountBtn, false, '', 'Login via Instagram');
    }
}

async function onInstagramChallengeVerifyClick() {
    const code = String(igElements.challengeCode?.value || '').replace(/\s+/g, '').trim();
    if (!code) {
        Swal.fire({
            icon: 'warning',
            title: 'OTP kosong',
            text: 'Isi kode OTP / verification code dulu.',
            background: '#1f2937',
            color: '#fff'
        });
        return;
    }

    setButtonLoading(igElements.challengeVerifyBtn, true, 'Verifying...', 'Verify OTP');
    try {
        const data = await callInstagramApi('/api/instagram/session/challenge/verify', { code });
        const returnedCookie = String(data?.result?.cookie || '').trim();
        if (returnedCookie && igElements.cookie) {
            igElements.cookie.value = returnedCookie;
            saveInstagramCookieDraft();
            if (igElements.cookieName && !igElements.cookieName.value.trim()) {
                igElements.cookieName.value = `IG @${String(data?.result?.username || '').replace(/^@/, '') || 'verified'}`;
            }
        }
        if (igElements.challengeCode) igElements.challengeCode.value = '';
        if (igElements.loginPassword) igElements.loginPassword.value = '';
        await refreshInstagramStatus();
        Swal.fire({
            icon: 'success',
            title: 'OTP Verified',
            text: `Login berhasil${data?.result?.username ? ` sebagai @${String(data.result.username).replace(/^@/, '')}` : ''}.`,
            background: '#1f2937',
            color: '#fff'
        });
    } catch (err) {
        await refreshInstagramStatus();
        Swal.fire({ icon: 'error', title: 'Verify Failed', text: err.message, background: '#1f2937', color: '#fff' });
    } finally {
        setButtonLoading(igElements.challengeVerifyBtn, false, '', 'Verify OTP');
    }
}

async function onInstagramSetupClick() {
    const title = igElements.title?.value?.trim() || 'Live via StreamFire';
    const audience = igElements.audience?.value || 'Public';

    setButtonLoading(igElements.setupBtn, true, 'Setting up...', 'Setup Live (Get Key)');
    try {
        const data = await callInstagramApi('/api/instagram/live/setup', { title, audience });
        if (igElements.streamUrl && data.result?.streamUrl) {
            igElements.streamUrl.value = data.result.streamUrl;
        }
        if (igElements.streamKey && data.result?.streamKey) {
            igElements.streamKey.value = data.result.streamKey;
        }
        await refreshInstagramStatus();
        Swal.fire({ icon: 'success', title: 'Setup Complete', text: 'Stream URL/Key dari Instagram berhasil diambil.', background: '#1f2937', color: '#fff' });
    } catch (err) {
        Swal.fire({ icon: 'error', title: 'Setup Failed', text: err.message, background: '#1f2937', color: '#fff' });
    } finally {
        setButtonLoading(igElements.setupBtn, false, '', 'Setup Live (Get Key)');
    }
}

async function onInstagramStartStopClick() {
    const running = igElements.startBtn?.getAttribute('data-running') === 'true';
    const videoId = Number(igElements.video?.value || 0);
    const streamUrl = igElements.streamUrl?.value?.trim() || '';
    const streamKey = igElements.streamKey?.value?.trim() || '';

    if (running) {
        setButtonLoading(igElements.startBtn, true, 'Stopping...', 'Stop IG Stream');
        try {
            await callInstagramApi('/api/instagram/stream/stop', {});
            await refreshInstagramStatus();
            Swal.fire({ icon: 'success', title: 'Stopped', text: 'IG stream dihentikan.', background: '#1f2937', color: '#fff' });
        } catch (err) {
            Swal.fire({ icon: 'error', title: 'Stop Failed', text: err.message, background: '#1f2937', color: '#fff' });
        } finally {
            await refreshInstagramStatus();
        }
        return;
    }

    if (!videoId) {
        Swal.fire({ icon: 'warning', title: 'Video Required', text: 'Pilih video StreamFire dulu.', background: '#1f2937', color: '#fff' });
        return;
    }
    if (!streamUrl && !streamKey) {
        Swal.fire({ icon: 'warning', title: 'Stream Key Missing', text: 'Jalankan Setup Live dulu atau isi manual Stream URL + Key.', background: '#1f2937', color: '#fff' });
        return;
    }

    setButtonLoading(igElements.startBtn, true, 'Starting...', 'Start IG Stream');
    try {
        await callInstagramApi('/api/instagram/live/start-stream', {
            videoId,
            streamUrl,
            streamKey,
            multiRtmp: getInstagramMirrorDestinations(),
            loop: Boolean(igElements.loop?.checked),
            settings: {
                resolution: igElements.res?.value || '720x1280',
                fps: igElements.fps?.value || '30',
                bitrate: igElements.bit?.value || '3500k',
            }
        });
        await refreshInstagramStatus();
        Swal.fire({ icon: 'success', title: 'Stream Started', text: 'FFmpeg ke ingest Instagram sudah jalan.', background: '#1f2937', color: '#fff' });
    } catch (err) {
        Swal.fire({ icon: 'error', title: 'Start Failed', text: err.message, background: '#1f2937', color: '#fff' });
    } finally {
        await refreshInstagramStatus();
    }
}

async function onInstagramGoLiveClick() {
    setButtonLoading(igElements.goBtn, true, 'Go live...', 'Go Live');
    try {
        const data = await callInstagramApi('/api/instagram/live/go', {
            videoId: Number(igElements.video?.value || 0),
            streamUrl: igElements.streamUrl?.value?.trim() || '',
            streamKey: igElements.streamKey?.value?.trim() || '',
            multiRtmp: getInstagramMirrorDestinations(),
            loop: Boolean(igElements.loop?.checked),
            settings: {
                resolution: igElements.res?.value || '720x1280',
                fps: igElements.fps?.value || '30',
                bitrate: igElements.bit?.value || '3500k',
            }
        });
        await refreshInstagramStatus();
        Swal.fire({
            icon: data.result?.isLive ? 'success' : 'info',
            title: data.result?.isLive ? 'Now Live' : 'Go Live Triggered',
            text: data.result?.isLive
                ? (data.autoStartedFfmpeg ? 'Instagram live aktif. FFmpeg auto-start online.' : 'Instagram live sudah aktif.')
                : (data.autoStartedFfmpeg ? 'FFmpeg auto-start online. Go Live sudah dikirim.' : 'Perintah Go Live sudah dikirim.'),
            background: '#1f2937',
            color: '#fff'
        });
    } catch (err) {
        Swal.fire({ icon: 'error', title: 'Go Live Failed', text: err.message, background: '#1f2937', color: '#fff' });
    } finally {
        setButtonLoading(igElements.goBtn, false, '', 'Go Live');
    }
}

async function onInstagramEndLiveClick() {
    setButtonLoading(igElements.endBtn, true, 'Ending...', 'End Live');
    try {
        await callInstagramApi('/api/instagram/live/end', {});
        await refreshInstagramStatus();
        Swal.fire({ icon: 'success', title: 'Live Ended', text: 'Sesi live Instagram diakhiri.', background: '#1f2937', color: '#fff' });
    } catch (err) {
        Swal.fire({ icon: 'error', title: 'End Failed', text: err.message, background: '#1f2937', color: '#fff' });
    } finally {
        setButtonLoading(igElements.endBtn, false, '', 'End Live');
    }
}

async function refreshInstagramComments() {
    if (!igElements.commentsList) return;
    try {
        const resp = await fetch('/api/instagram/live/comments?limit=80');
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || data.ok === false) {
            throw new Error(data.error || 'Failed to load live comments');
        }
        renderInstagramComments(data.result?.items || []);
    } catch (err) {
        igElements.commentsList.innerHTML = `comments error: ${err.message}`;
    }
}

async function onInstagramSendCommentClick() {
    if (!igElements.commentInput) return;
    const message = igElements.commentInput.value.trim();
    if (!message) {
        Swal.fire({ icon: 'warning', title: 'Komentar kosong', text: 'Isi komentar dulu.', background: '#1f2937', color: '#fff' });
        return;
    }

    setButtonLoading(igElements.commentSendBtn, true, 'Sending...', 'Send Comment');
    try {
        const data = await callInstagramApi('/api/instagram/live/comment', { message });
        igElements.commentInput.value = '';
        renderInstagramComments(data.result?.comments || []);
        Swal.fire({ icon: 'success', title: 'Comment Sent', text: 'Komentar berhasil dikirim.', background: '#1f2937', color: '#fff' });
    } catch (err) {
        Swal.fire({ icon: 'error', title: 'Send Failed', text: err.message, background: '#1f2937', color: '#fff' });
    } finally {
        setButtonLoading(igElements.commentSendBtn, false, '', 'Send Comment');
    }
}

async function refreshInstagramAutoReplySettings() {
    if (!igElements.autoReplyStatus) return;
    try {
        const resp = await fetch('/api/instagram/live/auto-reply/settings');
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || data.ok === false) {
            throw new Error(data.error || 'Failed to load auto-reply settings');
        }
        renderAutoReplyStatus(data.result || {});
        applyAutoReplySettingsToForm(data.result || {});
        igAutoReplyLoaded = true;
    } catch (err) {
        igElements.autoReplyStatus.innerText = `auto-reply error: ${err.message}`;
    }
}

async function onInstagramAutoReplySaveClick() {
    const payload = collectAutoReplyPayload();
    setButtonLoading(igElements.autoReplySaveBtn, true, 'Saving...', 'Save Auto Reply');
    try {
        const data = await callInstagramApi('/api/instagram/live/auto-reply/settings', payload);
        renderAutoReplyStatus(data.result || {});
        Swal.fire({ icon: 'success', title: 'Saved', text: 'Setting auto-reply berhasil disimpan.', background: '#1f2937', color: '#fff' });
    } catch (err) {
        Swal.fire({ icon: 'error', title: 'Save Failed', text: err.message, background: '#1f2937', color: '#fff' });
    } finally {
        setButtonLoading(igElements.autoReplySaveBtn, false, '', 'Save Auto Reply');
    }
}

async function onInstagramAutoReplyRunOnceClick() {
    setButtonLoading(igElements.autoReplyRunOnceBtn, true, 'Running...', 'Run Once');
    try {
        const data = await callInstagramApi('/api/instagram/live/auto-reply/run-once', {});
        renderAutoReplyStatus(data.result || {});
        await refreshInstagramComments();
        Swal.fire({ icon: 'success', title: 'Run Once', text: 'Auto-reply tick selesai dijalankan.', background: '#1f2937', color: '#fff' });
    } catch (err) {
        Swal.fire({ icon: 'error', title: 'Run Failed', text: err.message, background: '#1f2937', color: '#fff' });
    } finally {
        setButtonLoading(igElements.autoReplyRunOnceBtn, false, '', 'Run Once');
    }
}
