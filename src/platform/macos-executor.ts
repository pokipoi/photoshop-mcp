import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { writeFile, unlink, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Logger } from '../utils/logger.js';
import { parseExtendScriptPayload } from '../utils/extendscript-result.js';
import { ScriptExecutor } from './script-executor.js';

const execAsync = promisify(exec);

const UTF8_BOM = '\uFEFF';

interface ParsedScriptResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  line?: number | null;
  alerts?: string[];
}

/**
 * Wrap an API-produced expression so its string result is written to a
 * UTF-8 output file. See windows-executor.ts for the rationale.
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

export class MacOSExecutor implements ScriptExecutor {
  private logger: Logger;
  private scriptQueue: Array<() => Promise<unknown>> = [];
  private isProcessing = false;
  private appName: string = 'Adobe Photoshop 2025';

  constructor() {
    this.logger = new Logger('MacOSExecutor');
  }

  setAppName(appName: string): void {
    this.appName = appName;
    this.logger.debug(`App name set to: ${appName}`);
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
    const tempAppleScriptPath = join(tmpdir(), `photoshop-applescript-${ts}.scpt`);

    const apiExpr = script.trim().replace(/;$/, '');
    const fullScript = buildFileOutputWrapper(apiExpr, outputPath);

    try {
      await writeFile(tempScriptPath, UTF8_BOM + fullScript, 'utf8');

      const appleScript = this.createAppleScriptWrapper(tempScriptPath);
      await writeFile(tempAppleScriptPath, appleScript, 'utf8');

      try {
        const { stdout, stderr } = await execAsync(`osascript "${tempAppleScriptPath}"`, {
          timeout: timeout > 0 ? timeout : undefined,
          maxBuffer: 16 * 1024 * 1024,
        });

        if (stderr) {
          this.logger.warn('Script execution stderr:', stderr);
        }

        // Primary: read JSON output file
        let fileContent: string | null = null;
        try {
          fileContent = await readFile(outputPath, 'utf8');
        } catch {
          fileContent = null;
        }

        if (fileContent && fileContent.length > 0) {
          return this.parseFileResult(fileContent);
        }

        // Fallback: stdout
        return this.parseStdoutFallback(stdout);
      } catch (error) {
        this.logger.error('AppleScript execution failed:', error);
        throw error;
      } finally {
        await unlink(tempAppleScriptPath).catch(() => {});
        await unlink(outputPath).catch(() => {});
      }
    } finally {
      await unlink(tempScriptPath).catch(() => {});
    }
  }

  private createAppleScriptWrapper(jsxPath: string): string {
    const posixPath = jsxPath.replace(/\\/g, '/');

    return `tell application "${this.appName}"
\tactivate
\tdo javascript "$.evalFile(decodeURI('${encodeURI(posixPath)}'))"
end tell`;
  }

  private parseFileResult(content: string): unknown {
    let trimmed = content.trim();
    if (trimmed.length === 0) {
      throw new Error('Empty result file');
    }
    if (trimmed.charCodeAt(0) === 0xfeff) {
      trimmed = trimmed.slice(1);
    }

    let parsed: ParsedScriptResult;
    try {
      parsed = JSON.parse(trimmed) as ParsedScriptResult;
    } catch {
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

    return parseExtendScriptPayload(trimmed);
  }

  async isPhotoshopRunning(): Promise<boolean> {
    try {
      const { stdout } = await execAsync('pgrep -f "Adobe Photoshop"');
      return stdout.trim().length > 0;
    } catch (error) {
      // pgrep returns non-zero exit code if no process found
      return false;
    }
  }

  async launchPhotoshop(photoshopPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.logger.info(`Launching Photoshop: ${photoshopPath}`);

      const child = spawn('open', ['-a', photoshopPath], {
        detached: true,
        stdio: 'ignore',
      });

      child.unref();

      setTimeout(() => {
        resolve();
      }, 5000);

      child.on('error', (error) => {
        reject(new Error(`Failed to launch Photoshop: ${error.message}`));
      });
    });
  }
}
