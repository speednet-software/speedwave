import * as acorn from 'acorn';
import { ts } from '@speedwave/mcp-shared';

/**
 * Result of addAutoReturn function
 */
export interface AutoReturnResult {
  /** The processed code (with or without auto-return) */
  code: string;
  /** Parse error message if parsing failed, undefined on success */
  parseError?: string;
}

/**
 * Adds implicit 'return' to the last expression if no explicit return exists.
 * @param code - JavaScript code to process.
 */
export function addAutoReturn(code: string): AutoReturnResult {
  const trimmed = code.trim();
  if (!trimmed) return { code };

  try {
    const ast = acorn.parse(trimmed, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    });

    if (ast.body.length === 0) return { code };

    const lastStatement = ast.body[ast.body.length - 1];

    // Jeśli już jest ReturnStatement, nie zmieniaj
    if (lastStatement.type === 'ReturnStatement') {
      return { code };
    }

    // Jeśli ostatni statement to ExpressionStatement, dodaj return
    if (lastStatement.type === 'ExpressionStatement') {
      const start = lastStatement.start;
      const end = lastStatement.end;

      // Usuń trailing semicolon jeśli jest
      let endPos = end;
      if (trimmed[end - 1] === ';') {
        endPos = end - 1;
      }

      return { code: trimmed.slice(0, start) + 'return ' + trimmed.slice(start, endPos) };
    }

    // Inne typy (VariableDeclaration, IfStatement, etc.) - nie dodawaj return
    return { code };
  } catch (error) {
    /* c8 ignore next — acorn always throws Error instances; the String() fallback is defensive */
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.warn(`${ts()} [auto-return] Failed to parse code: ${errorMsg}`);
    console.warn(
      `${ts()} [auto-return] Original code (first 200 chars): ${code.substring(0, 200)}`
    );
    return { code, parseError: errorMsg };
  }
}
