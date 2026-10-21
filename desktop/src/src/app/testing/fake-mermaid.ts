import { vi } from 'vitest';
import type { Mermaid } from 'mermaid';

/** Mocked mermaid API: a source containing `invalid` fails to parse, any other renders as one `<svg>`. */
export interface FakeMermaid {
  initialize: ReturnType<typeof vi.fn>;
  parse: ReturnType<typeof vi.fn>;
  render: ReturnType<typeof vi.fn>;
}

/**
 * Creates a {@link FakeMermaid} whose render leaves a child in the host it is given, as mermaid does.
 * @returns The fake, with every method a spy.
 */
export function createFakeMermaid(): FakeMermaid {
  return {
    initialize: vi.fn(),
    parse: vi.fn(async (text: string) =>
      text.includes('invalid') ? false : { diagramType: 'flowchart' }
    ),
    render: vi.fn(async (id: string, text: string, host?: Element) => {
      host?.appendChild(document.createElement('div'));
      const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return {
        svg: `<svg id="${id}" xmlns="http://www.w3.org/2000/svg"><text>${escaped}</text></svg>`,
      };
    }),
  };
}

/**
 * A `MERMAID_LOADER` value that hands out the fake.
 * @param mermaid - The fake to load.
 * @returns A loader resolving to `mermaid`.
 */
export function fakeMermaidLoader(mermaid: FakeMermaid): () => Promise<Mermaid> {
  return () => Promise.resolve(mermaid as unknown as Mermaid);
}
