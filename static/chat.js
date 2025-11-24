const socket = io();
const chatWindow = document.getElementById('chat-window');
const textInput = document.getElementById('text');
const ttlSelect = document.getElementById('ttl-select');
const myId = parseInt(document.body.dataset.myId);
let myUsername = document.body.dataset.myUsername; 
let myColor = document.body.dataset.myColor; 

const typingIndicator = document.getElementById('typing-indicator');
const onlineCountSpan = document.getElementById('online-count');
const toastContainer = document.getElementById('toast-container');
const sendBtn = document.getElementById('send-btn');

function getLocalTime() {
    return new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

let toastTimeout;
function showToast(message) {
    // Remove existing toast if present to prevent stacking
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();
    if (toastTimeout) clearTimeout(toastTimeout);

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    toastContainer.appendChild(toast);

    void toast.offsetWidth;
    toast.classList.add('show');

    toastTimeout = setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}
socket.on('connection_rejected', (data) => {
    document.body.innerHTML = `<div style="color:white; text-align:center; padding-top:20%; font-family:monospace;">
        <h1 style="border-bottom: 1px solid white; display:inline-block; padding-bottom:10px;">DISCONNECTED</h1>
        <p>${data.message}</p>
    </div>`;
});

window.addEventListener('beforeunload', () => { socket.disconnect(); });

const fileInput = document.getElementById('file-input');
const uploadBtn = document.getElementById('upload-btn');
const imgPreviewContainer = document.getElementById('image-preview-container');
const imgPreview = document.getElementById('img-preview');
const clearImgBtn = document.getElementById('clear-img');
let currentImageBase64 = null;

loadHistory();

let typingTimeout = null;
let isTyping = false; 
let isCooldown = false; // Client side rate limit flag

textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault(); 
        if (isCooldown) return; // Block enter key if on cooldown
        sendMessage();
        return;
    }

    if (!isTyping) { isTyping = true; socket.emit('start_typing'); }
    if (typingTimeout) clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => { isTyping = false; socket.emit('stop_typing'); }, 2000); 
});

socket.on('typing_status', (data) => {
    if (!typingIndicator) return; 
    if (data.count === 0) {
        typingIndicator.textContent = '';
        typingIndicator.style.opacity = '0';
    } else {
        typingIndicator.style.opacity = '1';
        typingIndicator.textContent = data.count === 1 ? "Someone is typing..." : "Multiple people are typing...";
    }
});

socket.on('update_user_count', (data) => { if(onlineCountSpan) onlineCountSpan.textContent = data.count; });


function appendMessage(data, isTemp = false) {
    if (data.temp_id && !isTemp) {
        const tempEl = document.querySelector(`.message-bubble[data-temp-id="${data.temp_id}"]`);
        if (tempEl) {
            tempEl.classList.remove('sending'); 
            tempEl.dataset.id = data.id; 
            tempEl.removeAttribute('data-temp-id');
            // Remove footer if exists
            const footer = tempEl.querySelector('.msg-footer');
            if(footer) footer.remove();
            
            const timer = tempEl.querySelector('.msg-timer');
            if(timer) timer.setAttribute('title', `Expires: ${data.expires_str}`);

            // Ensure delete button uses real ID
            const delBtn = tempEl.querySelector('.msg-delete-btn');
            if (delBtn) delBtn.onclick = () => handleDelete(data.id, false);
            return; 
        }
    }

    const div = document.createElement('div');
    div.classList.add('message-bubble');
    if (isTemp) {
        div.classList.add('sending');
        div.dataset.tempId = data.temp_id;
    } else {
        div.dataset.id = data.id;
    }
    
    const isMine = data.is_mine || data.user_id === myId;
    if (isMine) div.classList.add('mine');

    const userColor = data.color || '#d0d0d0';
    const borderStyle = `border-left: 3px solid ${userColor};`;
    const nameStyle = `color: ${userColor};`;
    const msgStyle = `color: ${userColor};`; 

    div.style.cssText = borderStyle;

    let contentHtml = '';
    if (data.message) {
        contentHtml += `<div class="msg-content" style="${msgStyle}">${linkify(escapeHtml(data.message))}</div>`;
    }
    if (data.image) {
        contentHtml += `<img src="${data.image}" class="msg-image" onclick="downloadImage(this.src)">`;
    }

    let deleteBtnHtml = '';
    if (isMine) {
        const onClickFn = isTemp 
            ? `handleDelete('${data.temp_id}', true)` 
            : `handleDelete(${data.id}, false)`;
        
        deleteBtnHtml = `<span class="msg-delete-btn" title="Delete/Cancel" onclick="${onClickFn}"><i class="fas fa-times"></i></span>`;
    }

    div.innerHTML = `
        <div class="msg-header">
            <div>
                ${deleteBtnHtml}
                <span class="msg-author" style="${nameStyle}" data-user-id="${data.user_id}">${data.username}</span>
            </div>
            <div class="msg-meta">
                <span class="msg-time" style="margin-right: 15px; padding-left: 10px;">${data.time}</span>
                <span class="msg-timer" title="Expires: ${data.expires_str}"><i class="fas fa-hourglass-half"></i></span>
            </div>
        </div>
        <div class="msg-body">
            ${contentHtml}
        </div>
    `;
    chatWindow.appendChild(div);
    chatWindow.scrollTop = chatWindow.scrollHeight;
}

socket.on('receive_message', (data) => appendMessage(data));

