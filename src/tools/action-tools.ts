import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import { PhotoshopConnection } from '../platform/connection.js';
import { PhotoshopAPIFactory } from '../api/photoshop-api.js';
import { ExtendScriptSnippets } from '../api/extendscript.js';

export function createActionTools(connection: PhotoshopConnection): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'photoshop_play_action',
        description: 'Play a recorded action from the Actions palette',
        inputSchema: {
          type: 'object',
          properties: {
            actionName: {
              type: 'string',
              description: 'Name of the action to play',
            },
            actionSetName: {
              type: 'string',
              description: 'Name of the action set containing the action',
            },
          },
          required: ['actionName', 'actionSetName'],
        },
      },
      handler: async (args) => playAction(connection, args),
    },
    {
      tool: {
        name: 'photoshop_execute_script',
        description:
          'Execute custom ExtendScript (JSX) code inside Photoshop (advanced escape hatch).\n\n' +
          'Use when: no existing tool covers the operation and you can write safe JSX.\n' +
          'Do NOT use when: a recipe or atomic tool exists — prefer photoshop_recipe_* or photoshop_* tools.\n\n' +
          'Returns: script return value serialized as text/JSON. To capture a return value, use an explicit `return` statement at the top level of your code (e.g. `return { foo: app.activeDocument.name };`). Without a return, the result will be null. alert()/confirm()/prompt() are intercepted automatically and their messages are surfaced via tool logs instead of blocking the script. The active document is accessed safely - use `__safeActiveDoc()` if you need a robust handle.\n' +
          'Preconditions: valid ExtendScript; active document if script expects one. Side effects: depends on code.',
        inputSchema: {
          type: 'object',
          properties: {
            code: {
              type: 'string',
              description:
                'ExtendScript code to execute. Use `return value` to send a result back to the caller.',
            },
          },
          required: ['code'],
        },
      },
      handler: async (args) => executeCustomScript(connection, args),
    },
  ];
}

async function playAction(
  connection: PhotoshopConnection,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const actionName = args.actionName as string;
  const actionSetName = args.actionSetName as string;

  try {
    const apiFactory = new PhotoshopAPIFactory(connection);
    const api = await apiFactory.createAPI();

    const script = ExtendScriptSnippets.playAction(actionName, actionSetName);
    await api.executeScript(script);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Action played: "${actionName}" from set "${actionSetName}"`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error playing action: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

async function executeCustomScript(
  connection: PhotoshopConnection,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const code = args.code as string;

  try {
    const apiFactory = new PhotoshopAPIFactory(connection);
    const api = await apiFactory.createAPI();

    const script = ExtendScriptSnippets.executeCustomScript(code);
    const result = await api.executeScript(script);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Custom script executed\nResult: ${JSON.stringify(result)}`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error executing custom script: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}
