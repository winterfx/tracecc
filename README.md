# TraceCC - AI API Request Tracer

一个带有像素风复古风格 Web UI 的 HTTP 代理控制器，专为追踪 AI API 请求设计，支持动态配置、请求日志记录和自动生成追踪报告。

## 功能特性

- 🎮 复古像素风格的 Web 界面
- 🔧 动态配置代理目标域名
- 🚫 支持配置不记录的 bypass 路径
- ▶️ 一键启动/停止代理服务
- 📝 自动记录请求/响应到 JSONL 文件
- 📊 自动生成可视化追踪报告（使用 claude-trace）
- 🎨 支持 SSE (Server-Sent Events) 流的解析和记录

## 安装

```bash
npm install
```

## 使用方法

### 启动 Web UI 和管理服务器

```bash
npm start
```

服务器启动后：
- Web UI 地址: http://localhost:3000
- 代理服务地址: http://localhost:8080 (启动代理后可用)

### 使用 Web UI

1. 打开浏览器访问 `http://localhost:3000`
2. 在 "Target Domain" 输入框中填入要代理的目标域名（例如：`https://api.rdsec.trendmicro.com`）
3. 在 "Bypass Paths" 输入框中填入不需要记录的路径，多个路径用逗号分隔（例如：`/health, /metrics`）
4. 点击 **[START]** 按钮启动代理
5. 配置你的应用使用代理地址 `http://localhost:8080`
6. 完成测试后，点击 **[STOP]** 按钮停止代理
7. 系统会自动生成 HTML 追踪报告
8. 点击报告链接即可在浏览器中查看详细的请求追踪信息

### 直接使用代理脚本（旧方式）

如果你想直接使用原始的代理脚本：

```bash
npm run proxy
```

这将启动一个固定配置的代理服务器，监听 8080 端口，转发到 `https://api.rdsec.trendmicro.com`。

## 文件说明

- `server.js` - Web UI 和 API 服务器，支持动态启停代理
- `proxy.js` - 原始的独立代理服务器脚本
- `public/index.html` - 像素风复古风格的 Web 界面
- `generate-html.js` - HTML 报告生成工具（已集成到 server.js）
- `log-*.jsonl` - 请求日志文件（JSONL 格式）
- `log-*.html` - 生成的可视化追踪报告

## 日志格式

每个请求都会以 JSON Lines 格式记录：

```json
{
  "request": {
    "timestamp": 1234567890.123,
    "method": "POST",
    "url": "https://api.example.com/v1/endpoint",
    "headers": {...},
    "body": {...}
  },
  "response": {
    "timestamp": 1234567890.456,
    "status_code": 200,
    "headers": {...},
    "body": {...}
  },
  "logged_at": "2025-10-12T10:30:00.000Z"
}
```

## Bypass 路径

配置的 bypass 路径不会被记录到日志文件中，但仍然会被正常代理。适合用于：
- 健康检查接口
- 心跳接口
- Token 计数接口
- 其他高频低价值的请求

## 技术栈

- Node.js (ES Modules)
- HTTP Proxy (原生 http 模块)
- claude-trace (追踪报告生成)
- 纯 HTML/CSS/JavaScript (无框架的 Web UI)

## 端口说明

- `3000` - Web UI 和 API 服务器
- `8080` - 代理服务器（启动后可用）

## 注意事项

- 代理服务器在点击 START 后才会启动
- 每次启动都会生成新的日志文件
- 生成的 HTML 报告会保存在项目根目录
- 确保安装了 `@anthropic-ai/claude-trace` 包才能生成报告
# tracecc