socket.on('message_expired', (data) => {
    const el = document.querySelector(`.message-bubble[data-id="${data.id}"]`);
    if (el) {
        el.className = 'message-bubble expired';
        el.style.borderLeft = "3px solid #333";
        el.innerHTML = "<em>[Message Expired]</em>";
    }
});

socket.on('user_updated', (data) => {
    if(data.user_id === myId) {
        myUsername = data.username;
        myColor = data.color;
        document.getElementById('nav-username').textContent = data.username;
    }
    const bubbles = document.querySelectorAll('.message-bubble');
    bubbles.forEach(bubble => {
        const authorSpan = bubble.querySelector(`.msg-author[data-user-id="${data.user_id}"]`);
        if (authorSpan) {
            authorSpan.textContent = data.username;
            authorSpan.style.color = data.color;
            bubble.style.borderLeft = `3px solid ${data.color}`;
            const content = bubble.querySelector('.msg-content');
            if(content) content.style.color = data.color;
        }
    });
});

function downloadImage(src) {
    const a = document.createElement('a');
    a.href = src;
    a.download = `chat_image_${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

async function handleDelete(id, isTemp) {
    if (isTemp) {
        const el = document.querySelector(`.message-bubble[data-temp-id="${id}"]`);
        if(el) el.remove();
        return;
    }

    if (!confirm("Delete this message?")) return;
    
    const el = document.querySelector(`.message-bubble[data-id="${id}"]`);
    if(el) el.style.opacity = '0.2';

    try {
        await fetch(`/api/message/${id}`, { method: 'DELETE' });
    } catch(e) { console.error(e); }
}

function linkify(text) {
    if (!text) return text;
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    return text.replace(urlRegex, function(url) {
        return `<a href="${url}" target="_blank">${url}</a>`;
    });
}

async function loadHistory() {
    try {
        const res = await fetch('/api/history');
        const data = await res.json();
        chatWindow.innerHTML = '';
        data.forEach(msg => appendMessage(msg));
    } catch (e) {}
}

uploadBtn.onclick = () => fileInput.click();
fileInput.onchange = (e) => processFile(e.target.files[0]);
document.addEventListener('paste', (e) => {
    const items = (e.clipboardData || e.originalEvent.clipboardData).items;
    for (const item of items) {
        if (item.type.indexOf('image') === 0) processFile(item.getAsFile());
    }
});

function processFile(file) {
    if(!file) return;
    if (file.size > 6 * 1024 * 1024) { showToast("File too large (Max 6MB)"); return; }
    const reader = new FileReader();
    reader.onload = (e) => {
        currentImageBase64 = e.target.result;
        imgPreview.src = currentImageBase64;
        imgPreviewContainer.classList.remove('hidden');
    };
    reader.readAsDataURL(file);
}
clearImgBtn.onclick = () => {
    currentImageBase64 = null;
    fileInput.value = "";
    imgPreviewContainer.classList.add('hidden');
};

async function sendMessage() {
    if (isCooldown) return; // Prevent spam

    const msg = textInput.value.trim();
    if (!msg && !currentImageBase64) return;
    
    // Activate Cooldown
    isCooldown = true;
    sendBtn.disabled = true;
    setTimeout(() => {
        isCooldown = false;
        sendBtn.disabled = false;
    }, 500);

    const tempId = 'temp-' + Date.now();
    const tempRenderPayload = {
        temp_id: tempId,
        message: msg,
        image: currentImageBase64,
        username: myUsername,
        color: myColor,
        time: getLocalTime(),
        expires_str: "Pending...",
        is_mine: true,
        user_id: myId
    };

    appendMessage(tempRenderPayload, true);

    textInput.value = '';
    currentImageBase64 = null;
    imgPreviewContainer.classList.add('hidden');
    isTyping = false;
    socket.emit('stop_typing');

    const payload = { 
        message: msg, 
        image: tempRenderPayload.image, 
        ttl: ttlSelect.value, 
        temp_id: tempId 
    };

    try { 
        const res = await fetch('/api/message', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload) }); 
        if (!res.ok) {
            const data = await res.json();
            // Use Toast for alerts
            if(data.error) showToast(data.error);
            handleSendError(tempId);
        }
    } catch(e) { 
        handleSendError(tempId);
    }
}

function handleSendError(tempId) {
    const el = document.querySelector(`.message-bubble[data-temp-id="${tempId}"]`);
    if(el) {
        el.style.opacity = '1'; 
        
        let footer = el.querySelector('.msg-footer');
        if(!footer) {
            footer = document.createElement('div');
            footer.className = 'msg-footer';
            el.appendChild(footer);
        }
        
        if (!footer.querySelector('.error-text')) {
             const errSpan = document.createElement('span');
             errSpan.className = 'error-text';
             errSpan.textContent = '(Failed)';
             footer.appendChild(errSpan);
        }
    }
}

document.getElementById('send-btn').onclick = () => sendMessage();

function escapeHtml(text) {
    if (!text) return text;
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

const modal = document.getElementById('profile-modal');
document.getElementById('my-profile-trigger').onclick = () => modal.style.display = 'flex';
document.querySelector('.close-modal').onclick = () => modal.style.display = 'none';
window.onclick = (e) => { if (e.target == modal) modal.style.display = "none"; }

document.getElementById('save-profile').onclick = async () => {
    const uname = document.getElementById('edit-username').value;
    const color = document.getElementById('edit-color').value;
    await fetch('/api/user/me', {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({username: uname, color: color})
    });
    document.querySelector('.close-modal').click();
};