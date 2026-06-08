const http = require('http');
const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = Number(process.env.PORT || 6312);
const TEMP_DIR = path.join(__dirname, 'tmp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

let browserProcess = null;

function ps(script) {
  return execSync(script, { shell: 'powershell', encoding: 'utf-8', timeout: 30000 }).trim();
}

function psJson(script) {
  const out = ps(script);
  return out ? JSON.parse(out) : null;
}

function escapePsString(str) {
  return str.replace(/'/g, "''");
}

function buildScreenshotPs(tmpPath) {
  return `
    Add-Type -AssemblyName System.Windows.Forms,System.Drawing;
    $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds;
    $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height;
    $g=[System.Drawing.Graphics]::FromImage($bmp);
    $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size);
    $g.Dispose();
    $bmp.Save('${escapePsString(tmpPath)}',[System.Drawing.Imaging.ImageFormat]::Png);
    $bmp.Dispose();
  `;
}

const tools = {

  async screenshot() {
    const tmp = path.join(TEMP_DIR, `screenshot_${Date.now()}.png`);
    ps(buildScreenshotPs(tmp));
    const buf = fs.readFileSync(tmp);
    fs.unlinkSync(tmp);
    return { base64: buf.toString('base64') };
  },

  async mouseMove(x, y) {
    ps(`[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${Number(x)},${Number(y)})`);
    return { x: Number(x), y: Number(y) };
  },

  async mouseClick(button, x, y) {
    if (x != null && y != null) await tools.mouseMove(x, y);
    const btn = button === 'right' ? 'Right' : 'Left';
    ps(`
      Add-Type -AssemblyName System.Windows.Forms;
      $sig = @"
[DllImport("user32.dll")]public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, int dwExtraInfo);
"@;
      $type = Add-Type -MemberDefinition $sig -Name "mouse" -Namespace "win32" -PassThru;
      $MOUSEEVENTF_${btn}DOWN = 0x0002;
      $MOUSEEVENTF_${btn}UP = 0x0004;
      $type::mouse_event($MOUSEEVENTF_${btn}DOWN, 0, 0, 0, 0);
      $type::mouse_event($MOUSEEVENTF_${btn}UP, 0, 0, 0, 0);
    `);
    return { clicked: button || 'left', at: { x: x ?? null, y: y ?? null } };
  },

  async mouseDoubleClick(x, y) {
    if (x != null && y != null) await tools.mouseMove(x, y);
    await tools.mouseClick('left');
    await tools.mouseClick('left');
    return { doubleClicked: true };
  },

  async mouseRightClick(x, y) {
    return tools.mouseClick('right', x, y);
  },

  async cursorPosition() {
    const result = psJson(`[System.Windows.Forms.Cursor]::Position | ConvertTo-Json`);
    return result ? { x: result.X, y: result.Y } : { x: 0, y: 0 };
  },

  async screenSize() {
    const result = psJson(`
      $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds;
      @{width=$b.Width;height=$b.Height} | ConvertTo-Json
    `);
    return result || { width: 1920, height: 1080 };
  },

  async typeText(text) {
    const escaped = escapePsString(text);
    ps(`
      Add-Type -AssemblyName System.Windows.Forms;
      [System.Windows.Forms.SendKeys]::SendWait('${escaped}')
    `);
    return { typed: text.length };
  },

  async keyPress(key) {
    const map = {
      'enter':'{ENTER}','tab':'{TAB}','escape':'{ESC}','esc':'{ESC}',
      'backspace':'{BACKSPACE}','delete':'{DELETE}','home':'{HOME}',
      'end':'{END}','up':'{UP}','down':'{DOWN}','left':'{LEFT}','right':'{RIGHT}',
      'space':' ','pageup':'{PGUP}','pagedown':'{PGDN}'
    };
    const lower = key.toLowerCase();
    let send = map[lower] || key;
    if (/^ctrl/i.test(key) || /^control/i.test(key)) {
      const parts = key.split('+');
      send = '^' + parts.slice(1).join('+');
    } else if (/^alt/i.test(key)) {
      const parts = key.split('+');
      send = '%' + parts.slice(1).join('+');
    } else if (/^shift/i.test(key)) {
      const parts = key.split('+');
      send = '+' + parts.slice(1).join('+');
    }
    ps(`
      Add-Type -AssemblyName System.Windows.Forms;
      [System.Windows.Forms.SendKeys]::SendWait('${escapePsString(send)}')
    `);
    return { key: send };
  },

  async listWindows() {
    const raw = ps(`
      Add-Type @"
        using System;using System.Runtime.InteropServices;using System.Text;
        public class WinAPI {
          [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
          [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder t, int c);
          [DllImport("user32.dll")] public static extern int EnumWindows(EnumWindowsProc p, IntPtr l);
          public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
          [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
          [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
        }
"@
      $w=New-Object System.Collections.ArrayList;
      [WinAPI]::EnumWindows({param($h,$l)
        if([WinAPI]::IsWindowVisible($h)){
          $s=New-Object System.Text.StringBuilder 256;
          [WinAPI]::GetWindowText($h,$s,256);$t=$s.ToString();
          if($t-ne""){
            $p=0;[WinAPI]::GetWindowThreadProcessId($h,[ref]$p);
            $pr=(Get-Process -Id $p -ErrorAction SilentlyContinue);
            $null=$w.Add(@{handle=$h.ToString();title=$t;processId=$p;processName=if($pr){$pr.ProcessName}else{"unknown"};isForeground=([WinAPI]::GetForegroundWindow()-$eq$h)})
          }
        };return $true},0);
      $w|ConvertTo-Json -AsArray
    `);
    try { return JSON.parse(raw); } catch { return []; }
  },

  async focusWindow(title) {
    ps(`
      Add-Type @"
        using System;using System.Runtime.InteropServices;using System.Text;
        public class W {
          [DllImport("user32.dll")] public static extern int EnumWindows(EnumWindowsProc p, IntPtr l);
          public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
          [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
          [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder t, int c);
          [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
          [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
        }
"@
      [W]::EnumWindows({param($h,$l)
        if([W]::IsWindowVisible($h)){
          $s=New-Object System.Text.StringBuilder 256;
          [W]::GetWindowText($h,$s,256);
          if($s.ToString()-like"*${escapePsString(title)}*"){[W]::ShowWindow($h,9)|Out-Null;[W]::SetForegroundWindow($h)|Out-Null;return $false}
        };return $true},0)
    `);
    return { focused: title };
  },

  async launchApp(appPath, args) {
    const a = args ? `-ArgumentList '${escapePsString(args)}'` : '';
    ps(`Start-Process '${escapePsString(appPath)}' ${a}`);
    return { launched: appPath };
  },

  async openBrowser(url) {
    if (browserProcess) { try { browserProcess.kill(); } catch {} }
    const { chromium } = require('playwright');
    browserProcess = await chromium.launch({ headless: false, args: ['--start-maximized', '--app=' + (url||'https://www.google.com')] });
    return { opened: url||'https://www.google.com', pid: browserProcess.process().pid };
  },

  async closeBrowser() {
    if (browserProcess) { try { browserProcess.kill(); } catch {} browserProcess = null; }
    return { closed: true };
  },

  async getClipboard() {
    const text = ps('Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.Clipboard]::GetText()');
    return { text };
  },

  async setClipboard(text) {
    ps("Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.Clipboard]::SetText('" + escapePsString(text) + "')");
    return { set: text.length };
  }
};

function jsonResponse(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

async function handleRequest(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST,GET,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }
  if (req.method === 'GET' && req.url === '/health') return jsonResponse(res, 200, { status: 'ok', port: PORT });
  if (req.method !== 'POST') return jsonResponse(res, 405, { error: 'Method not allowed' });

  let body = '';
  req.on('data', c => body += c);
  req.on('end', async () => {
    let params = {};
    try { params = body ? JSON.parse(body) : {}; } catch {}
    try {
      let result;
      const u = req.url;
      if (u === '/computer/screenshot') result = await tools.screenshot();
      else if (u === '/computer/mouse/move') result = await tools.mouseMove(params.x, params.y);
      else if (u === '/computer/mouse/click') result = await tools.mouseClick(params.button, params.x, params.y);
      else if (u === '/computer/mouse/double-click') result = await tools.mouseDoubleClick(params.x, params.y);
      else if (u === '/computer/mouse/right-click') result = await tools.mouseRightClick(params.x, params.y);
      else if (u === '/computer/mouse/position') result = await tools.cursorPosition();
      else if (u === '/computer/screen-size') result = await tools.screenSize();
      else if (u === '/computer/type') result = await tools.typeText(params.text);
      else if (u === '/computer/key') result = await tools.keyPress(params.key);
      else if (u === '/computer/windows') result = await tools.listWindows();
      else if (u === '/computer/window/focus') result = await tools.focusWindow(params.title);
      else if (u === '/computer/launch') result = await tools.launchApp(params.path, params.args);
      else if (u === '/computer/browser/open') result = await tools.openBrowser(params.url);
      else if (u === '/computer/browser/close') result = await tools.closeBrowser();
      else if (u === '/computer/clipboard') result = await tools.getClipboard();
      else if (u === '/computer/clipboard/set') result = await tools.setClipboard(params.text);
      else return jsonResponse(res, 404, { error: 'Unknown endpoint: ' + u });
      jsonResponse(res, 200, result);
    } catch (e) {
      jsonResponse(res, 500, { error: e.message });
    }
  });
}

const server = http.createServer(handleRequest);
server.listen(PORT, () => {
  console.log('[host-agent] Listening on http://localhost:' + PORT);
  console.log('[host-agent] Proxy connect: http://host.docker.internal:' + PORT);
});

process.on('SIGTERM', () => {
  if (browserProcess) { try { browserProcess.kill(); } catch {} }
  server.close();
  process.exit(0);
});
