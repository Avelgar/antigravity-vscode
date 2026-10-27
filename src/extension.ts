import * as vscode from 'vscode';
import WebSocket from 'ws';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';

const SERVER_URL = "wss://friday-assistant.ru/ws";
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

        // Подключаем сокет и сразу запрашиваем список чатов из БД
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
                case 'send_prompt':
                    await this._handleUserPrompt(data.prompt, data.chatId);
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

    private async _handleUserPrompt(prompt: string, chatId: string) {
        const rootDir = this._getWorkspaceRoot();
        let currentPrompt = prompt;

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

            // 1. Авто-скачивание файлов по HTTP ссылкам (без лимита на размер файла)
            if (response.file_urls && Object.keys(response.file_urls).length > 0) {
                for (const [relPath, fileUrl] of Object.entries(response.file_urls as Record<string, string>)) {
                    this._postStatus(`📥 Скачивание: ${relPath}...`);
                    try {
                        const fileResp = await fetch(fileUrl);
                        const arrayBuf = await fileResp.arrayBuffer();
                        const fullPath = path.join(rootDir, relPath);
                        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
                        fs.writeFileSync(fullPath, Buffer.from(arrayBuf));
                        this._postStatus(`💾 Сохранен на диск: ${relPath}`);
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

            // 4. Запрос файлов [GET_FILES: ...] (Умная загрузка: Текст текстом, Бинарники через HTTP /api/upload)
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

                        // Если это легкий текстовый файл (код, конфиги) до 500 КБ — шлем текстом
                        if (['.py', '.js', '.ts', '.html', '.css', '.json', '.txt', '.md', '.kt', '.java'].includes(ext) && stats.size < 500 * 1024) {
                            const content = fs.readFileSync(fullPath, 'utf-8');
                            fileParts.push(`=== FILE: ${cleanRf} ===\n${content}\n`);
                            this._postStatus(`📖 Прочитан: ${cleanRf}`);
                        } else {
                            // Бинарный или тяжелый файл (DOCX 13MB, PDF, APK, Картинка) — загружаем на HTTP-сервер!
                            this._postStatus(`☁️ Загрузка ${cleanRf} (${Math.round(stats.size / 1024 / 1024)} МБ) на сервер...`);
                            try {
                                const fileBuffer = fs.readFileSync(fullPath);
                                const uploadResp = await fetch("https://friday-assistant.ru/api/upload", {
                                    method: "POST",
                                    headers: {
                                        "Content-Type": "application/octet-stream",
                                        "X-Filename": encodeURIComponent(path.basename(cleanRf)),
                                        "X-Chat-Uid": chatId
                                    },
                                    body: fileBuffer
                                });

                                const uploadData: any = await uploadResp.json();
                                if (uploadData && uploadData.url) {
                                    fileParts.push(
                                        `=== FILE: ${cleanRf} ===\n` +
                                        `Файл загружен на сервер и доступен по ссылке: ${uploadData.url}\n` +
                                        `Скачай его в свое окружение Linux командой:\n` +
                                        `curl -sL "${uploadData.url}" -o "${cleanRf}"\n` +
                                        `После скачивания ты сможешь разобрать его локально через python-docx или другие библиотеки.\n`
                                    );
                                    this._postStatus(`✅ Загружен на сервер: ${cleanRf}`);
                                } else {
                                    fileParts.push(`=== FILE: ${cleanRf} ===\n[Ошибка загрузки на сервер]\n`);
                                }
                            } catch (upErr: any) {
                                fileParts.push(`=== FILE: ${cleanRf} ===\n[Ошибка загрузки: ${upErr.message}]\n`);
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
                    // Прокидываем события синхронизации базы сразу в вебвью
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
  body { font-family: var(--vscode-font-family); padding: 10px; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); display: flex; flex-direction: column; height: 100vh; box-sizing: border-box; }
  .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 8px; margin-bottom: 8px; }
  select, button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 8px; cursor: pointer; border-radius: 2px; }
  select { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); max-width: 140px; }
  #chat-container { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; padding-right: 4px; }
  .msg { padding: 8px; border-radius: 4px; font-size: 13px; line-height: 1.4; white-space: pre-wrap; word-break: break-word; }
  .user { background: var(--vscode-button-secondaryBackground); align-self: flex-end; max-width: 85%; }
  .agent { background: var(--vscode-editor-inactiveSelectionBackground); align-self: flex-start; max-width: 90%; }
  .status { font-size: 11px; color: var(--vscode-descriptionForeground); font-style: italic; margin-top: 4px; }
  .input-area { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
  textarea { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); resize: none; height: 60px; padding: 6px; font-family: inherit; }
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
    <textarea id="prompt-input" placeholder="Задача или вопрос... (Ctrl+Enter)"></textarea>
    <div class="btn-row">
      <button id="send-btn">Отправить</button>
    </div>
  </div>

<script>
  const vscode = acquireVsCodeApi();
  let currentChats = [];
  let activeChatUid = null;

  // При старте запрашиваем чаты из базы на сервере
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

  function renderMessages(messages) {
    const container = document.getElementById('chat-container');
    container.innerHTML = '';
    messages.forEach(m => {
      const div = document.createElement('div');
      div.className = 'msg ' + (m.role === 'user' ? 'user' : 'agent');
      div.textContent = m.text;
      container.appendChild(div);
    });
    container.scrollTop = container.scrollHeight;
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
    if (!text || !activeChatUid) return;

    // Сразу рисуем локально сообщение пользователя
    const container = document.getElementById('chat-container');
    const div = document.createElement('div');
    div.className = 'msg user';
    div.textContent = text;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
    input.value = '';

    vscode.postMessage({
      type: 'send_prompt',
      prompt: text,
      chatId: activeChatUid
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

    // 1. Прилетел список чатов из БД
    if (msg.type === 'antigravity_chats_list') {
      currentChats = msg.chats;
      if (currentChats.length === 0) {
        // Если в базе вообще пусто — создаем первый диалог
        const initialUid = 'chat_' + Date.now();
        vscode.postMessage({ type: 'create_chat', chat_uid: initialUid, title: 'Новый диалог' });
        return;
      }
      activeChatUid = currentChats[0].chat_uid;
      renderSelect();
      vscode.postMessage({ type: 'get_chat_history', chat_uid: activeChatUid });
    }

    // 2. Прилетела история сообщений конкретного чата из БД
    else if (msg.type === 'antigravity_chat_history') {
      if (msg.chat_uid === activeChatUid) {
        renderMessages(msg.messages);
      }
    }

    // 3. Создан новый чат в БД
    else if (msg.type === 'antigravity_chat_created') {
      currentChats.unshift(msg.chat);
      activeChatUid = msg.chat.chat_uid;
      renderSelect();
      renderMessages([]);
    }

    // 4. Чат удален из БД
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

    // 5. Статусы выполнения
    else if (msg.type === 'status_update') {
      document.getElementById('status-bar').textContent = msg.status;
    }

    // 6. Ответ агента
    else if (msg.type === 'agent_response') {
      document.getElementById('status-bar').textContent = '';
      if (msg.chatId === activeChatUid) {
        const container = document.getElementById('chat-container');
        const div = document.createElement('div');
        div.className = 'msg agent';
        div.textContent = msg.text;
        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
      }
      // Обновляем список чатов, чтобы подтянулся сгенерированный заголовок
      vscode.postMessage({ type: 'get_chats' });
    }
  });
</script>
</body>
</html>`;
    }
}