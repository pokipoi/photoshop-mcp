import { tmpdir } from 'os';
import { join } from 'path';
import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import { PhotoshopConnection } from '../platform/connection.js';
import { PhotoshopAPIFactory } from '../api/photoshop-api.js';
import { ExtendScriptSnippets } from '../api/extendscript.js';

export function createImageTools(connection: PhotoshopConnection): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'photoshop_resize_image',
        description: 'Resize the active image to specified dimensions',
        inputSchema: {
          type: 'object',
          properties: {
            width: {
              type: 'number',
              description: 'New width in pixels',
              minimum: 1,
            },
            height: {
              type: 'number',
              description: 'New height in pixels',
              minimum: 1,
            },
          },
          required: ['width', 'height'],
        },
      },
      handler: async (args) => resizeImage(connection, args),
    },
    {
      tool: {
        name: 'photoshop_crop_document',
        description: 'Crop the document to specified bounds',
        inputSchema: {
          type: 'object',
          properties: {
            left: {
              type: 'number',
              description: 'Left edge position in pixels',
              minimum: 0,
            },
            top: {
              type: 'number',
              description: 'Top edge position in pixels',
              minimum: 0,
            },
            right: {
              type: 'number',
              description: 'Right edge position in pixels',
              minimum: 1,
            },
            bottom: {
              type: 'number',
              description: 'Bottom edge position in pixels',
              minimum: 1,
            },
          },
          required: ['left', 'top', 'right', 'bottom'],
        },
      },
      handler: async (args) => cropDocument(connection, args),
    },
    {
      tool: {
        name: 'photoshop_capture_canvas',
        description:
          'Capture the active document canvas as a low-quality JPEG snapshot and return the saved file path. The original document is NOT modified - a flattened duplicate is used internally and discarded. Useful for letting an AI vision model see the current canvas state.',
        inputSchema: {
          type: 'object',
          properties: {
            outputPath: {
              type: 'string',
              description:
                'Optional absolute path for the JPEG output (must end with .jpg or .jpeg). If omitted, a file is auto-generated in the OS temp directory.',
            },
            quality: {
              type: 'number',
              description:
                'JPEG quality on Photoshop scale 0-12 (0=lowest/smallest, 12=highest). Default: 3 (low).',
              minimum: 0,
              maximum: 12,
              default: 3,
            },
            maxDimension: {
              type: 'number',
              description:
                'If > 0, downscale so the longest side does not exceed this many pixels. Aspect ratio is preserved. Default: 1280 (good balance for vision models). Set to 0 to keep original size.',
              minimum: 0,
              default: 1280,
            },
          },
        },
      },
      handler: async (args) => captureCanvas(connection, args),
    },
  ];
}

async function resizeImage(
  connection: PhotoshopConnection,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const width = args.width as number;
  const height = args.height as number;

  try {
    const apiFactory = new PhotoshopAPIFactory(connection);
    const api = await apiFactory.createAPI();

    const script = ExtendScriptSnippets.resizeImage(width, height);
    await api.executeScript(script);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Image resized to ${width}x${height}px`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error resizing image: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

async function cropDocument(
  connection: PhotoshopConnection,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const left = args.left as number;
  const top = args.top as number;
  const right = args.right as number;
  const bottom = args.bottom as number;

  try {
    const apiFactory = new PhotoshopAPIFactory(connection);
    const api = await apiFactory.createAPI();

    const script = ExtendScriptSnippets.cropDocument(left, top, right, bottom);
    const result = await api.executeScript(script);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Document cropped\nResult: ${JSON.stringify(result)}`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error cropping document: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

async function captureCanvas(
  connection: PhotoshopConnection,
  args: Record<string, unknown>
): Promise<ToolResult> {
  // Resolve output path: prefer user-supplied, else auto-generate one in
  // the OS temp directory with a timestamp + random suffix to avoid
  // collisions on rapid sequential calls.
  let outputPath = (args.outputPath as string | undefined)?.trim();
  if (!outputPath) {
    const fileName = `photoshop-canvas-${Date.now()}-${Math.floor(Math.random() * 1e6)}.jpg`;
    outputPath = join(tmpdir(), fileName);
  } else if (!/\.(jpe?g)$/i.test(outputPath)) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error capturing canvas: outputPath must end with .jpg or .jpeg, got "${outputPath}"`,
        },
      ],
      isError: true,
    };
  }

  // Clamp parameters into valid ranges.
  const rawQuality = args.quality;
  const quality =
    typeof rawQuality === 'number' && Number.isFinite(rawQuality)
      ? Math.max(0, Math.min(12, Math.round(rawQuality)))
      : 3;

  const rawMax = args.maxDimension;
  const maxDimension =
    typeof rawMax === 'number' && Number.isFinite(rawMax) && rawMax >= 0
      ? Math.floor(rawMax)
      : 1280;

  try {
    const apiFactory = new PhotoshopAPIFactory(connection);
    const api = await apiFactory.createAPI();

    const script = ExtendScriptSnippets.captureCanvas(outputPath, quality, maxDimension);
    const result = await api.executeScript(script);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Canvas captured: ${outputPath}\n${JSON.stringify(result, null, 2)}`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error capturing canvas: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}
