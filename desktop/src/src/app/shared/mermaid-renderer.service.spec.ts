import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { Mermaid } from 'mermaid';
import { ThemeService, type EffectiveMode, type ThemeId } from '../services/theme.service';
import { createDeferred } from '../testing/deferred';
import { createFakeMermaid, fakeMermaidLoader, type FakeMermaid } from '../testing/fake-mermaid';
import {
  MERMAID_LOADER,
  MermaidRendererService,
  type DiagramEntry,
} from './mermaid-renderer.service';

describe('MermaidRendererService', () => {
  let mermaid: FakeMermaid;
  let theme: { theme: WritableSignal<ThemeId>; effectiveMode: WritableSignal<EffectiveMode> };
  let loader: () => Promise<Mermaid>;

  function create(): MermaidRendererService {
    TestBed.configureTestingModule({
      providers: [
        { provide: ThemeService, useValue: theme },
        { provide: MERMAID_LOADER, useValue: () => loader() },
      ],
    });
    return TestBed.inject(MermaidRendererService);
  }

  async function settled(service: MermaidRendererService, source: string): Promise<DiagramEntry> {
    await vi.waitFor(() => {
      if (!service.lookup(source)) throw new Error(`still rendering: ${source}`);
    });
    return service.lookup(source) as DiagramEntry;
  }

  beforeEach(() => {
    mermaid = createFakeMermaid();
    theme = { theme: signal<ThemeId>('ember'), effectiveMode: signal<EffectiveMode>('dark') };
    loader = fakeMermaidLoader(mermaid);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.querySelectorAll('.mermaid-measure').forEach((host) => host.remove());
    document.documentElement.removeAttribute('style');
  });

  it('renders a source once and serves the cached entry afterwards', async () => {
    const service = create();
    expect(service.lookup('graph TD')).toBeNull();
    const entry = await settled(service, 'graph TD');
    expect(entry.kind).toBe('ready');
    expect(entry.kind === 'ready' && entry.svg.querySelector('text')?.textContent).toBe('graph TD');
    expect(service.lookup('graph TD')).toBe(entry);
    expect(mermaid.render).toHaveBeenCalledTimes(1);
  });

  it('bumps version after each settled render', async () => {
    const service = create();
    const before = service.version();
    await settled(service, 'graph A');
    expect(service.version()).toBe(before + 1);
    await settled(service, 'graph B');
    expect(service.version()).toBe(before + 2);
  });

  it('queues a pending source once', async () => {
    const service = create();
    service.lookup('graph TD');
    service.lookup('graph TD');
    await settled(service, 'graph TD');
    expect(mermaid.render).toHaveBeenCalledTimes(1);
  });

  it('marks a source that does not parse as failed, without rendering or logging', async () => {
    const error = vi.spyOn(console, 'error');
    const warn = vi.spyOn(console, 'warn');
    const service = create();
    expect(await settled(service, 'invalid graph')).toEqual({ kind: 'failed' });
    expect(mermaid.render).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('marks a render that throws as failed without logging', async () => {
    const error = vi.spyOn(console, 'error');
    mermaid.render.mockRejectedValueOnce(new Error('layout failed'));
    const service = create();
    expect(await settled(service, 'graph TD')).toEqual({ kind: 'failed' });
    expect(error).not.toHaveBeenCalled();
  });

  it('marks markup that is not a single svg as failed', async () => {
    mermaid.render.mockResolvedValueOnce({ svg: '<div>not a diagram</div>' });
    const service = create();
    expect(await settled(service, 'graph TD')).toEqual({ kind: 'failed' });
  });

  it('renders a source at the text limit and fails a longer one without parsing it', async () => {
    const atLimit = 'graph TD\n'.padEnd(50_000, 'x');
    const service = create();
    expect((await settled(service, atLimit)).kind).toBe('ready');
    expect(await settled(service, `${atLimit}x`)).toEqual({ kind: 'failed' });
    expect(mermaid.parse).toHaveBeenCalledTimes(1);
    expect(mermaid.render).toHaveBeenCalledTimes(1);
  });

  it('never retries a failed source', async () => {
    const service = create();
    await settled(service, 'invalid graph');
    expect(service.lookup('invalid graph')).toEqual({ kind: 'failed' });
    expect(mermaid.parse).toHaveBeenCalledTimes(1);
  });

  it('marks every diagram failed when mermaid cannot be loaded', async () => {
    loader = () => Promise.reject(new Error('chunk load failed'));
    const service = create();
    expect(await settled(service, 'graph A')).toEqual({ kind: 'failed' });
    expect(await settled(service, 'graph B')).toEqual({ kind: 'failed' });
  });

  it('renders one diagram at a time', async () => {
    const first = createDeferred<{ svg: string }>();
    mermaid.render.mockReturnValueOnce(first.promise);
    const service = create();
    service.lookup('graph A');
    service.lookup('graph B');
    await vi.waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mermaid.render).toHaveBeenCalledTimes(1);
    first.resolve({ svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' });
    await settled(service, 'graph B');
    expect(mermaid.render.mock.calls.map((call) => call[1])).toEqual(['graph A', 'graph B']);
  });

  it('gives every render its own id', async () => {
    const service = create();
    await settled(service, 'graph A');
    await settled(service, 'graph B');
    const [first, second] = mermaid.render.mock.calls.map((call) => call[0] as string);
    expect(first).toMatch(/^mermaid-diagram-\d+$/);
    expect(second).not.toBe(first);
  });

  it('initializes mermaid once per mode with the locked-down config', async () => {
    const root = document.documentElement.style;
    root.setProperty('--bg', '#123456');
    root.setProperty('--ink', '#abcdef');
    root.setProperty('--font-sans', 'Test Sans, sans-serif');
    const service = create();
    await settled(service, 'graph A');
    await settled(service, 'graph B');
    expect(mermaid.initialize).toHaveBeenCalledTimes(1);
    const config = mermaid.initialize.mock.calls[0][0];
    expect(config).toMatchObject({
      startOnLoad: false,
      securityLevel: 'strict',
      htmlLabels: false,
      suppressErrorRendering: true,
      logLevel: 'fatal',
      maxTextSize: 50_000,
      layout: 'dagre',
      theme: 'base',
      darkMode: true,
      fontFamily: 'Test Sans, sans-serif',
      themeVariables: { background: '#123456', textColor: '#abcdef' },
    });
    expect(config.themeCSS).toBe('.edgeLabel .label rect.background{opacity:1;fill:#123456}');
    expect(config.secure).toEqual(
      expect.arrayContaining([
        'secure',
        'securityLevel',
        'maxTextSize',
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
      ])
    );
  });

  it('renders again for a new mode and re-initializes with it', async () => {
    const service = create();
    const dark = await settled(service, 'graph TD');
    theme.effectiveMode.set('light');
    expect(service.lookup('graph TD')).toBeNull();
    const light = await settled(service, 'graph TD');
    expect(light).not.toBe(dark);
    expect(mermaid.initialize).toHaveBeenCalledTimes(2);
    expect(mermaid.initialize.mock.calls[1][0].darkMode).toBe(false);
  });

  it('keeps the rendered diagram through an accent change', async () => {
    const service = create();
    const entry = await settled(service, 'graph TD');
    theme.theme.set('mint');
    expect(service.lookup('graph TD')).toBe(entry);
    expect(mermaid.render).toHaveBeenCalledTimes(1);
    expect(mermaid.initialize).toHaveBeenCalledTimes(1);
  });

  it('drops renders queued or running for a mode that is no longer current', async () => {
    const first = createDeferred<{ svg: string }>();
    mermaid.render.mockReturnValueOnce(first.promise);
    const service = create();
    service.lookup('graph A');
    service.lookup('graph B');
    await vi.waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(1));
    theme.effectiveMode.set('light');
    first.resolve({ svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mermaid.render).toHaveBeenCalledTimes(1);
    expect(service.version()).toBe(0);
    await settled(service, 'graph B');
    expect(mermaid.render).toHaveBeenCalledTimes(2);
  });

  it('measures in a hidden host on the body and empties it after every render', async () => {
    mermaid.render.mockImplementationOnce(async (_id: string, _text: string, host: Element) => {
      host.appendChild(document.createElement('div'));
      throw new Error('layout failed');
    });
    const service = create();
    expect(await settled(service, 'graph A')).toEqual({ kind: 'failed' });
    const host = mermaid.render.mock.calls[0][2] as HTMLElement;
    expect(host.childElementCount).toBe(0);
    await settled(service, 'graph B');
    expect(mermaid.render.mock.calls[1][2]).toBe(host);
    expect(host.classList.contains('mermaid-measure')).toBe(true);
    expect(host.getAttribute('aria-hidden')).toBe('true');
    expect(host.isConnected).toBe(true);
    expect(host.childElementCount).toBe(0);
  });
});
