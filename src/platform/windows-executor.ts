import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { writeFile, unlink, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Logger } from '../utils/logger.js';
import { ScriptExecutor } from './script-executor.js';

const execAsync = promisify(exec);

/**
 * UTF-8 BOM. Prepended to JSX files so ExtendScript ($.evalFile) decodes
 * source containing non-ASCII characters (e.g. Chinese layer names) as
 * UTF-8 instead of falling back to the system code page.
 */
const UTF8_BOM = '\uFEFF';

/**
 * Wrap an API-produced expression so that its string value is written
 * to a UTF-8 output file. The expression must evaluate to a string
 * (typically a JSON document produced by `wrapScriptForExecution`).
 *
 * The wrapper is intentionally tolerant: if anything goes wrong while
 * writing the file, an "ERROR:" line is echoed to stdout and the
 * outer executor falls back to parsing stdout.
 */
function buildFileOutputWrapper(apiWrappedExpr: string, outputPath: string): string {
  const escapedPath = outputPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `
(function () {
  var __mcpResult;
  try {
    __mcpResult = ${apiWrappedExpr};
  } catch (e) {
    __mcpResult = '{"ok":false,"error":"wrapper failure: ' + String(e.message || e).replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"') + '"}';
  }
  try {
    var __mcpFile = new File("${escapedPath}");
    __mcpFile.encoding = "UTF-8";
    __mcpFile.lineFeed = "Unix";
    if (__mcpFile.open("w")) {
      __mcpFile.write(String(__mcpResult));
      __mcpFile.close();
      return "OK";
    }
    return "ERROR: failed to open output file";
  } catch (e) {
    return "ERROR: " + String(e.message || e);
  }
})();
`.trim();
}

interface ParsedScriptResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  line?: number | null;
  alerts?: string[];
}

export class WindowsExecutor implements ScriptExecutor {
  private logger: Logger;
  private scriptQueue: Array<() => Promise<unknown>> = [];
  private isProcessing = false;

  constructor() {
    this.logger = new Logger('WindowsExecutor');
  }

