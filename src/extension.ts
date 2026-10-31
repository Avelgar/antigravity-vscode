import * as vscode from 'vscode';
import WebSocket from 'ws';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import { marked } from 'marked';
import hljs from 'highlight.js';
import katex from 'katex';

const SERVER_URL = "wss://friday-assistant.ru/ws";
const UPLOAD_URL = "https://friday-assistant.ru/api/upload";
const IGNORE_DIRS = new Set([".git", "build", ".gradle", "__pycache__", "venv", ".idea", "node_modules", "out"]);

// 1. Рендер математических формул LaTeX ($...$ и $$...$$)
function renderMath(text: string): string {
    // Выносные формулы $$...$$
    text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, math) => {
        try {
            return `<div class="katex-block">${katex.renderToString(math.trim(), { displayMode: true, throwOnError: false })}</div>`;
        } catch { return `$$${math}$$`; }
    });
    // Строчные формулы $...$
    text = text.replace(/\$([^\$\n]+?)\$/g, (_, math) => {
        try {
            return katex.renderToString(math.trim(), { displayMode: false, throwOnError: false });
        } catch { return `$${math}$`; }
    });
    return text;
}

// 2. Рендер блоков кода
const renderer = new marked.Renderer();
renderer.code = function(codeOrObj: any, infostring?: any) {
    let code = typeof codeOrObj === 'object' && codeOrObj !== null ? codeOrObj.text : codeOrObj;
    let lang = typeof codeOrObj === 'object' && codeOrObj !== null ? codeOrObj.lang : infostring;
    code = String(code || '');
    lang = String(lang || 'plaintext').trim().toLowerCase();

    const validLang = lang && hljs.getLanguage(lang) ? lang : 'plaintext';
    let highlighted: string;
    try {
        highlighted = hljs.highlight(code, { language: validLang }).value;
    } catch {
        highlighted = code;
    }

    const safeRaw = encodeURIComponent(code);
    return `<div class="code-block">
        <div class="code-header">
            <span class="code-lang">${validLang}</span>
            <div class="code-actions">
                <button class="code-btn" data-code="${safeRaw}" onclick="copyCodeSnippet(this)">📋 Скопировать</button>
                <button class="code-btn" data-code="${safeRaw}" onclick="insertCodeSnippet(this)">📥 Вставить в файл</button>
            </div>
        </div>
        <pre><code class="hljs ${validLang}">${highlighted}</code></pre>
    </div>`;
};
marked.use({ renderer });

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
                case 'insert_code':
                    const editor = vscode.window.activeTextEditor;
                    if (editor) {
                        editor.edit(editBuilder => {
                            editBuilder.insert(editor.selection.active, data.code);
                        });
                        vscode.window.showInformationMessage("Код вставлен в активный файл!");
                    } else {
                        vscode.window.showWarningMessage("Откройте файл в редакторе, куда нужно вставить код.");
                    }
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
                                file: { name, fsPath: uri.fsPath, size: stat.size }
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
                body: buffer as any
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
        this._postStatus("Агент приступил к работе...");

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

            // 1. Авто-выкачка файлов по HTTP
            if (response.file_urls && Object.keys(response.file_urls).length > 0) {
                for (const [relPath, fileUrl] of Object.entries(response.file_urls as Record<string, string>)) {
                    this._postStatus(`📥 Скачивание: ${relPath}...`);
                    try {
                        const fileResp = await fetch(fileUrl);
                        const arrayBuf = await fileResp.arrayBuffer();
                        const fullPath = path.join(rootDir, relPath);
                        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
                        fs.writeFileSync(fullPath, Buffer.from(arrayBuf));
                        this._postActivity(`💾 Файл сохранен на диск: **${relPath}**`);
                    } catch (dlErr: any) {
                        this._postStatus(`❌ Ошибка скачивания ${relPath}: ${dlErr.message}`);
                    }
                }
            }

            // 2. Выполнение команды в терминале [RUN_COMMAND: ...]
            const cmdMatch = text.match(/\[RUN_COMMAND:\s*(.*?)\]/);
            if (cmdMatch) {
                const cmd = cmdMatch[1].trim().replace(/^python3\s+/, "python ");
                this._postActivity(`💻 Выполняется команда в терминале: \`${cmd}\``);

                const output = await new Promise<string>((resolve) => {
                    exec(cmd, { cwd: rootDir, timeout: 120000 }, (error, stdout, stderr) => {
                        const code = error ? error.code || 1 : 0;
                        const out = (stdout || "") + "\n" + (stderr || "");
                        resolve(`Команда \`${cmd}\` завершена (код ${code}).\nЛоги:\n${out.slice(0, 3000)}`);
                    });
                });

                currentPrompt = output;
                continue; // Служебный шаг — НЕ печатаем его в чат пользователю!
            }

            // 3. Запрос дерева [GET_TREE]
            if (text.includes("[GET_TREE]")) {
                this._postActivity("📁 Агент запросил структуру проекта -> передано");
                const tree = this._scanTree(rootDir);
                currentPrompt = `Вот структура проекта:\n${tree}`;
                continue; // Служебный шаг — НЕ печатаем в чат!
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
                            this._postActivity(`📖 Агент прочитал файл: \`${cleanRf}\``);
                        } else {
                            this._postStatus(`☁️ Загрузка ${cleanRf} (${Math.round(stats.size / 1024 / 1024)} МБ)...`);
                            const fileBuffer = fs.readFileSync(fullPath);
                            const url = await this._uploadToStorage(chatId, path.basename(cleanRf), fileBuffer);
                            if (url) {
                                fileParts.push(
                                    `=== FILE: ${cleanRf} ===\nФайл загружен на сервер: ${url}\nСкачай через: curl -sL "${url}" -o "${cleanRf}"\n`
                                );
                                this._postActivity(`📖 Передан тяжелый файл: \`${cleanRf}\``);
                            }
                        }
                    }
                }
                currentPrompt = "Вот запрошенные файлы:\n" + fileParts.join("\n");
                continue; // Служебный шаг — НЕ печатаем в чат!
            }

            // ФИНАЛЬНЫЙ ОТВЕТ: рендерим формулы LaTeX -> парсим Markdown
            const cleanText = text.replace(/\[SYNC:\s*[^\]]+\]/g, "").trim();
            const withMath = renderMath(cleanText);
            const htmlContent = marked.parse(withMath);

            this._view?.webview.postMessage({
                type: 'agent_response',
                html: htmlContent,
                rawText: cleanText,
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
                        if (json.type === 'antigravity_chat_history' && json.messages) {
                            json.messages.forEach((m: any) => {
                                if (m.role === 'agent') {
                                    m.html = marked.parse(renderMath(m.text || ''));
                                }
                            });
                        }
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
                        this._postStatus(`Агент думает: ${json.status}...`);
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

    private _postActivity(activityText: string) {
        const html = marked.parse(activityText);
        this._view?.webview.postMessage({ type: 'activity_log', html });
    }

    private _getHtmlForWebview(): string {
        return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<!-- Подключаем стили KaTeX для формул -->
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/katex.min.css">
<style>
  * { box-sizing: border-box; }
  
  /* Фикс двойного скролла: окно больше НЕ растягивается в пустоту */
  html, body { height: 100%; width: 100%; margin: 0; padding: 0; overflow: hidden; background: var(--vscode-sideBar-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
  
  .app-layout { display: flex; flex-direction: column; height: 100%; padding: 8px 10px; }
  
  .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--vscode-panel-border, #333); padding-bottom: 6px; margin-bottom: 6px; flex-shrink: 0; }
  select, button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 8px; cursor: pointer; border-radius: 3px; font-size: 12px; }
  select { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, #444); max-width: 140px; }
  
  /* Единственный правильный скролл-контейнер */
  #chat-container { flex: 1; overflow-y: auto; overflow-x: hidden; display: flex; flex-direction: column; gap: 10px; padding-right: 4px; user-select: text !important; -webkit-user-select: text !important; }
  
  .msg-wrapper { display: flex; flex-direction: column; max-width: 92%; }
  .msg-wrapper.user { align-self: flex-end; }
  .msg-wrapper.agent { align-self: flex-start; width: 100%; max-width: 98%; }
  
  /* Контрастные, красивые цвета сообщений */
  .msg { padding: 9px 12px; border-radius: 6px; font-size: 13px; line-height: 1.5; word-break: break-word; user-select: text !important; -webkit-user-select: text !important; cursor: text; box-shadow: 0 1px 3px rgba(0,0,0,0.2); }
  
  /* Твои сообщения: глубокий темный сине-фиолетовый */
  .user .msg { background: #1e3a5f; color: #ffffff; border: 1px solid #2d5584; white-space: pre-wrap; }
  
  /* Ответы ИИ: строгий темно-угольный с тонкой рамкой */
  .agent .msg { background: #181c24; color: #e1e4e8; border: 1px solid #282e3a; }
  
  .activity-chip { display: inline-flex; align-items: center; gap: 6px; background: rgba(0, 122, 204, 0.12); border-left: 3px solid #007acc; padding: 4px 8px; border-radius: 3px; font-size: 11px; margin: 2px 0; color: #9cdcfe; align-self: flex-start; }
  .activity-chip p { margin: 0; }

  /* Формулы KaTeX */
  .katex { font-size: 1.05em; color: #f0f6fc; }
  .katex-block { margin: 8px 0; overflow-x: auto; padding: 6px 0; text-align: center; background: rgba(0,0,0,0.2); border-radius: 4px; }

  /* Блоки кода */
  .code-block { margin: 8px 0; border-radius: 5px; overflow: hidden; background: #0f1117; border: 1px solid #2b313e; }
  .code-header { display: flex; justify-content: space-between; align-items: center; background: #181b24; padding: 4px 8px; font-size: 11px; color: #8b949e; border-bottom: 1px solid #2b313e; }
  .code-actions { display: flex; gap: 6px; }
  .code-btn { background: #212631; border: 1px solid #30363d; color: #c9d1d9; font-size: 11px; cursor: pointer; padding: 2px 6px; border-radius: 3px; }
  .code-btn:hover { background: #30363d; color: #fff; }
  .code-block pre { margin: 0; padding: 10px; overflow-x: auto; font-family: var(--vscode-editor-font-family, Consolas, monospace); font-size: 12px; line-height: 1.5; color: #e6edf3; }

  /* Подсветка кода */
  .hljs-keyword, .hljs-selector-tag { color: #ff7b72; font-weight: bold; }
  .hljs-string, .hljs-attribute { color: #a5d6ff; }
  .hljs-number, .hljs-literal { color: #79c0ff; }
  .hljs-comment { color: #8b949e; font-style: italic; }
  .hljs-title, .hljs-function { color: #d2a8ff; }
  .hljs-params { color: #ffa657; }
  .hljs-type, .hljs-class { color: #7ee787; }

  .msg-footer { display: flex; justify-content: flex-end; margin-top: 3px; }
  .copy-btn { background: transparent; border: none; color: #6e7681; font-size: 11px; cursor: pointer; padding: 2px 4px; }
  .copy-btn:hover { color: #c9d1d9; }

  .status-wrapper { display: flex; align-items: center; gap: 6px; font-size: 11px; color: #8b949e; margin-top: 4px; min-height: 20px; flex-shrink: 0; }
  
  #attachments-bar { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 4px; max-height: 60px; overflow-y: auto; }
  .attachment-chip { display: flex; align-items: center; gap: 4px; background: #21262d; border: 1px solid #30363d; color: #c9d1d9; padding: 2px 6px; border-radius: 3px; font-size: 11px; }
  .attachment-chip img { max-height: 22px; border-radius: 2px; }
  .attachment-chip .remove-btn { cursor: pointer; font-weight: bold; margin-left: 2px; color: #f85149; }

  .input-area { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; flex-shrink: 0; }
  textarea { background: var(--vscode-input-background, #0d1117); color: var(--vscode-input-foreground, #c9d1d9); border: 1px solid var(--vscode-input-border, #30363d); resize: none; height: 65px; padding: 7px; font-family: inherit; font-size: 13px; border-radius: 4px; }
  textarea:focus { outline: 1px solid #007acc; border-color: #007acc; }
  .btn-row { display: flex; gap: 6px; justify-content: flex-end; }
</style>
</head>
<body>
<div class="app-layout">
  <div class="header">
    <select id="chat-select"></select>
    <div>
      <button id="new-chat-btn">+ Чат</button>
      <button id="del-chat-btn">Удалить</button>
    </div>
  </div>

  <div id="chat-container"></div>
  
  <div class="status-wrapper">
    <span id="timer-badge" style="display:none; color:#58a6ff; font-weight:bold;">⏱ 0:00</span>
    <span id="status-bar" style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;"></span>
  </div>

  <div class="input-area">
    <div id="attachments-bar"></div>
    <textarea id="prompt-input" placeholder="Задача или вопрос... (Ctrl+V скриншот, Ctrl+Enter отправка)"></textarea>
    <div class="btn-row">
      <button id="attach-file-btn">📎 Файл</button>
      <button id="send-btn">Отправить</button>
    </div>
  </div>
</div>

<script>
  const vscode = acquireVsCodeApi();
  let currentChats = [];
  let activeChatUid = null;
  let currentAttachments = [];
  let timerInterval = null;
  let timerSeconds = 0;

  function startTimer() {
    timerSeconds = 0;
    const badge = document.getElementById('timer-badge');
    badge.style.display = 'inline';
    badge.textContent = '⏱ 0:00';
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      timerSeconds++;
      const m = Math.floor(timerSeconds / 60);
      const s = timerSeconds % 60;
      badge.textContent = '⏱ ' + m + ':' + (s < 10 ? '0' : '') + s;
    }, 1000);
  }

  function stopTimer() {
    if (timerInterval) clearInterval(timerInterval);
    document.getElementById('timer-badge').style.display = 'none';
  }

  // Перехват Ctrl+C и Copy
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C' || e.keyCode === 67)) {
      const sel = window.getSelection();
      if (sel && sel.toString().trim().length > 0) {
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

  // Вставка скриншота из буфера
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
          currentAttachments.push({ type: 'screenshot', name, dataUrl, base64 });
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

  document.getElementById('attach-file-btn').onclick = () => {
    vscode.postMessage({ type: 'select_file_dialog' });
  };

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

  function copyCodeSnippet(btn) {
    const raw = decodeURIComponent(btn.getAttribute('data-code') || '');
    navigator.clipboard.writeText(raw).then(() => {
      const old = btn.textContent;
      btn.textContent = '✓ Скопировано';
      setTimeout(() => { btn.textContent = old; }, 2000);
    });
  }

  function insertCodeSnippet(btn) {
    const raw = decodeURIComponent(btn.getAttribute('data-code') || '');
    vscode.postMessage({ type: 'insert_code', code: raw });
    const old = btn.textContent;
    btn.textContent = '✓ Вставлено!';
    setTimeout(() => { btn.textContent = old; }, 2000);
  }

  function appendMessageUI(role, content, isHtml = false, rawText = '') {
    const container = document.getElementById('chat-container');
    const wrapper = document.createElement('div');
    wrapper.className = 'msg-wrapper ' + role;

    const div = document.createElement('div');
    div.className = 'msg';
    if (isHtml) {
      div.innerHTML = content;
    } else {
      div.textContent = content;
    }
    wrapper.appendChild(div);

    if (role === 'agent') {
      const footer = document.createElement('div');
      footer.className = 'msg-footer';
      const copyBtn = document.createElement('button');
      copyBtn.className = 'copy-btn';
      copyBtn.textContent = '📋 Копировать весь ответ';
      const textToCopy = rawText || div.innerText;
      copyBtn.onclick = () => copyText(copyBtn, textToCopy);
      footer.appendChild(copyBtn);
      wrapper.appendChild(footer);
    }

    container.appendChild(wrapper);
    container.scrollTop = container.scrollHeight;
  }

  function appendActivityUI(html) {
    const container = document.getElementById('chat-container');
    const chip = document.createElement('div');
    chip.className = 'activity-chip';
    chip.innerHTML = html;
    container.appendChild(chip);
    container.scrollTop = container.scrollHeight;
  }

  function renderMessages(messages) {
    const container = document.getElementById('chat-container');
    container.innerHTML = '';
    messages.forEach(m => {
      appendMessageUI(m.role, m.html || m.text, !!m.html, m.text || '');
    });
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

    appendMessageUI('user', displayMsg, false);
    input.value = '';

    const payloadAttachments = [...currentAttachments];
    currentAttachments = [];
    renderAttachments();

    startTimer();

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
    else if (msg.type === 'activity_log') {
      // Выводим аккуратный бейдж действия агента
      appendActivityUI(msg.html);
    }
    else if (msg.type === 'agent_response') {
      stopTimer();
      document.getElementById('status-bar').textContent = '';
      if (msg.chatId === activeChatUid) {
        appendMessageUI('agent', msg.html, true, msg.rawText);
      }
      vscode.postMessage({ type: 'get_chats' });
    }
  });
</script>
</body>
</html>`;
    }
}