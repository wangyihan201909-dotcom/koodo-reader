# Koodo 科研工作区

桌面版直接进入本地书库，本地阅读和科研工作区无需 Koodo 账号或试用。打开侧栏的 **研究工作区** 开始检索。在 EPUB 中划词后，从原有划词菜单打开 **AI 科研**，可以提问、解释选区或检索来源。保存回答会生成包含问题、正文、概念和出处的研究笔记，可在保存时选择主题。已保存笔记中的书籍引用可返回当时的阅读位置。

工作区支持把 Koodo 书库里的书籍和论文加入主题。在笔记里点 **推荐关联**，可以检查 AI 建议的关联和理由，点 **确认关联** 后，两条笔记都能看到这条链接。

## 1. 安装本地服务与 Qwen 模型

在仓库根目录运行以下命令。Windows 示例使用 PowerShell 7、Node.js 22 或更新版本，以及 Python 3.13。

```powershell
uv venv --python 3.13 .venv
uv pip install -r research_agent/requirements.txt
uv pip install 'torch>=2.8' --index https://download.pytorch.org/whl/cpu
uv pip install -r research_agent/reranker-requirements.txt
uvx --from huggingface_hub hf download Qwen/Qwen3-Reranker-0.6B config.json generation_config.json model.safetensors tokenizer.json tokenizer_config.json vocab.json merges.txt
```

权重下载一次后，服务从 Hugging Face 本机缓存读取。也可以将 `KOODO_RERANKER_MODEL_DIR` 指向已有的完整模型目录。CPU 精排在第一次搜索时加载模型，之后复用内存中的模型。

## 2. 让 SAG-Wiki 索引书籍、论文和笔记

已有 SAG-Wiki 0.4.0 或兼容版本时，可以在其桌面版中添加目录并开启 HTTP API。也可用官方 CLI。下面的 `D:\资料\科研文献` 是示例，换成存放 EPUB、PDF 或 Markdown 的实际目录。

```powershell
npm install -g @zleap-ai/sag@0.4.0
$researchData = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.koodo-research'
$researchNotes = Join-Path $researchData 'notes'
New-Item -ItemType Directory -Force -Path $researchNotes
sag add $researchNotes --types md
sag add 'D:\资料\科研文献' --types epub,pdf,md,txt
sag api start --host 127.0.0.1 --port 24681
sag api key create --name koodo-research
```

书籍可保留在原文件夹。只把书加入主题会建立书库引用。跨文献检索覆盖你在 SAG-Wiki 添加并在下节指定的目录，以及工作区导出的笔记目录。扫描版 PDF 的覆盖范围取决于 SAG-Wiki 的 OCR 和索引状态。SAG 返回的 PDF 行号对应转换后的文本。

## 3. 配置并启动

在运行研究服务的终端设置环境变量。把示例地址和模型名换成自己的 OpenAI 兼容服务，粘贴 Key 时用 `Read-Host -MaskInput`。

```powershell
$env:KOODO_MODEL_BASE_URL = 'http://127.0.0.1:11434/v1'
$env:KOODO_MODEL_NAME = '你的回答模型名称'
# 回答服务需要鉴权时启用下一行。
# $env:KOODO_MODEL_API_KEY = Read-Host '回答模型 API Key' -MaskInput
$env:KOODO_SAG_API_KEY = Read-Host 'SAG-Wiki HTTP API Key' -MaskInput
$env:KOODO_SAG_PATHS = 'D:\资料\科研文献'
# 要启用联网搜索时启用下一行。
# $env:KOODO_BRAVE_API_KEY = Read-Host 'Brave Search API Key' -MaskInput
.\.venv\Scripts\python.exe -m research_agent
```

SAG-Wiki HTTP API 默认地址为 `http://127.0.0.1:24681/v1`。可用 `KOODO_SAG_BASE_URL` 指向另一端口。多个文献目录在 Windows 用分号连接，在 macOS 和 Linux 用冒号连接。

另开一个终端启动 Koodo 桌面开发版。

```powershell
npx.cmd -y yarn@1.22.22 install --frozen-lockfile
npx.cmd -y yarn@1.22.22 dev
```

如果 Windows 在安装依赖时因缺少 Visual Studio 而卡在原有的 `better-sqlite3` 重编译步骤，可使用该依赖自带的预编译模块，并单独完成 Electron 下载。

```powershell
npx.cmd -y yarn@1.22.22 install --frozen-lockfile --ignore-scripts
node node_modules/electron/install.js
node scripts/patch-nan.js
npx.cmd -y yarn@1.22.22 dev
```

在工作区点 **检查服务** 可查看配置。**只检索来源** 可独立使用本地检索和精排。**向 AI 提问** 和 **推荐关联** 需要回答模型。选择联网时将查询发送给 Brave。使用 AI 回答时将问题和引用摘录发送给配置的回答模型，关联推荐会将参与比对的笔记摘录发送给该模型。把回答模型地址设为本机服务即可让回答也在本机运行。

## 本地检索与数据

- **快速检索** 使用 SAG-Wiki 的本地全文索引，返回最多 8 个原始段落。
- **本地语义精排** 先通过 SAG-Wiki 快速搜索召回最多 24 个段落，再用本机 Qwen3-Reranker-0.6B 对查询与候选段落评分，返回最多 8 个段落。召回范围由 SAG 的索引和查询匹配决定。
- 笔记、引用、主题和关联存放于 `~/.koodo-research/knowledge.sqlite3`。每条笔记同时导出 Markdown 到 `~/.koodo-research/notes`，供 SAG-Wiki 检索。若设置 `KOODO_RESEARCH_DATA_DIR`，在两个终端都设为同一绝对目录，并把其中的 `notes` 子目录加入 SAG-Wiki。
- EPUB 书内引用记录选区原文、章节和 Koodo 阅读位置。SAG 引用记录文件和转换文本行号，网页引用保留链接和当时的摘录。

相关文档见 [SAG-Wiki HTTP API](https://github.com/Zleap-AI/SAG-Wiki/blob/main/docs/en/cli-http-api.md)、[Qwen 官方模型卡](https://huggingface.co/Qwen/Qwen3-Reranker-0.6B)和 [Brave Search API](https://api-dashboard.search.brave.com/app/documentation/web-search/get-started)。