  async execute(script: string, timeout: number = 30000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error('Script execution timeout'));
      }, timeout);

      this.scriptQueue.push(async () => {
        try {
          const result = await this.executeScript(script, timeout);
          clearTimeout(timeoutId);
          resolve(result);
          return result;
        } catch (error) {
          clearTimeout(timeoutId);
          reject(error);
          throw error;
        }
      });

      this.processQueue();
    });
  }

  private async processQueue() {
    if (this.isProcessing || this.scriptQueue.length === 0) {
      return;
    }

    this.isProcessing = true;

    while (this.scriptQueue.length > 0) {
      const task = this.scriptQueue.shift();
      if (task) {
        try {
          await task();
        } catch (error) {
          this.logger.error('Script execution failed:', error);
        }
      }
    }

    this.isProcessing = false;
  }

  private async executeScript(script: string, timeout: number): Promise<unknown> {
    const ts = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const tempScriptPath = join(tmpdir(), `photoshop-script-${ts}.jsx`);
    const outputPath = join(tmpdir(), `photoshop-output-${ts}.json`);
    const vbsPath = join(tmpdir(), `photoshop-vbs-${ts}.vbs`);

    // Wrap the API-wrapped script with file-output logic. The script is
    // expected to be a single IIFE expression that yields a string; if
    // that's not the case we still try, falling back to whatever it
    // returns.
    const apiExpr = script.trim().replace(/;$/, '');
    const fullScript = buildFileOutputWrapper(apiExpr, outputPath);

    try {
      // Prepend UTF-8 BOM so ExtendScript correctly decodes non-ASCII
      // characters embedded in the JSX source.
      await writeFile(tempScriptPath, UTF8_BOM + fullScript, 'utf8');

      // VBScript wrapper invokes Photoshop via COM and runs the JSX file.
      const vbsScript = this.createVBSWrapper(tempScriptPath);
      await writeFile(vbsPath, vbsScript, 'utf8');

      try {
        const { stdout, stderr } = await execAsync(`cscript //nologo "${vbsPath}"`, {
          timeout: timeout > 0 ? timeout : undefined,
          maxBuffer: 16 * 1024 * 1024,
        });

        if (stderr) {
          this.logger.warn('Script execution stderr:', stderr);
        }

        // Primary path: read the JSON output the script wrote to disk.
        let fileContent: string | null = null;
        try {
          fileContent = await readFile(outputPath, 'utf8');
        } catch {
          fileContent = null;
        }

        if (fileContent && fileContent.length > 0) {
          return this.parseFileResult(fileContent);
        }

        // Fallback to stdout (legacy / wrapper-failure path).
        return this.parseStdoutFallback(stdout);
      } finally {
        await unlink(vbsPath).catch(() => {});
        await unlink(outputPath).catch(() => {});
      }
    } finally {
      await unlink(tempScriptPath).catch(() => {});
    }
  }

  private createVBSWrapper(jsxPath: string): string {
    const escaped = jsxPath.replace(/\\/g, '\\\\');
    return `
On Error Resume Next
Dim photoshopApp
Set photoshopApp = CreateObject("Photoshop.Application")

If Err.Number <> 0 Then
    WScript.Echo "ERROR: Failed to connect to Photoshop - " & Err.Description
    WScript.Quit 1
End If

' Suppress UI dialogs while the script runs (defense in depth).
photoshopApp.DisplayDialogs = 3 ' psDisplayNoDialogs

Dim result
result = photoshopApp.DoJavaScript("$.evalFile(File('${escaped}'))")

If Err.Number <> 0 Then
    WScript.Echo "ERROR: " & Err.Description
    WScript.Quit 1
Else
    If IsNull(result) Or IsEmpty(result) Then
        WScript.Echo "OK"
    Else
        WScript.Echo result
    End If
End If
`.trim();
  }

  private parseFileResult(content: string): unknown {
    let trimmed = content.trim();
    if (trimmed.length === 0) {
      throw new Error('Empty result file');
    }
    // Strip BOM if any
    if (trimmed.charCodeAt(0) === 0xfeff) {
      trimmed = trimmed.slice(1);
    }

    let parsed: ParsedScriptResult;
    try {
      parsed = JSON.parse(trimmed) as ParsedScriptResult;
    } catch (err) {
      // Not JSON: treat the raw text as result
      this.logger.debug('Output file was not JSON, returning raw text');
      return trimmed;
    }

    if (parsed.alerts && parsed.alerts.length > 0) {
      this.logger.warn('Script produced alerts:', parsed.alerts);
    }

    if (parsed.ok === false) {
      const message = parsed.error || 'Script execution failed';
      const lineSuffix = parsed.line != null ? ` (line ${parsed.line})` : '';
      throw new Error(`${message}${lineSuffix}`);
    }

    return parsed.result;
  }

  private parseStdoutFallback(output: string): unknown {
    const trimmed = output.trim();

    if (trimmed.length === 0) {
      throw new Error('Script produced no output');
    }

    if (trimmed.startsWith('ERROR:')) {
      throw new Error(trimmed.substring(6).trim());
    }

    if (trimmed === 'OK') {
      return null;
    }

    try {
      const parsed = JSON.parse(trimmed) as ParsedScriptResult;
      if (parsed && typeof parsed === 'object' && 'ok' in parsed) {
        if (parsed.ok === false) {
          throw new Error(parsed.error || 'Script execution failed');
        }
        return parsed.result;
      }
      return parsed;
    } catch {
      return trimmed;
    }
  }

  async isPhotoshopRunning(): Promise<boolean> {
    try {
      const { stdout } = await execAsync('tasklist /FI "IMAGENAME eq Photoshop.exe"');
      return stdout.toLowerCase().includes('photoshop.exe');
    } catch (error) {
      return false;
    }
  }

  async launchPhotoshop(photoshopPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.logger.info(`Launching Photoshop: ${photoshopPath}`);

      const child = spawn(photoshopPath, [], {
        detached: true,
        stdio: 'ignore',
      });

      child.unref();

      // Wait a bit for Photoshop to start
      setTimeout(() => {
        resolve();
      }, 5000);

      child.on('error', (error) => {
        reject(new Error(`Failed to launch Photoshop: ${error.message}`));
      });
    });
  }
}
