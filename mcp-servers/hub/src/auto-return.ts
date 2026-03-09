import * as acorn from 'acorn';
import { ts } from '../../shared/dist/index.js';

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
 * Dodaje 'return' do ostatniego wyrażenia w kodzie, jeśli nie ma explicit return.
 * Używa AST parsera dla 100% poprawności.
 *
 * Parser configuration:
 * - sourceType: 'script' - allows parsing without ES module restrictions
 * - allowAwaitOutsideFunction: true - allows top-level await
 * - allowReturnOutsideFunction: true - allows top-level return
 *
 * Note: ES module syntax (import/export statements) will cause parse errors.
 * This is intentional - the code is executed inside an AsyncFunction wrapper,
 * where static ES module syntax is not supported anyway.
 * @param code - JavaScript code to process
 * @returns Result with code and optional parse error
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
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.warn(`${ts()} [auto-return] Failed to parse code: ${errorMsg}`);
    console.warn(
      `${ts()} [auto-return] Original code (first 200 chars): ${code.substring(0, 200)}`
    );
    return { code, parseError: errorMsg };
  }
}
