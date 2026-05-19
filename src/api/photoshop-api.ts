import { Logger } from '../utils/logger.js';
import { PhotoshopConnection } from '../platform/connection.js';

export type APIType = 'UXP' | 'ExtendScript';

export interface PhotoshopAPI {
  /**
   * Execute a script using the appropriate API
   */
  executeScript(script: string): Promise<unknown>;

  /**
   * Get the API type being used
   */
  getAPIType(): APIType;
}

export class PhotoshopAPIFactory {
  private logger: Logger;
  private connection: PhotoshopConnection;

  constructor(connection: PhotoshopConnection) {
    this.logger = new Logger('PhotoshopAPIFactory');
    this.connection = connection;
  }

  async createAPI(): Promise<PhotoshopAPI> {
    const info = this.connection.getPhotoshopInfo();

    if (!info) {
      throw new Error('Photoshop info not available. Please detect Photoshop first.');
    }

    // Determine which API to use based on version
    const apiType = this.determineAPIType(info.version);

    this.logger.info(`Creating ${apiType} API for Photoshop version ${info.version}`);

    if (apiType === 'UXP') {
      return new UXPPhotoshopAPI(this.connection);
    } else {
      return new ExtendScriptPhotoshopAPI(this.connection);
    }
  }

  private determineAPIType(version: string): APIType {
    // IMPORTANT: When running scripts via AppleScript/COM, we can only use ExtendScript
    // UXP is only available for plugins, not for external script execution
    // Therefore, we always use ExtendScript for external automation

    this.logger.debug(`Using ExtendScript for version ${version} (UXP not available for external scripting)`);
    return 'ExtendScript';
  }
}

/**
 * UXP-based API for modern Photoshop (23.5+)
 * NOTE: UXP is not available for external script execution via AppleScript/COM
 * This class is kept for future plugin-based implementation
 */
class UXPPhotoshopAPI implements PhotoshopAPI {
  private connection: PhotoshopConnection;

  constructor(connection: PhotoshopConnection) {
    this.connection = connection;
  }

  async executeScript(script: string): Promise<unknown> {
    // UXP cannot be executed externally via AppleScript/COM
    // Fall back to ExtendScript
    return await this.connection.executeScript(script);
  }

  getAPIType(): APIType {
    return 'UXP';
  }
}

/**
 * ExtendScript helpers injected into every wrapped script.
 *
 * - __jsonStringify: minimal JSON serializer that escapes all non-ASCII
 *   characters to \uXXXX. This ensures the output file (and any captured
 *   stdout) stays 7-bit ASCII safe regardless of the host shell's
 *   encoding (cscript ANSI/CP936, AppleScript, etc.). Solves Chinese /
 *   non-ASCII garbling.
 *
 * - __safeActiveDoc: defensive accessor for app.activeDocument. Some
 *   operations (especially scripts that create or manipulate documents)
 *   leave activeDocument in a state where reading it throws
 *   "No such element". This helper recovers by reassigning to the last
 *   open document.
 */
const EXTENDSCRIPT_HELPERS = `
function __escStr(s) {
  var out = '';
  var BS = String.fromCharCode(92);
  var QT = String.fromCharCode(34);
  for (var i = 0; i < s.length; i++) {
    var code = s.charCodeAt(i);
    if (code === 92) { out += BS + BS; }
    else if (code === 34) { out += BS + QT; }
    else if (code === 10) { out += BS + 'n'; }
    else if (code === 13) { out += BS + 'r'; }
    else if (code === 9) { out += BS + 't'; }
    else if (code === 8) { out += BS + 'b'; }
    else if (code === 12) { out += BS + 'f'; }
    else if (code < 32 || code > 126) {
      var hex = code.toString(16);
      out += BS + 'u' + ('0000' + hex).slice(-4);
    } else {
      out += s.charAt(i);
    }
  }
  return out;
}
function __jsonStringify(value, depth) {
  if (depth === undefined) depth = 0;
  if (depth > 8) return '"[depth-limit]"';
  if (value === null || value === undefined) return 'null';
  var t = typeof value;
  if (t === 'number') return isFinite(value) ? String(value) : 'null';
  if (t === 'boolean') return String(value);
  if (t === 'string') return '"' + __escStr(value) + '"';
  if (t === 'function') return 'null';
  // Array
  if (value instanceof Array) {
    var arr = [];
    for (var i = 0; i < value.length; i++) {
      try { arr.push(__jsonStringify(value[i], depth + 1)); }
      catch (e) { arr.push('null'); }
    }
    return '[' + arr.join(',') + ']';
  }
  if (t === 'object') {
    // UnitValue -> number (in pixels when possible)
    try {
      if (value.typename === 'UnitValue' || (value.constructor && String(value.constructor).indexOf('UnitValue') !== -1)) {
        try { return String(value.as('px')); }
        catch (e) { return String(value.value); }
      }
    } catch (e) {}
    var pairs = [];
    for (var k in value) {
      try {
        if (typeof value.hasOwnProperty === 'function' && !value.hasOwnProperty(k)) continue;
        var v = __jsonStringify(value[k], depth + 1);
        pairs.push('"' + __escStr(String(k)) + '":' + v);
      } catch (e) {}
    }
    return '{' + pairs.join(',') + '}';
  }
  try { return '"' + __escStr(String(value)) + '"'; }
  catch (e) { return 'null'; }
}
function __safeActiveDoc() {
  if (!app.documents || app.documents.length === 0) return null;
  try {
    var d = app.activeDocument;
    var _verify = d.name; // touch a property to confirm it is alive
    return d;
  } catch (e) {
    try {
      var fallback = app.documents[app.documents.length - 1];
      app.activeDocument = fallback;
      return app.activeDocument;
    } catch (e2) {
      return null;
    }
  }
}
$.global.__safeActiveDoc = __safeActiveDoc;
$.global.__jsonStringify = __jsonStringify;
`;

