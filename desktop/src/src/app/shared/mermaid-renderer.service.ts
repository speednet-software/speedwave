import { Injectable, InjectionToken, inject, signal } from '@angular/core';
import type { Mermaid, MermaidConfig } from 'mermaid';
import { ThemeService, type EffectiveMode } from '../services/theme.service';
import { LruCache } from './lru-cache';
import { sanitizeDiagramSvg } from './diagram-svg';

/** A settled render: the sanitized SVG to copy into a slot, or a failure that leaves the code block. */
export type DiagramEntry =
  { readonly kind: 'ready'; readonly svg: SVGSVGElement } | { readonly kind: 'failed' };

export const MERMAID_LOADER = new InjectionToken<() => Promise<Mermaid>>('MERMAID_LOADER', {
  providedIn: 'root',
  factory: () => () => import('mermaid').then((module) => module.default),
});

const DIAGRAM_CACHE_SIZE = 100;
const MAX_TEXT_SIZE = 50_000;
const FAILED: DiagramEntry = { kind: 'failed' };
const SECURE_KEYS = [
  'secure',
  'securityLevel',
  'startOnLoad',
  'maxTextSize',
  'suppressErrorRendering',
  'maxEdges',
  'theme',
  'themeVariables',
  'themeCSS',
  'fontFamily',
  'altFontFamily',
  'darkMode',
  'htmlLabels',
  'dompurifyConfig',
  'layout',
  'logLevel',
];

/** Renders mermaid sources one at a time for the current light or dark mode and caches the sanitized SVG. */
@Injectable({ providedIn: 'root' })
export class MermaidRendererService {
  private readonly theme = inject(ThemeService);
  private readonly loadMermaid = inject(MERMAID_LOADER);
  private readonly cache = new LruCache<string, DiagramEntry>(DIAGRAM_CACHE_SIZE);
  private readonly queue: { key: string; source: string }[] = [];
  private readonly queued = new Set<string>();
  private readonly versionSignal = signal(0);
  private mermaid: Promise<Mermaid> | null = null;
  private configuredFor: EffectiveMode | null = null;
  private measureHost: HTMLElement | null = null;
  private draining = false;
  private renders = 0;

  readonly version = this.versionSignal.asReadonly();

  /**
   * Returns the settled render of `source` for the current mode, queueing a render on a miss.
   * @param source - Mermaid diagram source.
   * @returns The settled entry, or `null` while the diagram is queued or rendering.
   */
  lookup(source: string): DiagramEntry | null {
    const key = this.keyFor(source);
    const entry = this.cache.get(key);
    if (entry) return entry;
    this.enqueue(key, source);
    return null;
  }

  private keyFor(source: string): string {
    return `${this.theme.effectiveMode()}\u0000${source}`;
  }

  private enqueue(key: string, source: string): void {
    if (this.queued.has(key)) return;
    this.queued.add(key);
    this.queue.push({ key, source });
    if (this.draining) return;
    this.draining = true;
    queueMicrotask(() => void this.drain());
  }

  private async drain(): Promise<void> {
    try {
      for (let job = this.queue.shift(); job; job = this.queue.shift()) {
        if (job.key === this.keyFor(job.source)) {
          const entry = await this.render(job.source);
          if (job.key === this.keyFor(job.source)) {
            this.cache.set(job.key, entry);
            this.versionSignal.update((n) => n + 1);
          }
        }
        this.queued.delete(job.key);
      }
    } finally {
      this.draining = false;
    }
  }

  private async render(source: string): Promise<DiagramEntry> {
    if (source.length > MAX_TEXT_SIZE) return FAILED;
    const host = this.measurementHost();
    try {
      const mermaid = await this.configured();
      if (!(await mermaid.parse(source, { suppressErrors: true }))) return FAILED;
      const { svg } = await mermaid.render(`mermaid-diagram-${++this.renders}`, source, host);
      const root = sanitizeDiagramSvg(svg);
      return root ? { kind: 'ready', svg: root } : FAILED;
    } catch {
      return FAILED;
    } finally {
      host.replaceChildren();
    }
  }

  private measurementHost(): HTMLElement {
    if (!this.measureHost?.isConnected) {
      this.measureHost = document.createElement('div');
      this.measureHost.className = 'mermaid-measure';
      this.measureHost.setAttribute('aria-hidden', 'true');
      document.body.appendChild(this.measureHost);
    }
    return this.measureHost;
  }

  private async configured(): Promise<Mermaid> {
    this.mermaid ??= this.loadMermaid();
    const mermaid = await this.mermaid;
    const mode = this.theme.effectiveMode();
    if (this.configuredFor !== mode) {
      await document.fonts?.ready;
      mermaid.initialize(diagramConfig(mode));
      this.configuredFor = mode;
    }
    return mermaid;
  }
}

function diagramConfig(mode: EffectiveMode): MermaidConfig {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string): string => style.getPropertyValue(name).trim();
  const fontFamily = read('--font-sans');
  const background = read('--bg');
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    htmlLabels: false,
    suppressErrorRendering: true,
    logLevel: 'fatal',
    secure: SECURE_KEYS,
    maxTextSize: MAX_TEXT_SIZE,
    layout: 'dagre',
    theme: 'base',
    themeCSS: `.edgeLabel .label rect.background{opacity:1;fill:${background}}`,
    darkMode: mode === 'dark',
    fontFamily,
    themeVariables: {
      darkMode: mode === 'dark',
      fontFamily,
      background,
      primaryColor: read('--bg-2'),
      primaryTextColor: read('--ink'),
      primaryBorderColor: read('--line-strong'),
      secondaryColor: read('--bg-3'),
      tertiaryColor: read('--bg-1'),
      lineColor: read('--ink-mute'),
      textColor: read('--ink'),
    },
  };
}
