import * as vscode from 'vscode';
import WebSocket from 'ws';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { exec } from 'child_process';
import { marked } from 'marked';
import hljs from 'highlight.js';
import katex from 'katex';

const SERVER_URL = "wss://friday-assistant.ru/ws";
const UPLOAD_URL = "https://friday-assistant.ru/api/upload";
const IGNORE_DIRS = new Set([".git", "build", ".gradle", "__pycache__", "venv", ".idea", "node_modules", "out", "dist"]);

// Локальный файл хранения аккаунта
function getOrCreateAccount(): { user_token: string; username: string } {
    const configPath = path.join(os.homedir(), '.antigravity_account.json');
    try {
        if (fs.existsSync(configPath)) {
            const raw = fs.readFileSync(configPath, 'utf-8');
            return JSON.parse(raw);
        }
    } catch {}

    const newToken = 'usr_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
    const newAccount = { user_token: newToken, username: os.userInfo().username || 'Developer' };
    try {
        fs.writeFileSync(configPath, JSON.stringify(newAccount, null, 2), 'utf-8');
    } catch {}
    return newAccount;
}

const userAccount = getOrCreateAccount();

function escapeHtml(str: string): string {
    return String(str || '')
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function renderMath(text: string): string {
    text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, math) => {
        try {
            return `<div class="katex-block">${katex.renderToString(math.trim(), { displayMode: true, throwOnError: false })}</div>`;
        } catch { return `$$${math}$$`; }
    });
    text = text.replace(/\$([^\$\n]+?)\$/g, (_, math) => {
        try {
            return katex.renderToString(math.trim(), { displayMode: false, throwOnError: false });
        } catch { return `$${math}$`; }
    });
    return text;
}

function parseAskUser(text: string): string {
    return text.replace(/\[ASK_USER:\s*([^\]]+)\]/g, (_, content) => {
        const parts = content.split('|').map((p: string) => p.trim());
        const question = parts[0];
        const options = parts.slice(1);
        let btnsHtml = options.map((opt: string) => {
            const safeOpt = encodeURIComponent(opt);
            return `<button class="ask-btn" data-answer="${safeOpt}" onclick="answerOption(this)">${escapeHtml(opt)}</button>`;
        }).join('');
        return `<div class="ask-box">
            <div class="ask-question">❓ ${escapeHtml(question)}</div>
            <div class="ask-options">${btnsHtml}</div>
        </div>`;
    });
}

