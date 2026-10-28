import * as vscode from 'vscode';
import WebSocket from 'ws';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';

const SERVER_URL = "wss://friday-assistant.ru/ws";
const UPLOAD_URL = "https://friday-assistant.ru/api/upload";
const IGNORE_DIRS = new Set([".git", "build", ".gradle", "__pycache__", "venv", ".idea", "node_modules", "out"]);

export function activate(context: vscode.ExtensionContext) {
    const provider = new AntigravityViewProvider(context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider("antigravity.chatView", provider)
    );
}

class AntigravityViewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _ws?: any;
    private _pinger?: NodeJS.Timeout;

    constructor(private readonly _context: vscode.ExtensionContext) {}

    resolveWebviewView(webviewView: vscode.WebviewView) {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this._getHtmlForWebview();

        this._ensureSocket().then(() => {
            this._sendRaw({ type: "get_chats" });
        });

        webviewView.webview.onDidReceiveMessage(async (data) => {
            await this._ensureSocket();

            switch (data.type) {
                case 'get_chats':
                    this._sendRaw({ type: "get_chats" });
                    break;
                case 'get_chat_history':
                    this._sendRaw({ type: "get_chat_history", chat_uid: data.chat_uid });
                    break;
                case 'create_chat':
                    this._sendRaw({ type: "create_chat", chat_uid: data.chat_uid, title: data.title });
                    break;
                case 'delete_chat':
                    this._sendRaw({ type: "delete_chat", chat_uid: data.chat_uid });
                    break;
                case 'select_file_dialog':
                    const uris = await vscode.window.showOpenDialog({
                        canSelectMany: true,
                        openLabel: "Прикрепить к чату",
                        filters: { "Все файлы": ["*"] }
                    });
                    if (uris && uris.length > 0) {
                        for (const uri of uris) {
                            const stat = await vscode.workspace.fs.stat(uri);
                            const name = path.basename(uri.fsPath);
                            this._view?.webview.postMessage({
                                type: 'file_attached',
                                file: {
                                    name: name,
                                    fsPath: uri.fsPath,
                                    size: stat.size
                                }
                            });
                        }
                    }
                    break;
                case 'send_prompt':
                    await this._handleUserPrompt(data.prompt, data.chatId, data.attachments || []);
                    break;
            }
        });
    }

    private _getWorkspaceRoot(): string {
        return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || ".";
    }

    private _scanTree(rootDir: string): string {
        const treeLines: string[] = [];
        const walk = (dir: string, level: number) => {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            const indent = ' '.repeat(4 * level);
            for (const entry of entries) {
                if (IGNORE_DIRS.has(entry.name)) { continue; }
                if (entry.isDirectory()) {
                    treeLines.push(`${indent}📂 ${entry.name}/`);
                    walk(path.join(dir, entry.name), level + 1);
                } else {
                    treeLines.push(`${indent}📄 ${entry.name}`);
                }
            }
        };
        try { walk(rootDir, 0); } catch (e) { return "Ошибка сканирования папки"; }
        return treeLines.join("\n");
    }

    private async _uploadToStorage(chatId: string, filename: string, buffer: Buffer): Promise<string | null> {
        try {
            const b64Name = Buffer.from(filename, 'utf-8').toString('base64');
            const resp = await fetch(UPLOAD_URL, {
                method: "POST",
                headers: {
                    "Content-Type": "application/octet-stream",
                    "X-Filename": encodeURIComponent(filename),
                    "X-Filename-B64": b64Name,
                    "X-Chat-Uid": chatId
                },
                body: buffer
            });
            const json: any = await resp.json();
            return json?.url || null;
        } catch (e: any) {
            this._postStatus(`Ошибка загрузки ${filename}: ${e.message}`);
            return null;
        }
    }

    private async _handleUserPrompt(prompt: string, chatId: string, attachments: any[]) {
        const rootDir = this._getWorkspaceRoot();
        let promptPrefix = "";

        // Обработка прикрепленных файлов и скриншотов
        if (attachments && attachments.length > 0) {
            this._postStatus(`Загрузка вложений (${attachments.length} шт.)...`);
            for (const att of attachments) {
                if (att.type === 'screenshot') {
                    const buf = Buffer.from(att.base64, 'base64');
                    const url = await this._uploadToStorage(chatId, att.name, buf);
                    if (url) {
                        promptPrefix += `[Прикреплен скриншот: ${att.name}]\nСсылка: ${url}\nСкачай через: curl -sL "${url}" -o "${att.name}"\n\n`;
                    }
                } else if (att.type === 'file' && att.fsPath) {
                    if (fs.existsSync(att.fsPath)) {
                        const buf = fs.readFileSync(att.fsPath);
                        const url = await this._uploadToStorage(chatId, att.name, buf);
                        if (url) {
                            promptPrefix += `[Прикреплен файл: ${att.name}]\nСсылка: ${url}\nСкачай через: curl -sL "${url}" -o "${att.name}"\n\n`;
                        }
                    }
                }
            }
        }

        let currentPrompt = promptPrefix ? (promptPrefix + prompt) : prompt;
        this._postStatus("Отправка в Antigravity...");

        while (true) {
            const task = {
                type: "antigravity_task",
                prompt: currentPrompt,
                chat_id: chatId,
                ui_msg_id: `vscode_${Date.now()}`
            };

            const response = await this._sendTask(task);
            if (!response) {
                this._postStatus("Сервер не ответил или соединение разорвано.");
                break;
            }

            const text = response.text || "";

            // 1. Авто-выкачка файлов по HTTP ссылкам
            if (response.file_urls && Object.keys(response.file_urls).length > 0) {
                for (const [relPath, fileUrl] of Object.entries(response.file_urls as Record<string, string>)) {
                    this._postStatus(`📥 Скачивание: ${relPath}...`);
                    try {
                        const fileResp = await fetch(fileUrl);
                        const arrayBuf = await fileResp.arrayBuffer();
                        const fullPath = path.join(rootDir, relPath);
                        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
                        fs.writeFileSync(fullPath, Buffer.from(arrayBuf));
                        this._postStatus(`💾 Сохранен: ${relPath}`);
                    } catch (dlErr: any) {
                        this._postStatus(`❌ Ошибка скачивания ${relPath}: ${dlErr.message}`);
                    }
                }
            }

            // 2. Выполнение команды в терминале [RUN_COMMAND: ...]
            const cmdMatch = text.match(/\[RUN_COMMAND:\s*(.*?)\]/);
            if (cmdMatch) {
                const cmd = cmdMatch[1].trim().replace(/^python3\s+/, "python ");
                this._postStatus(`💻 Терминал: ${cmd}`);

                const output = await new Promise<string>((resolve) => {
                    exec(cmd, { cwd: rootDir, timeout: 120000 }, (error, stdout, stderr) => {
                        const code = error ? error.code || 1 : 0;
                        const out = (stdout || "") + "\n" + (stderr || "");
                        resolve(`Команда \`${cmd}\` завершена (код ${code}).\nЛоги:\n${out.slice(0, 3000)}`);
                    });
                });

                currentPrompt = output;
                continue;
            }

            // 3. Запрос структуры проекта [GET_TREE]
            if (text.includes("[GET_TREE]")) {
                this._postStatus("📁 Сканирование структуры...");
                const tree = this._scanTree(rootDir);
                currentPrompt = `Вот структура проекта:\n${tree}`;
                continue;
            }

            // 4. Запрос файлов [GET_FILES: ...]
            const getFilesMatch = text.match(/\[GET_FILES:\s*([^\]]+)\]/);
            if (getFilesMatch) {
                const rawFiles = getFilesMatch[1].split(",");
                const fileParts: string[] = [];

                for (const rf of rawFiles) {
                    const cleanRf = rf.trim().replace(/\\/g, '/');
                    const fullPath = path.join(rootDir, cleanRf);

                    if (fs.existsSync(fullPath)) {
                        const ext = path.extname(cleanRf).toLowerCase();
                        const stats = fs.statSync(fullPath);

                        if (['.py', '.js', '.ts', '.html', '.css', '.json', '.txt', '.md', '.kt', '.java'].includes(ext) && stats.size < 500 * 1024) {
                            const content = fs.readFileSync(fullPath, 'utf-8');
                            fileParts.push(`=== FILE: ${cleanRf} ===\n${content}\n`);
                            this._postStatus(`📖 Прочитан: ${cleanRf}`);
                        } else {
                            this._postStatus(`☁️ Загрузка ${cleanRf} (${Math.round(stats.size / 1024 / 1024)} МБ)...`);
                            const fileBuffer = fs.readFileSync(fullPath);
                            const url = await this._uploadToStorage(chatId, path.basename(cleanRf), fileBuffer);
                            if (url) {
                                fileParts.push(
                                    `=== FILE: ${cleanRf} ===\nФайл загружен на сервер: ${url}\nСкачай через: curl -sL "${url}" -o "${cleanRf}"\n`
                                );
                                this._postStatus(`✅ Загружен: ${cleanRf}`);
                            } else {
                                fileParts.push(`=== FILE: ${cleanRf} ===\n[Ошибка загрузки на сервер]\n`);
                            }
                        }
                    } else {
                        fileParts.push(`=== FILE: ${cleanRf} ===\n[Ошибка: файл не найден]\n`);
                    }
                }
                currentPrompt = "Вот запрошенные файлы:\n" + fileParts.join("\n");
                continue;
            }

            // Финальный ответ в чат
            const cleanText = text.replace(/\[SYNC:\s*[^\]]+\]/g, "").trim();
            this._view?.webview.postMessage({
                type: 'agent_response',
                text: cleanText,
                chatId: chatId
            });
            break;
        }
    }

    private _ensureSocket(): Promise<void> {
        return new Promise((resolve, reject) => {
            if (this._ws && this._ws.readyState === WebSocket.OPEN) {
                return resolve();
            }
            this._ws = new WebSocket(SERVER_URL);
            this._ws.on('open', () => {
                if (this._pinger) { clearInterval(this._pinger); }
                this._pinger = setInterval(() => {
                    if (this._ws?.readyState === WebSocket.OPEN) {
                        this._sendRaw({ type: "ping" });
                    }
                }, 20000);
                resolve();
            });

            this._ws.on('message', (raw: any) => {
                try {
                    const decoded = Buffer.from(raw.toString(), 'base64').toString('utf-8');
                    const json = JSON.parse(decoded);
                    if (['antigravity_chats_list', 'antigravity_chat_history', 'antigravity_chat_created', 'antigravity_chat_deleted'].includes(json.type)) {
                        this._view?.webview.postMessage(json);
                    }
                } catch (e) {}
            });

            this._ws.on('error', (err: any) => reject(err));
        });
    }

    private _sendRaw(obj: any) {
        if (this._ws && this._ws.readyState === WebSocket.OPEN) {
            const encoded = Buffer.from(JSON.stringify(obj)).toString('base64');
            this._ws.send(encoded);
        }
    }

    private _sendTask(task: any): Promise<any> {
        return new Promise((resolve) => {
            if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
                return resolve(null);
            }

            const encoded = Buffer.from(JSON.stringify(task)).toString('base64');

            const onMessage = (raw: any) => {
                try {
                    const decoded = Buffer.from(raw.toString(), 'base64').toString('utf-8');
                    const json = JSON.parse(decoded);

                    if (json.type === 'antigravity_status') {
                        this._postStatus(`Статус: ${json.status}...`);
                    } else if (json.type === 'antigravity_result') {
                        this._ws?.off('message', onMessage);
                        resolve(json);
                    } else if (json.type === 'antigravity_error') {
                        this._postStatus(`Ошибка сервера: ${json.error}`);
                        this._ws?.off('message', onMessage);
                        resolve(null);
                    }
                } catch (e) {}
            };

            this._ws.on('message', onMessage);
            this._ws.send(encoded);
        });
    }

    private _postStatus(status: string) {
        this._view?.webview.postMessage({ type: 'status_update', status });
    }

    private _getHtmlForWebview(): string {
        return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; }
  body { font-family: var(--vscode-font-family); padding: 10px; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); display: flex; flex-direction: column; height: 100vh; margin: 0; }
  .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 8px; margin-bottom: 8px; }
  select, button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 8px; cursor: pointer; border-radius: 2px; }
  select { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); max-width: 140px; }
  #chat-container { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; padding-right: 4px; user-select: text !important; -webkit-user-select: text !important; }
  
  .msg-wrapper { display: flex; flex-direction: column; max-width: 90%; }
  .msg-wrapper.user { align-self: flex-end; }
  .msg-wrapper.agent { align-self: flex-start; }
  
  .msg { padding: 8px 10px; border-radius: 4px; font-size: 13px; line-height: 1.4; white-space: pre-wrap; word-break: break-word; user-select: text !important; -webkit-user-select: text !important; cursor: text; }
  .user .msg { background: var(--vscode-button-secondaryBackground); }
  .agent .msg { background: var(--vscode-editor-inactiveSelectionBackground); }
  
  .msg-footer { display: flex; justify-content: flex-end; margin-top: 2px; }
  .copy-btn { background: transparent; border: none; color: var(--vscode-descriptionForeground); font-size: 11px; cursor: pointer; padding: 2px 4px; border-radius: 2px; }
  .copy-btn:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }

  .status { font-size: 11px; color: var(--vscode-descriptionForeground); font-style: italic; margin-top: 4px; min-height: 16px; }
  
  /* Контейнер прикрепленных файлов и скриншотов */
  #attachments-bar { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
  .attachment-chip { display: flex; align-items: center; gap: 4px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); padding: 2px 6px; border-radius: 3px; font-size: 11px; }
  .attachment-chip img { max-height: 24px; border-radius: 2px; }
  .attachment-chip .remove-btn { cursor: pointer; font-weight: bold; margin-left: 2px; color: var(--vscode-errorForeground); }

  .input-area { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
  textarea { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); resize: none; height: 65px; padding: 6px; font-family: inherit; font-size: 13px; }
  .btn-row { display: flex; gap: 6px; justify-content: flex-end; }