/**
 * Wrap a user/snippet script in error handling, dialog suppression and
 * JSON serialization. Returns an IIFE expression whose value is a JSON
 * string of the form:
 *
 *   {"ok":true,  "result": ..., "alerts":[...]}
 *   {"ok":false, "error":"...", "alerts":[...]}
 *
 * The platform executor is responsible for taking this expression,
 * writing its value to a UTF-8 output file, and reading it back.
 */
export function wrapScriptForExecution(userScript: string): string {
  return `
(function() {
  ${EXTENDSCRIPT_HELPERS}

  var __alertLog = [];
  var __originalRulerUnits = null;
  var __originalTypeUnits = null;
  var __originalDisplayDialogs = null;
  var __originalAlert = null;
  var __originalConfirm = null;
  var __originalPrompt = null;

  try { __originalRulerUnits = app.preferences.rulerUnits; } catch (e) {}
  try { __originalTypeUnits = app.preferences.typeUnits; } catch (e) {}
  try { __originalDisplayDialogs = app.displayDialogs; } catch (e) {}
  try { __originalAlert = $.global.alert; } catch (e) {}
  try { __originalConfirm = $.global.confirm; } catch (e) {}
  try { __originalPrompt = $.global.prompt; } catch (e) {}

  // Suppress all built-in Photoshop dialogs while running automation.
  try { app.displayDialogs = DialogModes.NO; } catch (e) {}

  // Redirect alert/confirm/prompt so they cannot block automation.
  // Their messages are captured and returned alongside the result.
  try {
    $.global.alert = function (msg) { __alertLog.push(String(msg)); };
  } catch (e) {}
  try {
    $.global.confirm = function (msg) {
      __alertLog.push('CONFIRM: ' + String(msg));
      return true;
    };
  } catch (e) {}
  try {
    $.global.prompt = function (msg, def) {
      __alertLog.push('PROMPT: ' + String(msg));
      return def == null ? '' : def;
    };
  } catch (e) {}

  var __ret;
  try {
    try { app.preferences.rulerUnits = Units.PIXELS; } catch (e) {}
    try { app.preferences.typeUnits = TypeUnits.POINTS; } catch (e) {}

    var __result = (function () {
      ${userScript}
    })();

    __ret = __jsonStringify({
      ok: true,
      result: (typeof __result === 'undefined') ? null : __result,
      alerts: __alertLog
    });
  } catch (__err) {
    var __msg;
    try { __msg = __err && __err.message ? String(__err.message) : String(__err); }
    catch (e) { __msg = 'Unknown error'; }
    var __line = null;
    try { __line = __err && (__err.line != null ? __err.line : null); } catch (e) {}
    __ret = __jsonStringify({
      ok: false,
      error: __msg,
      line: __line,
      alerts: __alertLog
    });
  } finally {
    try { if (__originalRulerUnits !== null) app.preferences.rulerUnits = __originalRulerUnits; } catch (e) {}
    try { if (__originalTypeUnits !== null) app.preferences.typeUnits = __originalTypeUnits; } catch (e) {}
    try { if (__originalDisplayDialogs !== null) app.displayDialogs = __originalDisplayDialogs; } catch (e) {}
    try { if (__originalAlert !== null) $.global.alert = __originalAlert; } catch (e) {}
    try { if (__originalConfirm !== null) $.global.confirm = __originalConfirm; } catch (e) {}
    try { if (__originalPrompt !== null) $.global.prompt = __originalPrompt; } catch (e) {}
  }

  return __ret;
})()
`.trim();
}

/**
 * ExtendScript-based API for legacy Photoshop (< 23.5)
 */
class ExtendScriptPhotoshopAPI implements PhotoshopAPI {
  private connection: PhotoshopConnection;

  constructor(connection: PhotoshopConnection) {
    this.connection = connection;
  }

  async executeScript(script: string): Promise<unknown> {
    const wrappedScript = wrapScriptForExecution(script);
    return await this.connection.executeScript(wrappedScript);
  }

  getAPIType(): APIType {
    return 'ExtendScript';
  }
}