// Очистка текста от блоков кода и инлайн-кода для безопасного поиска командных тегов
function getActionableText(text: string): string {
    return text
        .replace(/```[\s\S]*?```/g, '')
        .replace(/`[^`\n]+`/g, '');
}

const renderer = new marked.Renderer();
renderer.code = function(codeOrObj: any, infostring?: any) {
    let code = typeof codeOrObj === 'object' && codeOrObj !== null ? codeOrObj.text : codeOrObj;
    let lang = typeof codeOrObj === 'object' && codeOrObj !== null ? codeOrObj.lang : infostring;
    code = String(code || '');
    lang = String(lang || 'plaintext').trim().toLowerCase();

    const validLang = lang && hljs.getLanguage(lang) ? lang : 'plaintext';
    let highlighted = code;
    try { highlighted = hljs.highlight(code, { language: validLang }).value; } catch {}

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

    context.subscriptions.push(
        vscode.commands.registerCommand("antigravity.openFullChat", () => {
            provider.createFullTab();
        })
    );
}

class AntigravityViewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _fullPanel?: vscode.WebviewPanel;
    private _ws?: any;
    private _pinger?: NodeJS.Timeout;
    private _chatFiles: Map<string, Record<string, string>> = new Map();
    private _isCancelled: boolean = false;
    private _isBusy: boolean = false;
    private _activeTaskCleanup: (() => void) | null = null;
    private _activeTaskResolver: ((value: any) => void) | null = null;
    private _activeUiMsgId: string | null = null;

    constructor(private readonly _context: vscode.ExtensionContext) {}

    private _getCurrentWorkspace(): string {
        return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";
    }

    private _getDownloadedMap(): Record<string, string> {
        return this._context.workspaceState.get<Record<string, string>>('antigravity_synced_map') || {};
    }

    private _markFileDownloaded(relPath: string, fileUrl: string) {
        const map = this._getDownloadedMap();
        map[relPath] = fileUrl;
        this._context.workspaceState.update('antigravity_synced_map', map);
    }

    createFullTab() {
        if (this._fullPanel) {
            this._fullPanel.reveal(vscode.ViewColumn.One);
            return;
        }
        this._fullPanel = vscode.window.createWebviewPanel(
            "antigravity.fullChat",
            "Antigravity Chat (Full)",
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        this._fullPanel.webview.html = this._getHtmlForWebview();
        this._attachMessageHandler(this._fullPanel.webview);
        this._fullPanel.onDidDispose(() => { this._fullPanel = undefined; });
        this._ensureSocket().then(() => this._requestChats());
    }

    resolveWebviewView(webviewView: vscode.WebviewView) {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this._getHtmlForWebview();
        this._attachMessageHandler(webviewView.webview);

        this._ensureSocket().then(() => {
            this._requestChats();
        });
    }

    private _requestChats() {
        this._sendRaw({ 
            type: "get_chats", 
            user_token: userAccount.user_token,
            username: userAccount.username 
        });
    }

    private _postToAll(msg: any) {
        this._view?.webview.postMessage(msg);
        this._fullPanel?.webview.postMessage(msg);
    }

    private _attachMessageHandler(webview: vscode.Webview) {
        webview.onDidReceiveMessage(async (data) => {
            await this._ensureSocket();

            switch (data.type) {
                case 'get_chats':
                    this._requestChats();
                    break;
                case 'get_chat_history':
                    this._sendRaw({ type: "get_chat_history", chat_uid: data.chat_uid });
                    break;
                case 'create_chat':
                    const currentWs = this._getCurrentWorkspace();
                    this._sendRaw({ 
                        type: "create_chat", 
                        chat_uid: data.chat_uid, 
                        title: data.title,
                        user_token: userAccount.user_token,
                        workspace_path: currentWs
                    });
                    break;
                case 'delete_chat':
                    this._chatFiles.delete(data.chat_uid);
                    this._sendRaw({ type: "delete_chat", chat_uid: data.chat_uid });
                    break;
                case 'cancel_task':
                    this._isCancelled = true;
                    this._isBusy = false;
                    this._sendRaw({ type: "cancel_task", chat_id: data.chatId, ui_msg_id: this._activeUiMsgId });
                    if (this._activeTaskCleanup) {
                        this._activeTaskCleanup();
                        this._activeTaskCleanup = null;
                    }
                    if (this._activeTaskResolver) {
                        const res = this._activeTaskResolver;
                        this._activeTaskResolver = null;
                        res({ type: 'antigravity_cancelled', chatId: data.chatId, ui_msg_id: this._activeUiMsgId });
                    }
                    break;
                case 'manual_sync_files':
                    await this._handleManualSync(data.chatId);
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
                        const fileList: any[] = [];
                        for (const uri of uris) {
                            const stat = await vscode.workspace.fs.stat(uri);
                            const name = path.basename(uri.fsPath);
                            const ext = path.extname(name).toLowerCase();
                            const isImg = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext);
                            
                            let base64: string | undefined = undefined;
                            let dataUrl: string | undefined = undefined;
                            if (isImg && stat.size < 12 * 1024 * 1024) {
                                const bytes = await vscode.workspace.fs.readFile(uri);
                                base64 = Buffer.from(bytes).toString('base64');
                                const mime = ext === '.png' ? 'image/png' : (ext === '.webp' ? 'image/webp' : 'image/jpeg');
                                dataUrl = `data:${mime};base64,${base64}`;
                            }

                            fileList.push({
                                type: isImg ? 'screenshot' : 'file',
                                name: name,
                                fsPath: uri.fsPath,
                                size: stat.size,
                                base64: base64,
                                dataUrl: dataUrl
                            });
                        }
                        this._postToAll({
                            type: 'files_attached_batch',
                            files: fileList
                        });
                    }
                    break;
                case 'send_prompt':
                    this._isCancelled = false;
                    await this._handleUserPrompt(data.prompt, data.chatId, data.attachments || []);
                    break;
            }
        });
    }

    private _checkAndNotifyUnsynced(chatId: string) {
        const currentTarget = this._getCurrentWorkspace();
        const allFiles = this._chatFiles.get(chatId) || {};
        const downloadedMap = this._getDownloadedMap();
        let unsyncedCount = 0;

        for (const [relPath, fileUrl] of Object.entries(allFiles)) {
            const normRel = relPath.replace(/\\/g, '/');
            const isAlreadyDownloaded = downloadedMap[normRel] === fileUrl;

            if (!currentTarget) {
                if (!isAlreadyDownloaded) { unsyncedCount++; }
                continue;
            }

            const fullPath = path.join(currentTarget, normRel);
            const existsLocally = fs.existsSync(fullPath);

            if (!existsLocally) {
                unsyncedCount++;
            } else if (!isAlreadyDownloaded) {
                unsyncedCount++;
            }
        }

        this._postToAll({
            type: 'sync_button_update',
            chatId: chatId,
            unsyncedCount: unsyncedCount
        });
    }

    // Ручная синхронизация по кнопке (скачивает только новые или обновлённые файлы)
    private async _handleManualSync(chatId: string) {
        const targetDir = this._getCurrentWorkspace();
        if (!targetDir) {
            vscode.window.showErrorMessage("Откройте папку проекта в VS Code (Файл -> Открыть папку), чтобы синхронизировать в неё файлы.");
            return;
        }

        const allFiles = this._chatFiles.get(chatId) || {};
        const downloadedMap = this._getDownloadedMap();

        // Берём ТОЛЬКО те файлы, которых нет на диске или у которых обновилась версия на сервере
        const filesToSync = Object.entries(allFiles).filter(([relPath, fileUrl]) => {
            const normRel = relPath.replace(/\\/g, '/');
            const fullPath = path.join(targetDir, normRel);
            const existsLocally = fs.existsSync(fullPath);
            const isAlreadyDownloaded = downloadedMap[normRel] === fileUrl;
            return !existsLocally || !isAlreadyDownloaded;
        });

        if (filesToSync.length === 0) {
            vscode.window.showInformationMessage("Все файлы из этого диалога уже синхронизированы.");
            this._checkAndNotifyUnsynced(chatId);
            return;
        }

        this._postStatus(`Синхронизация ${filesToSync.length} новых файлов в '${path.basename(targetDir)}'...`);

        let syncedNow = 0;
        for (const [relPath, fileUrl] of filesToSync) {
            try {
                const normRel = relPath.replace(/\\/g, '/');
                this._postStatus(`📥 Скачивание: ${normRel}...`);
                const fileResp = await fetch(fileUrl);
                if (!fileResp.ok) throw new Error(`HTTP ${fileResp.status}`);
                const arrayBuf = await fileResp.arrayBuffer();
                const fullPath = path.join(targetDir, normRel);
                fs.mkdirSync(path.dirname(fullPath), { recursive: true });
                fs.writeFileSync(fullPath, Buffer.from(arrayBuf));
                
                this._markFileDownloaded(normRel, fileUrl);
                syncedNow++;
                this._postActivity(`💾 Синхронизирован в '${path.basename(targetDir)}': **${normRel}**`);
            } catch (err: any) {
                this._postStatus(`❌ Ошибка скачивания ${relPath}: ${err.message}`);
            }
        }

        this._postStatus("Синхронизация завершена!");
        this._checkAndNotifyUnsynced(chatId);
        this._postToAll({ type: 'sync_completed', chatId });
        vscode.window.showInformationMessage(`Синхронизировано файлов: ${syncedNow} в папку '${path.basename(targetDir)}'`);
    }

    private _scanTree(rootDir: string): string {
        if (!rootDir || !fs.existsSync(rootDir)) return "Папка проекта не открыта в VS Code";
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
        if (this._isBusy) {
            this._postStatus("⚠️ Предыдущая задача еще выполняется. Нажмите ⏹ Отмена для прерывания.");
            return;
        }
        this._isBusy = true;
        try {
            const targetDir = this._getCurrentWorkspace() || ".";
            let promptPrefix = "";

            if (attachments && attachments.length > 0) {
                this._postStatus(`Загрузка вложений (${attachments.length} шт.)...`);
                for (const att of attachments) {
                    if (att.type === 'screenshot' && att.base64) {
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

            while (!this._isCancelled) {
                const task = {
                    type: "antigravity_task",
                    prompt: currentPrompt,
                    chat_id: chatId,
                    user_token: userAccount.user_token,
                    workspace_path: targetDir,
                    ui_msg_id: `vscode_${Date.now()}`
                };

                const response = await this._sendTask(task);
                if (this._isCancelled || response?.type === 'antigravity_cancelled') {
                    this._postActivity("⏹ Задача прервана пользователем");
                    this._postToAll({ type: 'antigravity_cancelled', chatId: chatId });
                    break;
                }
                if (!response) {
                    this._postStatus("Сервер не ответил или вернул ошибку.");
                    this._postToAll({ type: 'antigravity_error', error: "Сбой запроса к AI. Проверьте логи сервера." });
                    break;
                }
                const text = response.text || "";

                if (response.file_urls && Object.keys(response.file_urls).length > 0) {
                    const existing = this._chatFiles.get(chatId) || {};
                    const merged = { ...existing, ...response.file_urls };
                    this._chatFiles.set(chatId, merged);

                    const downloadedMap = this._getDownloadedMap();
                    for (const rel of Object.keys(response.file_urls)) {
                        delete downloadedMap[rel.replace(/\\/g, '/')];
                    }
                    this._context.workspaceState.update('antigravity_synced_map', downloadedMap);
                    this._checkAndNotifyUnsynced(chatId);
                }

                const actionable = getActionableText(text);

                // [DELETE: ...]
                const deleteMatches = Array.from(actionable.matchAll(/\[DELETE:\s*([^\]]+)\]/g));
                if (deleteMatches.length > 0 && targetDir && targetDir !== ".") {
                    for (const match of deleteMatches) {
                        const relPath = match[1].trim().replace(/\\/g, '/');
                        const safeRel = path.normalize(relPath).replace(/^(\.\.[\/\\])+/, '');
                        const fullPath = path.join(targetDir, safeRel);

                        if (fullPath.startsWith(targetDir) && fs.existsSync(fullPath)) {
                            try {
                                fs.rmSync(fullPath, { recursive: true, force: true });
                                this._postActivity(`🗑️ Удален файл проекта: \`${safeRel}\``);
                            } catch (delErr: any) {
                                this._postActivity(`⚠️ Ошибка удаления \`${safeRel}\`: ${delErr.message}`);
                            }
                        }
                    }
                }

                // [RUN_COMMAND: ...]
                const cmdMatch = actionable.match(/\[RUN_COMMAND:\s*(.*?)\]/);
                if (cmdMatch) {
                    const cmd = cmdMatch[1].trim().replace(/^python3\s+/, "python ");

                    if (/^(cmd|powershell|bash|sh|python|node)(\.exe)?\s*$/i.test(cmd)) {
                        currentPrompt = `Ошибка: Интерактивный запуск '${cmd}' не поддерживается в неинтерактивном режиме. Передавайте конкретную команду с аргументами.`;
                        this._postActivity(`⚠️ Заблокирован интерактивный запуск: \`${cmd}\``);
                        continue;
                    }

                    this._postActivity(`💻 Терминал в '${path.basename(targetDir)}': \`${cmd}\``);
                    this._postStatus(`⚙️ Выполняется: ${cmd.length > 55 ? cmd.slice(0, 52) + '...' : cmd}`);

                    const finalCmd = process.platform === 'win32' ? `chcp 65001 >nul && ${cmd}` : cmd;

                    const output = await new Promise<string>((resolve) => {
                        exec(finalCmd, { cwd: targetDir, timeout: 120000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
                            const code = error ? error.code || 1 : 0;
                            const out = (stdout || "") + "\n" + (stderr || "");
                            resolve(`Команда \`${cmd}\` завершена (код ${code}).\nЛоги:\n${out.slice(0, 15000)}`);
                        });
                    });

                    this._postStatus("🧠 Агент анализирует логи терминала...");
                    currentPrompt = output;
                    continue;
                }

                // [GET_TREE]
                if (actionable.includes("[GET_TREE]")) {
                    this._postActivity(`📁 Запрошена структура '${path.basename(targetDir)}' -> передано`);
                    const tree = this._scanTree(targetDir);
                    currentPrompt = `Вот структура проекта:\n${tree}`;
                    continue;
                }

                // [GET_FILES: ...]
                const getFilesMatch = actionable.match(/\[GET_FILES:\s*([^\]]+)\]/);
                if (getFilesMatch) {
                    const rawFiles = getFilesMatch[1].split(",");
                    const fileParts: string[] = [];

                    for (const rf of rawFiles) {
                        const cleanRf = rf.trim().replace(/\\/g, '/');
                        const fullPath = path.join(targetDir, cleanRf);

                        if (fs.existsSync(fullPath)) {
                            const ext = path.extname(cleanRf).toLowerCase();
                            const stats = fs.statSync(fullPath);

                            if (['.py', '.js', '.ts', '.html', '.css', '.json', '.txt', '.md', '.kt', '.java'].includes(ext) && stats.size < 500 * 1024) {
                                const content = fs.readFileSync(fullPath, 'utf-8');
                                const fenceLang = ext.replace('.', '') || 'plaintext';
                                fileParts.push(`=== FILE: ${cleanRf} ===\n\`\`\`${fenceLang}\n${content}\n\`\`\`\n`);
                                this._postActivity(`📖 Прочитан: \`${cleanRf}\``);
                            } else {
                                this._postStatus(`☁️ Загрузка ${cleanRf} (${Math.round(stats.size / 1024 / 1024)} МБ)...`);
                                const fileBuffer = fs.readFileSync(fullPath);
                                const url = await this._uploadToStorage(chatId, path.basename(cleanRf), fileBuffer);
                                if (url) {
                                    fileParts.push(`=== FILE: ${cleanRf} ===\nФайл: ${url}\ncurl -sL "${url}" -o "${cleanRf}"\n`);
                                    this._postActivity(`📖 Передан тяжелый файл: \`${cleanRf}\``);
                                }
                            }
                        }
                    }
                    currentPrompt = "Вот запрошенные файлы:\n" + fileParts.join("\n");
                    continue;
                }

                let cleanText = text
                    .replace(/\[SYNC:\s*[^\]]+\]/g, "")
                    .replace(/\[DELETE:\s*[^\]]+\]/g, "")
                    .replace(/\[RUN_COMMAND:\s*[^\]]+\]/g, "")
                    .replace(/\[GET_TREE\]/g, "")
                    .replace(/\[GET_FILES:\s*[^\]]+\]/g, "")
                    .trim();
                const withQuestions = parseAskUser(cleanText);
                const withMath = renderMath(withQuestions);
                const htmlContent = marked.parse(withMath);

                this._postToAll({
                    type: 'agent_response',
                    html: htmlContent,
                    rawText: cleanText,
                    chatId: chatId
                });
                break;
            }
        } finally {
            this._isBusy = false;
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

            this._ws.on('message', async (raw: any) => {
                try {
                    const decoded = Buffer.from(raw.toString(), 'base64').toString('utf-8');
                    const json = JSON.parse(decoded);
                    
                    if (json.type === 'antigravity_chat_history') {
                        if (json.synced_files) {
                            this._chatFiles.set(json.chat_uid, json.synced_files);
                        }
                        if (json.messages) {
                            json.messages.forEach((m: any) => {
                                if (m.role === 'agent') {
                                    let raw = m.text || '';

                                    const cmdMatch = raw.match(/^\[RUN_COMMAND:\s*([\s\S]*?)\]$/);
                                    const getFilesMatch = raw.match(/^\[GET_FILES:\s*([\s\S]*?)\]$/);
                                    const getTreeMatch = raw.trim() === '[GET_TREE]';

                                    if (cmdMatch) {
                                        m.isActivity = true;
                                        m.html = `<div class="activity-chip">💻 Терминал: <code>${escapeHtml(cmdMatch[1].trim())}</code></div>`;
                                    } else if (getFilesMatch) {
                                        m.isActivity = true;
                                        m.html = `<div class="activity-chip">📖 Чтение файлов: <code>${escapeHtml(getFilesMatch[1].trim())}</code></div>`;
                                    } else if (getTreeMatch) {
                                        m.isActivity = true;
                                        m.html = `<div class="activity-chip">📁 Запрошена структура проекта</div>`;
                                    } else {
                                        let cleanAgentText = raw
                                            .replace(/\[SYNC:\s*[^\]]+\]/g, "")
                                            .replace(/\[DELETE:\s*[^\]]+\]/g, "")
                                            .replace(/\[RUN_COMMAND:\s*[^\]]+\]/g, "")
                                            .replace(/\[GET_TREE\]/g, "")
                                            .replace(/\[GET_FILES:\s*[^\]]+\]/g, "")
                                            .trim();
                                        m.html = marked.parse(renderMath(parseAskUser(cleanAgentText)));
                                        m.rawText = cleanAgentText;
                                    }
                                } else {
                                    let rawUser = m.text || '';
                                    const trimmed = rawUser.trim();

                                    if (trimmed.startsWith("Команда `") || trimmed.startsWith("Вот запрошенные файлы:") || trimmed.startsWith("Вот структура проекта:")) {
                                        m.isActivity = true;
                                        const firstLine = trimmed.split('\n')[0];
                                        const title = firstLine.length > 70 ? firstLine.slice(0, 67) + '...' : firstLine;
                                        m.html = `<details class="system-log-details"><summary>⚙️ ${escapeHtml(title)}</summary><pre><code>${escapeHtml(rawUser)}</code></pre></details>`;
                                    } else {
                                        const screenshots: string[] = [];
                                        const attachedFiles: Array<{ name: string; url: string }> = [];

                                        let cleanText = rawUser.replace(/\[Прикреплен скриншот:\s*([^\]]+)\]\s*Ссылка:\s*(https?:\/\/[^\s]+)(?:\s*Скачай через:[^\n]+)?/g, (_, name, url) => {
                                            screenshots.push(`<br><img src="${url}" alt="${escapeHtml(name)}">`);
                                            return '';
                                        });

                                        cleanText = cleanText.replace(/\[Прикреплен файл:\s*([^\]]+)\]\s*Ссылка:\s*(https?:\/\/[^\s]+)(?:\s*Скачай через:[^\n]+)?/g, (_, name, url) => {
                                            const ext = path.extname(name).toLowerCase();
                                            if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext)) {
                                                screenshots.push(`<br><img src="${url}" alt="${escapeHtml(name)}">`);
                                            } else {
                                                attachedFiles.push({ name, url });
                                            }
                                            return '';
                                        });

                                        cleanText = cleanText.trim();
                                        let html = escapeHtml(cleanText).replace(/\n/g, '<br>');
                                        if (attachedFiles.length > 0) {
                                            html += attachedFiles.map(f => `<br><span>📄 <a href="${f.url}" style="color:#58a6ff; text-decoration:underline;">${escapeHtml(f.name)}</a></span>`).join('');
                                        }
                                        if (screenshots.length > 0) {
                                            html += screenshots.join('');
                                        }
                                        m.html = html;
                                    }
                                }
                            });
                        }
                        this._postToAll(json);
                        this._checkAndNotifyUnsynced(json.chat_uid);
                        return;
                    }
                    this._postToAll(json);
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

            this._activeUiMsgId = task.ui_msg_id;

            // Ставим 15 минут (900 000 мс) вместо 2.5 минут
            const timeout = setTimeout(() => {
                cleanup();
                this._postStatus("❌ Превышено время ожидания ответа от сервера.");
                resolve(null);
            }, 900000);
            const cleanup = () => {
                clearTimeout(timeout);
                if (this._ws) {
                    this._ws.off('message', onMessage);
                }
                if (this._activeTaskCleanup === cleanup) {
                    this._activeTaskCleanup = null;
                }
                if (this._activeTaskResolver === wrappedResolve) {
                    this._activeTaskResolver = null;
                }
            };

            const wrappedResolve = (val: any) => {
                cleanup();
                resolve(val);
            };

            this._activeTaskResolver = wrappedResolve;
            this._activeTaskCleanup = cleanup;

            const encoded = Buffer.from(JSON.stringify(task)).toString('base64');

            const onMessage = (raw: any) => {
                try {
                    const decoded = Buffer.from(raw.toString(), 'base64').toString('utf-8');
                    const json = JSON.parse(decoded);

                    if (json.ui_msg_id && task.ui_msg_id && json.ui_msg_id !== task.ui_msg_id) {
                        return;
                    }
                    if (json.chat_id && task.chat_id && json.chat_id !== task.chat_id) {
                        return;
                    }

                    if (json.type === 'antigravity_status') {
                        this._postStatus(`Агент: ${json.status || 'обработка'}...`);
                    } else if (json.type === 'antigravity_result' || json.type === 'antigravity_cancelled') {
                        wrappedResolve(json);
                    } else if (json.type === 'antigravity_error') {
                        this._postStatus(`Ошибка агента: ${json.error}`);
                        wrappedResolve(null);
                    }
                } catch (e) {}
            };

            this._ws.on('message', onMessage);
            this._ws.send(encoded);
        });
    }

    private _postStatus(status: string) {
        this._postToAll({ type: 'status_update', status });
    }

    private _postActivity(activityText: string) {
        const html = marked.parse(activityText);
        this._postToAll({ type: 'activity_log', html });
    }

    private _getHtmlForWebview(): string {
        return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/katex.min.css">
<style>
  * { box-sizing: border-box; }
  html, body { height: 100%; width: 100%; margin: 0; padding: 0; overflow: hidden; background: var(--vscode-sideBar-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
  .app-layout { display: flex; flex-direction: column; height: 100%; padding: 8px 10px; }
  
  .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--vscode-panel-border, #333); padding-bottom: 6px; margin-bottom: 6px; flex-shrink: 0; }
  .header-actions { display: flex; gap: 4px; align-items: center; }
  select, button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 8px; cursor: pointer; border-radius: 3px; font-size: 12px; }
  select { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, #444); max-width: 140px; }
  
  #sync-btn { background: #21262d; color: #c9d1d9; font-weight: 500; border: 1px solid #30363d; transition: all 0.2s; }
  #sync-btn:hover { background: #30363d; color: #fff; border-color: #58a6ff; }
  #sync-btn.synced { background: #238636; border-color: #2ea043; color: #fff; }
  
  #chat-container { flex: 1; overflow-y: auto; overflow-x: hidden; display: flex; flex-direction: column; gap: 10px; padding-right: 4px; user-select: text !important; -webkit-user-select: text !important; }
  
  .msg-wrapper { display: flex; flex-direction: column; max-width: 90%; }
  .msg-wrapper.user { align-self: flex-end; }
  .msg-wrapper.agent { align-self: flex-start; width: 100%; max-width: 98%; }
  
  .msg { padding: 9px 12px; border-radius: 6px; font-size: 13px; line-height: 1.5; word-break: break-word; user-select: text !important; -webkit-user-select: text !important; cursor: text; box-shadow: 0 1px 3px rgba(0,0,0,0.2); }
  .user .msg { background: #1e3a5f; color: #ffffff; border: 1px solid #2d5584; }
  .agent .msg { background: #181c24; color: #e1e4e8; border: 1px solid #282e3a; }
  .msg img { max-width: 100%; max-height: 280px; border-radius: 4px; margin-top: 6px; border: 1px solid rgba(255,255,255,0.1); display: block; }
  
  .msg-wrapper.activity { align-self: flex-start; max-width: 95%; margin: 2px 0; }
  .msg-wrapper.activity .msg { background: transparent; padding: 0; border: none; box-shadow: none; }
  
  .activity-chip { display: inline-flex; align-items: center; gap: 6px; background: rgba(0, 122, 204, 0.12); border-left: 3px solid #007acc; padding: 4px 8px; border-radius: 3px; font-size: 11px; margin: 2px 0; color: #9cdcfe; align-self: flex-start; word-break: break-all; }
  .activity-chip p { margin: 0; }
  .activity-chip code { background: rgba(255,255,255,0.08); padding: 1px 4px; border-radius: 3px; font-family: monospace; }

  .system-log-details { background: rgba(255, 255, 255, 0.04); border: 1px solid var(--vscode-panel-border, #333); border-radius: 4px; padding: 4px 8px; font-size: 11px; color: #8b949e; margin: 4px 0; max-width: 100%; }
  .system-log-details summary { cursor: pointer; user-select: none; outline: none; font-weight: 500; }
  .system-log-details summary:hover { color: #58a6ff; }
  .system-log-details pre { max-height: 220px; overflow: auto; margin: 6px 0 0 0; padding: 6px; background: #0d1117; border-radius: 3px; color: #c9d1d9; font-size: 11px; white-space: pre-wrap; word-break: break-all; }

  .ask-box { background: rgba(0, 122, 204, 0.15); border: 1px solid #007acc; border-radius: 6px; padding: 8px 10px; margin: 8px 0; }
  .ask-question { font-weight: bold; margin-bottom: 8px; color: #58a6ff; font-size: 13px; }
  .ask-options { display: flex; flex-wrap: wrap; gap: 6px; }
  .ask-btn { background: #21262d; border: 1px solid #30363d; color: #c9d1d9; padding: 5px 10px; border-radius: 4px; font-size: 12px; cursor: pointer; transition: all 0.2s; }
  .ask-btn:hover { background: #007acc; color: #ffffff; border-color: #007acc; }

  .katex { font-size: 1.05em; color: #f0f6fc; }
  .katex-block { margin: 8px 0; overflow-x: auto; padding: 6px 0; text-align: center; background: rgba(0,0,0,0.2); border-radius: 4px; }

  .code-block { margin: 8px 0; border-radius: 5px; overflow: hidden; background: #0f1117; border: 1px solid #2b313e; }
  .code-header { display: flex; justify-content: space-between; align-items: center; background: #181b24; padding: 4px 8px; font-size: 11px; color: #8b949e; border-bottom: 1px solid #2b313e; }
  .code-actions { display: flex; gap: 6px; }
  .code-btn { background: #212631; border: 1px solid #30363d; color: #c9d1d9; font-size: 11px; cursor: pointer; padding: 2px 6px; border-radius: 3px; }
  .code-btn:hover { background: #30363d; color: #fff; }
  .code-block pre { margin: 0; padding: 10px; overflow-x: auto; font-family: var(--vscode-editor-font-family, Consolas, monospace); font-size: 12px; line-height: 1.5; color: #e6edf3; }

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

  .input-area { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; flex-shrink: 0; border: 1px dashed transparent; border-radius: 4px; transition: border-color 0.2s; }
  .input-area.dragover { border-color: #007acc; }
  
  textarea { background: var(--vscode-input-background, #0d1117); color: var(--vscode-input-foreground, #c9d1d9); border: 1px solid var(--vscode-input-border, #30363d); resize: vertical; min-height: 60px; max-height: 250px; height: 75px; padding: 7px; font-family: inherit; font-size: 13px; border-radius: 4px; }
  textarea:focus { outline: 1px solid #007acc; border-color: #007acc; }
  textarea:disabled { opacity: 0.6; cursor: not-allowed; }
  
  .btn-row { display: flex; gap: 6px; justify-content: flex-end; }
  #cancel-btn { background: #da3633; color: #fff; font-weight: bold; border: 1px solid #f85149; }
  #cancel-btn:hover { background: #f85149; }
</style>
</head>
<body>
<div class="app-layout">
  <div class="header">
    <select id="chat-select"></select>
    <div class="header-actions">
      <button id="sync-btn" title="Синхронизировать новые файлы в проект" style="display:none;">📥 Синхр.</button>
      <button id="new-chat-btn">+ Чат</button>
      <button id="del-chat-btn">Удалить</button>
    </div>
  </div>

  <div id="chat-container"></div>
  
  <div class="status-wrapper">
    <span id="timer-badge" style="display:none; color:#58a6ff; font-weight:bold;">⏱ 0:00</span>
    <span id="status-bar" style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;"></span>
  </div>

  <div class="input-area" id="input-area-box">
    <div id="attachments-bar"></div>
    <textarea id="prompt-input" placeholder="Задача или вопрос... (Enter отправка, Shift+Enter перенос, Ctrl+V вставка картинок)"></textarea>
    <div class="btn-row">
      <button id="attach-file-btn">📎 Файл</button>
      <button id="cancel-btn" style="display:none;">⏹ Отмена</button>
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
  let isReadingFiles = false;

  function startTimer() {
    timerSeconds = 0;
    const badge = document.getElementById('timer-badge');
    badge.style.display = 'inline';
    badge.textContent = '⏱ 0:00';
    
    document.getElementById('prompt-input').disabled = true;
    document.getElementById('send-btn').style.display = 'none';
    document.getElementById('cancel-btn').style.display = 'inline-block';

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
    const cancelBtn = document.getElementById('cancel-btn');
    cancelBtn.style.display = 'none';
    cancelBtn.disabled = false;
    cancelBtn.textContent = '⏹ Отмена';
    document.getElementById('send-btn').style.display = 'inline-block';
    
    const input = document.getElementById('prompt-input');
    input.disabled = false;
    input.focus();
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function setSyncButtonState(unsyncedCount) {
    const syncBtn = document.getElementById('sync-btn');
    syncBtn.classList.remove('synced');
    if (unsyncedCount > 0) {
      syncBtn.style.display = 'inline-block';
      syncBtn.textContent = '📥 Синхр. (' + unsyncedCount + ')';
    } else {
      syncBtn.style.display = 'none';
    }
  }

  document.getElementById('sync-btn').onclick = () => {
    if (!activeChatUid) return;
    const syncBtn = document.getElementById('sync-btn');
    syncBtn.textContent = '⏳ Скачивание...';
    vscode.postMessage({ type: 'manual_sync_files', chatId: activeChatUid });
  };

  document.getElementById('cancel-btn').onclick = () => {
    if (!activeChatUid) return;
    const cancelBtn = document.getElementById('cancel-btn');
    cancelBtn.disabled = true;
    cancelBtn.textContent = '⏳ Отмена...';
    document.getElementById('status-bar').textContent = 'Отмена задачи...';
    vscode.postMessage({ type: 'cancel_task', chatId: activeChatUid });
    setTimeout(() => {
      if (document.getElementById('cancel-btn').style.display !== 'none') {
        stopTimer();
        document.getElementById('status-bar').textContent = 'Задача прервана';
      }
    }, 3000);
  };

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
      const sel = window.getSelection();
      if (sel && sel.toString().trim().length > 0) {
        e.stopPropagation();
        navigator.clipboard.writeText(sel.toString());
      }
    }
  }, true);

  // Пакетная синхронная загрузка фото из буфера обмена (решает баг потери картинок!)
  document.addEventListener('paste', async (e) => {
    const items = (e.clipboardData || window.clipboardData)?.items;
    if (!items) return;

    const imageBlobs = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') !== -1) {
        const blob = items[i].getAsFile();
        if (blob) imageBlobs.push(blob);
      }
    }

    if (imageBlobs.length === 0) return;

    e.preventDefault();
    e.stopPropagation();

    isReadingFiles = true;
    document.getElementById('status-bar').textContent = 'Чтение ' + imageBlobs.length + ' фото из буфера...';

    const timestamp = Date.now();
    const readPromises = imageBlobs.map((blob, idx) => {
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (event) => {
          const dataUrl = event.target.result;
          const base64 = dataUrl.split(',')[1];
          const rand = Math.random().toString(36).slice(2, 6);
          const name = 'screenshot_' + timestamp + '_' + (idx + 1) + '_' + rand + '.png';
          resolve({ type: 'screenshot', name, dataUrl, base64 });
        };
        reader.readAsDataURL(blob);
      });
    });

    try {
      const newPhotos = await Promise.all(readPromises);
      currentAttachments.push(...newPhotos);
      renderAttachments();
      document.getElementById('status-bar').textContent = 'Прикреплено фото: ' + newPhotos.length + ' шт.';
      setTimeout(() => {
        if (!timerInterval) document.getElementById('status-bar').textContent = '';
      }, 2500);
    } finally {
      isReadingFiles = false;
    }
  });

  // Drag & drop картинок прямо в поле ввода
  const dropBox = document.getElementById('input-area-box');
  ['dragenter', 'dragover'].forEach(evt => {
    dropBox.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropBox.classList.add('dragover');
    }, false);
  });
  ['dragleave', 'drop'].forEach(evt => {
    dropBox.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropBox.classList.remove('dragover');
    }, false);
  });
  dropBox.addEventListener('drop', async (e) => {
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;

    const imgFiles = Array.from(files).filter(f => f.type.startsWith('image/'));
    if (imgFiles.length === 0) return;

    isReadingFiles = true;
    document.getElementById('status-bar').textContent = 'Чтение ' + imgFiles.length + ' файлов...';
    const timestamp = Date.now();
    const readPromises = imgFiles.map((f, idx) => {
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (ev) => {
          const dataUrl = ev.target.result;
          const base64 = dataUrl.split(',')[1];
          const rand = Math.random().toString(36).slice(2, 6);
          const name = f.name || ('drop_' + timestamp + '_' + (idx + 1) + '_' + rand + '.png');
          resolve({ type: 'screenshot', name, dataUrl, base64 });
        };
        reader.readAsDataURL(f);
      });
    });

    try {
      const newLoaded = await Promise.all(readPromises);
      currentAttachments.push(...newLoaded);
      renderAttachments();
      document.getElementById('status-bar').textContent = 'Добавлено ' + newLoaded.length + ' фото';
      setTimeout(() => {
        if (!timerInterval) document.getElementById('status-bar').textContent = '';
      }, 2500);
    } finally {
      isReadingFiles = false;
    }
  });

  function renderAttachments() {
    const bar = document.getElementById('attachments-bar');
    bar.innerHTML = '';
    currentAttachments.forEach((att, idx) => {
      const chip = document.createElement('div');
      chip.className = 'attachment-chip';
      if (att.type === 'screenshot' && att.dataUrl) {
        chip.innerHTML = '<img src="' + att.dataUrl + '"> <span>' + escapeHtml(att.name) + '</span>';
      } else {
        const sizeStr = att.size ? ' (' + Math.round(att.size / 1024) + ' КБ)' : '';
        chip.innerHTML = '<span>📄 ' + escapeHtml(att.name) + sizeStr + '</span>';
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

  function answerOption(btn) {
    const answer = decodeURIComponent(btn.getAttribute('data-answer') || '');
    document.getElementById('prompt-input').value = answer;
    send();
  }

  function appendMessageUI(role, content, isHtml = false, rawText = '', isActivity = false) {
    const container = document.getElementById('chat-container');
    const wrapper = document.createElement('div');
    if (isActivity) {
      wrapper.className = 'msg-wrapper activity';
    } else {
      wrapper.className = 'msg-wrapper ' + role;
    }

    const div = document.createElement('div');
    div.className = 'msg';
    if (isHtml) {
      div.innerHTML = content;
    } else {
      div.textContent = content;
    }
    wrapper.appendChild(div);

    if (role === 'agent' && !isActivity) {
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
      appendMessageUI(m.role, m.html || m.text, !!m.html, m.rawText || m.text || '', !!m.isActivity);
    });
  }

  document.getElementById('chat-select').onchange = (e) => {
    activeChatUid = e.target.value;
    document.getElementById('sync-btn').style.display = 'none';
    vscode.postMessage({ type: 'get_chat_history', chat_uid: activeChatUid });
  };

  document.getElementById('new-chat-btn').onclick = () => {
    const newUid = 'chat_' + Date.now();
    document.getElementById('sync-btn').style.display = 'none';
    vscode.postMessage({ type: 'create_chat', chat_uid: newUid, title: 'Новый диалог' });
  };

  document.getElementById('del-chat-btn').onclick = () => {
    if (!activeChatUid) return;
    document.getElementById('sync-btn').style.display = 'none';
    vscode.postMessage({ type: 'delete_chat', chat_uid: activeChatUid });
  };

  function send() {
    if (isReadingFiles) {
      document.getElementById('status-bar').textContent = 'Подождите, фото еще загружаются...';
      return;
    }
    const input = document.getElementById('prompt-input');
    const text = input.value.trim();
    if (!text && currentAttachments.length === 0) return;

    if (!activeChatUid) {
      activeChatUid = 'chat_' + Date.now();
      currentChats.unshift({ chat_uid: activeChatUid, title: text.slice(0, 25) || 'Новый диалог' });
      renderSelect();
    }

    // Сохраняем и очищаем вложения СРАЗУ В МОМЕНТ ОТПРАВКИ
    const payloadAttachments = [...currentAttachments];
    currentAttachments = [];

    let displayHtml = escapeHtml(text).replace(/\\n/g, '<br>');
    if (payloadAttachments.length > 0) {
      const imgsHtml = payloadAttachments.map(a => {
        if (a.type === 'screenshot' && a.dataUrl) {
          return '<br><img src="' + a.dataUrl + '">';
        } else {
          return '<br><span>📄 ' + escapeHtml(a.name) + '</span>';
        }
      }).join('');
      displayHtml += imgsHtml;
    }

    appendMessageUI('user', displayHtml, true);
    input.value = '';
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
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  vscode.postMessage({ type: 'get_chats' });

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
    else if (msg.type === 'files_attached_batch') {
      currentAttachments.push(...msg.files);
      renderAttachments();
    }
    else if (msg.type === 'antigravity_chats_list') {
      currentChats = msg.chats || [];
      if (currentChats.length === 0) {
        const initialUid = 'chat_' + Date.now();
        vscode.postMessage({ type: 'create_chat', chat_uid: initialUid, title: 'Новый диалог' });
        return;
      }
      if (!activeChatUid || !currentChats.find(c => c.chat_uid === activeChatUid)) {
        activeChatUid = currentChats[0].chat_uid;
      }
      renderSelect();
      vscode.postMessage({ type: 'get_chat_history', chat_uid: activeChatUid });
    }
    else if (msg.type === 'antigravity_chat_history') {
      if (msg.chat_uid === activeChatUid) {
        renderMessages(msg.messages || []);
      }
    }
    else if (msg.type === 'sync_button_update') {
      if (msg.chatId === activeChatUid) {
        setSyncButtonState(msg.unsyncedCount);
      }
    }
    else if (msg.type === 'sync_completed') {
      if (msg.chatId === activeChatUid) {
        const syncBtn = document.getElementById('sync-btn');
        syncBtn.classList.add('synced');
        syncBtn.textContent = '✓ Синхронизировано';
        setTimeout(() => {
          syncBtn.style.display = 'none';
          syncBtn.classList.remove('synced');
        }, 3000);
      }
    }
    else if (msg.type === 'antigravity_chat_created') {
      currentChats.unshift(msg.chat);
      activeChatUid = msg.chat.chat_uid;
      renderSelect();
      renderMessages([]);
      document.getElementById('sync-btn').style.display = 'none';
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
      document.getElementById('status-bar').textContent = msg.status || '';
    }
    else if (msg.type === 'activity_log') {
      appendActivityUI(msg.html);
    }
    else if (msg.type === 'antigravity_cancelled') {
      stopTimer();
      document.getElementById('status-bar').textContent = 'Задача прервана пользователем';
    }
    else if (msg.type === 'agent_response') {
      stopTimer();
      document.getElementById('status-bar').textContent = '';
      if (msg.chatId === activeChatUid) {
        appendMessageUI('agent', msg.html, true, msg.rawText);
      }
      vscode.postMessage({ type: 'get_chats' });
    }
    else if (msg.type === 'antigravity_error') {
      stopTimer();
      document.getElementById('status-bar').textContent = msg.error || 'Ошибка';
      appendMessageUI('agent', '❌ Ошибка выполнения задачи: ' + (msg.error || 'Сервер не ответил'));
    }
  });
</script>
</body>
</html>`;
    }
}