</style>
</head>
<body>
  <div class="header">
    <select id="chat-select"></select>
    <div>
      <button id="new-chat-btn">+ Чат</button>
      <button id="del-chat-btn">Удалить</button>
    </div>
  </div>

  <div id="chat-container"></div>
  <div id="status-bar" class="status"></div>

  <div class="input-area">
    <div id="attachments-bar"></div>
    <textarea id="prompt-input" placeholder="Задача или вопрос... (Ctrl+V скриншот, Ctrl+Enter отправка)"></textarea>
    <div class="btn-row">
      <button id="attach-file-btn">📎 Файл</button>
      <button id="send-btn">Отправить</button>
    </div>
  </div>

<script>
  const vscode = acquireVsCodeApi();
  let currentChats = [];
  let activeChatUid = null;
  let currentAttachments = [];

  // =========================================================================
  // ЖЕЛЕЗНЫЙ ФИКС CTRL+C И СИСТЕМНОГО COPY
  // =========================================================================
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C' || e.keyCode === 67)) {
      const sel = window.getSelection();
      if (sel && sel.toString().trim().length > 0) {
        // Если текст выделен, глушим перехват фокуса на поле ввода!
        e.stopPropagation();
        navigator.clipboard.writeText(sel.toString());
      }
    }
  }, true);

  document.addEventListener('copy', (e) => {
    const sel = window.getSelection();
    if (sel && sel.toString().trim().length > 0) {
      e.clipboardData.setData('text/plain', sel.toString());
      e.preventDefault();
      e.stopPropagation();
    }
  });

  // =========================================================================
  // ВСТАВКА СКРИНШОТОВ ИЗ БУФЕРА ОБМЕНА (Ctrl+V)
  // =========================================================================
  document.addEventListener('paste', (e) => {
    const items = (e.clipboardData || window.clipboardData)?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') !== -1) {
        e.preventDefault();
        e.stopPropagation();
        const blob = items[i].getAsFile();
        const reader = new FileReader();
        reader.onload = (event) => {
          const dataUrl = event.target.result;
          const base64 = dataUrl.split(',')[1];
          const name = 'screenshot_' + Date.now() + '.png';
          currentAttachments.push({
            type: 'screenshot',
            name: name,
            dataUrl: dataUrl,
            base64: base64
          });
          renderAttachments();
        };
        reader.readAsDataURL(blob);
      }
    }
  });

  function renderAttachments() {
    const bar = document.getElementById('attachments-bar');
    bar.innerHTML = '';
    currentAttachments.forEach((att, idx) => {
      const chip = document.createElement('div');
      chip.className = 'attachment-chip';
      if (att.type === 'screenshot') {
        chip.innerHTML = '<img src="' + att.dataUrl + '"> <span>' + att.name + '</span>';
      } else {
        const sizeStr = att.size ? ' (' + Math.round(att.size / 1024) + ' КБ)' : '';
        chip.innerHTML = '<span>📄 ' + att.name + sizeStr + '</span>';
      }
      const removeBtn = document.createElement('span');
      removeBtn.className = 'remove-btn';
      removeBtn.textContent = '✖';
      removeBtn.onclick = () => {
        currentAttachments.splice(idx, 1);
        renderAttachments();
      };
      chip.appendChild(removeBtn);
      bar.appendChild(chip);
    });
  }

  // =========================================================================
  // ВЫБОР ФАЙЛА ЧЕРЕЗ СИСТЕМНЫЙ ДИАЛОГ (📎 Файл)
  // =========================================================================
  document.getElementById('attach-file-btn').onclick = () => {
    vscode.postMessage({ type: 'select_file_dialog' });
  };

  // =========================================================================
  // ЧАТЫ И СООБЩЕНИЯ
  // =========================================================================
  vscode.postMessage({ type: 'get_chats' });

  function renderSelect() {
    const select = document.getElementById('chat-select');
    select.innerHTML = '';
    currentChats.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.chat_uid;
      opt.textContent = c.title || 'Новый диалог';
      if (c.chat_uid === activeChatUid) opt.selected = true;
      select.appendChild(opt);
    });
  }

  function copyText(btn, text) {
    navigator.clipboard.writeText(text).then(() => {
      const old = btn.textContent;
      btn.textContent = '✓ Скопировано';
      setTimeout(() => { btn.textContent = old; }, 2000);
    });
  }

  function appendMessageUI(role, text) {
    const container = document.getElementById('chat-container');
    const wrapper = document.createElement('div');
    wrapper.className = 'msg-wrapper ' + role;

    const div = document.createElement('div');
    div.className = 'msg';
    div.textContent = text;
    wrapper.appendChild(div);

    if (role === 'agent') {
      const footer = document.createElement('div');
      footer.className = 'msg-footer';
      const copyBtn = document.createElement('button');
      copyBtn.className = 'copy-btn';
      copyBtn.textContent = '📋 Копировать';
      copyBtn.onclick = () => copyText(copyBtn, text);
      footer.appendChild(copyBtn);
      wrapper.appendChild(footer);
    }

    container.appendChild(wrapper);
    container.scrollTop = container.scrollHeight;
  }

  function renderMessages(messages) {
    const container = document.getElementById('chat-container');
    container.innerHTML = '';
    messages.forEach(m => appendMessageUI(m.role, m.text));
  }

  document.getElementById('chat-select').onchange = (e) => {
    activeChatUid = e.target.value;
    vscode.postMessage({ type: 'get_chat_history', chat_uid: activeChatUid });
  };

  document.getElementById('new-chat-btn').onclick = () => {
    const newUid = 'chat_' + Date.now();
    vscode.postMessage({ type: 'create_chat', chat_uid: newUid, title: 'Новый диалог' });
  };

  document.getElementById('del-chat-btn').onclick = () => {
    if (!activeChatUid) return;
    vscode.postMessage({ type: 'delete_chat', chat_uid: activeChatUid });
  };

  function send() {
    const input = document.getElementById('prompt-input');
    const text = input.value.trim();
    if ((!text && currentAttachments.length === 0) || !activeChatUid) return;

    let displayMsg = text;
    if (currentAttachments.length > 0) {
      displayMsg = (displayMsg ? displayMsg + '\\n\\n' : '') + '[Вложения: ' + currentAttachments.map(a => a.name).join(', ') + ']';
    }

    appendMessageUI('user', displayMsg);
    input.value = '';

    const payloadAttachments = [...currentAttachments];
    currentAttachments = [];
    renderAttachments();

    vscode.postMessage({
      type: 'send_prompt',
      prompt: text || 'Посмотри прикрепленные вложения.',
      chatId: activeChatUid,
      attachments: payloadAttachments
    });
  }

  document.getElementById('send-btn').onclick = send;
  document.getElementById('prompt-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      send();
    }
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;

    if (msg.type === 'file_attached') {
      currentAttachments.push({
        type: 'file',
        name: msg.file.name,
        fsPath: msg.file.fsPath,
        size: msg.file.size
      });
      renderAttachments();
    }
    else if (msg.type === 'antigravity_chats_list') {
      currentChats = msg.chats;
      if (currentChats.length === 0) {
        const initialUid = 'chat_' + Date.now();
        vscode.postMessage({ type: 'create_chat', chat_uid: initialUid, title: 'Новый диалог' });
        return;
      }
      activeChatUid = currentChats[0].chat_uid;
      renderSelect();
      vscode.postMessage({ type: 'get_chat_history', chat_uid: activeChatUid });
    }
    else if (msg.type === 'antigravity_chat_history') {
      if (msg.chat_uid === activeChatUid) {
        renderMessages(msg.messages);
      }
    }
    else if (msg.type === 'antigravity_chat_created') {
      currentChats.unshift(msg.chat);
      activeChatUid = msg.chat.chat_uid;
      renderSelect();
      renderMessages([]);
    }
    else if (msg.type === 'antigravity_chat_deleted') {
      currentChats = currentChats.filter(c => c.chat_uid !== msg.chat_uid);
      if (currentChats.length === 0) {
        vscode.postMessage({ type: 'get_chats' });
      } else {
        activeChatUid = currentChats[0].chat_uid;
        renderSelect();
        vscode.postMessage({ type: 'get_chat_history', chat_uid: activeChatUid });
      }
    }
    else if (msg.type === 'status_update') {
      document.getElementById('status-bar').textContent = msg.status;
    }
    else if (msg.type === 'agent_response') {
      document.getElementById('status-bar').textContent = '';
      if (msg.chatId === activeChatUid) {
        appendMessageUI('agent', msg.text);
      }
      vscode.postMessage({ type: 'get_chats' });
    }
  });
</script>
</body>
</html>`;
    }
}